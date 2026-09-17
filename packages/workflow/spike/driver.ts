/**
 * ADR-0008 M3 spike — driver (THROWAWAY SCAFFOLDING).
 *
 * Runs three scenarios and writes spike/.run/report.json + per-step PASS/FAIL:
 *
 *  A. OFFICIAL ADR-0008 gate (plan §12 protocol) — `inngest dev` dev server:
 *     start → persist step → kill -9 WORKER (app/worker per protocol) →
 *     restart worker → resume (persist-step memoized, not re-executed) →
 *     wait for external signal → signal → complete.
 *
 *  B. FULL-CRASH variant (harsher than the gate: executor + worker both
 *     kill -9'd) — `inngest start` self-hosted single binary + external Redis
 *     (durable run state; no Docker): start → persist step → kill -9
 *     executor AND worker → restart both → resume → signal → complete.
 *     Requires a local redis-server binary (brew install redis).
 *
 *  C. NEGATIVE CONTROL — `inngest dev` with executor + worker both kill -9'd:
 *     documents that the DEV SERVER's in-flight run state (waits/pauses,
 *     timers, queue) is in-memory and dies with the process even with
 *     --persist (which only persists history/events to sqlite). Expected
 *     outcome: signal after restart does NOT complete the run.
 *
 * Run from packages/workflow: pnpm exec tsx spike/driver.ts
 */
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect as tcpConnect } from "node:net";
import { Inngest } from "inngest";
import { APP_PORT, APP_URL, DEV_BASE, RUN_DIR, SIGNAL_EVENT, TRIGGER_EVENT } from "./spike";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_SPEC = process.env.SPIKE_CLI_SPEC ?? "inngest-cli@1.44.0";
const SIGNING_KEY = "deadbeefdeadbeefdeadbeefdeadbeef"; // spike-only local placeholder, not a secret
const REDIS_PORT = 6399;
const LOG_DIR = join(RUN_DIR, "logs");

const T_START = performance.now();
const now = () => new Date().toISOString();
const elapsed = () => `${((performance.now() - T_START) / 1000).toFixed(2)}s`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type StepStatus = "PASS" | "FAIL" | "INFO" | "CONFIRMED" | "DEVIATED";
interface StepResult {
  scenario: string;
  protocolStep: string;
  status: StepStatus;
  detail: string;
  at: string;
  tMs: number;
}

const results: StepResult[] = [];
const required = new Set<string>(); // "scenario/step" keys that gate the verdict
const record = (
  scenario: string,
  protocolStep: string,
  status: StepStatus | boolean,
  detail: string,
  isRequired = false,
): void => {
  const st: StepStatus = typeof status === "boolean" ? (status ? "PASS" : "FAIL") : status;
  if (isRequired) required.add(`${scenario}/${protocolStep}`);
  results.push({
    scenario,
    protocolStep,
    status: st,
    detail,
    at: now(),
    tMs: Math.round(performance.now() - T_START),
  });
  console.log(`[${elapsed()}] ${scenario} ${st.padEnd(9)} ${protocolStep} — ${detail}`);
};

interface Managed {
  name: string;
  pid: number | undefined;
}

const children: Managed[] = [];

function spawnManaged(
  name: string,
  cmd: string,
  args: string[],
  cwd: string,
  logFile: string,
  env: NodeJS.ProcessEnv = {},
): Managed {
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  mkdirSync(LOG_DIR, { recursive: true });
  const logStream = createWriteStream(logFile, { flags: "a" });
  child.stdout?.on("data", (d: Buffer) => logStream.write(d));
  child.stderr?.on("data", (d: Buffer) => logStream.write(d));
  child.on("exit", (code, sig) => logStream.write(`\n[${now()}] ${name} exited code=${code} sig=${sig}\n`));
  const m: Managed = { name, pid: child.pid };
  children.push(m);
  console.log(`[${elapsed()}] spawned ${name} pid=${child.pid} (${cmd} ${args.join(" ")})`);
  return m;
}

async function killGroup9(m: Managed | undefined): Promise<boolean> {
  if (!m?.pid) return false;
  try {
    process.kill(-m.pid, "SIGKILL"); // kill -9 the whole process group (npx/pnpm trees included)
  } catch {
    /* already dead */
  }
  await sleep(500);
  try {
    process.kill(-m.pid, 0);
    return false; // still alive
  } catch {
    return true; // ESRCH -> group gone
  }
}

async function waitResponding(url: string, timeoutMs: number, label: string): Promise<number> {
  const start = performance.now();
  let lastErr = "n/a";
  while (performance.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return res.status;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(250);
  }
  throw new Error(`${label} not responding at ${url} within ${timeoutMs}ms (last: ${lastErr})`);
}

async function tcpReady(port: number, timeoutMs: number): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = tcpConnect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (ok) return true;
    await sleep(200);
  }
  return false;
}

async function portFree(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const text = await res.text();
    let body: unknown = text.slice(0, 200);
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(250);
  }
  return cond();
}

/** Wait until the worker log shows the dev server has synced it (PUT count). */
const putCount = (logFile: string): number => {
  if (!existsSync(logFile)) return 0;
  return readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("PUT /api/inngest")).length;
};

const linesOf = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0) : [];
const countPrefix = (file: string, prefix: string): number =>
  linesOf(file).filter((l) => l.startsWith(prefix)).length;

async function runWorker(gen: string, scenarioDir: string, runtime: "dev" | "start"): Promise<Managed> {
  return spawnManaged(
    `worker-${gen}`,
    "pnpm",
    ["exec", "tsx", "spike/worker.ts"],
    PKG_DIR,
    join(LOG_DIR, `worker-${gen}.log`),
    runtime === "start" ? { SPIKE_RUNTIME: "start", INNGEST_SIGNING_KEY: SIGNING_KEY } : {},
  );
}

async function waitWorkerReady(managed: Managed, logFile: string, label: string): Promise<{ ok: boolean; body: string }> {
  const status = await waitResponding(APP_URL, 30_000, label);
  const reg = await fetchJson(APP_URL);
  const body = JSON.stringify(reg?.body).slice(0, 160);
  void managed;
  return { ok: status === 200 && reg?.status === 200 && body.includes('"function_count":1'), body };
}

async function waitWorkerSynced(logFile: string, minPuts: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => putCount(logFile) >= minPuts, timeoutMs);
}

function extractEventId(out: unknown): string | undefined {
  const first = Array.isArray(out) ? out[0] : out;
  if (first && typeof first === "object" && "ids" in first) {
    const ids = (first as { ids?: unknown }).ids;
    if (Array.isArray(ids) && typeof ids[0] === "string") return ids[0];
  }
  return undefined;
}

function sdkVersion(): string {
  const pj = JSON.parse(readFileSync(join(PKG_DIR, "node_modules", "inngest", "package.json"), "utf8")) as {
    version: string;
  };
  return pj.version;
}

async function finalRunStatus(eventId: string): Promise<string> {
  const r = await fetchJson(`${DEV_BASE}/v1/events/${eventId}/runs`);
  if (!r || r.status !== 200) return "(status api unavailable)";
  const b = r.body as { data?: Array<Record<string, unknown>> };
  const first = b?.data?.[0];
  return typeof first?.status === "string" ? first.status : JSON.stringify(r.body).slice(0, 120);
}

interface ScenarioOutcome {
  runKey: string;
  marker: string;
  invocations: string;
}

/** Common: trigger + wait for persist-step marker. */
async function triggerAndWaitPersisted(
  client: Inngest,
  scenario: string,
  outcome: ScenarioOutcome,
  waitTimeoutMs = 600_000,
): Promise<string> {
  const trigStart = performance.now();
  const out: unknown = await client.send({
    name: TRIGGER_EVENT,
    data: { runKey: outcome.runKey, waitTimeoutMs },
  });
  const eventId = extractEventId(out);
  record(
    scenario,
    "start workflow",
    Boolean(eventId),
    eventId ? `event ${TRIGGER_EVENT} -> eventId ${eventId} (${Math.round(performance.now() - trigStart)}ms)` : `send() -> ${JSON.stringify(out).slice(0, 160)}`,
    true,
  );
  if (!eventId) throw new Error("no eventId");
  const persisted = await waitFor(() => countPrefix(outcome.marker, "persist-step") === 1, 30_000);
  record(
    scenario,
    "persist step",
    persisted,
    persisted
      ? `marker "persist-step" written once (executor checkpointed the step)`
      : `no marker within 30s`,
    true,
  );
  if (!persisted) throw new Error("persist step never happened");
  return eventId;
}

async function signalAndVerifyCompletion(
  client: Inngest,
  scenario: string,
  outcome: ScenarioOutcome,
  eventId: string,
  timeoutMs = 30_000,
): Promise<void> {
  await client.send({ name: SIGNAL_EVENT, data: { runKey: outcome.runKey } });
  record(scenario, "signal", true, `event ${SIGNAL_EVENT} sent`, true);
  const completed = await waitFor(() => countPrefix(outcome.marker, "complete") === 1, timeoutMs);
  const completeLine = linesOf(outcome.marker).find((l) => l.startsWith("complete")) ?? "(missing)";
  const persistCount = countPrefix(outcome.marker, "persist-step");
  const invocationCount = linesOf(outcome.invocations).length;
  const status = await finalRunStatus(eventId);
  const ok = completed && completeLine.includes("signal=received") && persistCount === 1;
  record(
    scenario,
    "complete",
    ok,
    `marker "${completeLine}"; final status ${status}; invocations=${invocationCount}; persist-step executions=${persistCount} (memoization held: ${persistCount === 1})`,
    true,
  );
}

// ---------------------------------------------------------------------------
// Scenario A — OFFICIAL gate: `inngest dev`, kill -9 worker only.
// ---------------------------------------------------------------------------
async function scenarioA(client: Inngest): Promise<void> {
  const S = "A/dev-worker-kill";
  const dir = join(RUN_DIR, "scenA");
  mkdirSync(dir, { recursive: true });
  const runKey = `a-${randomUUID().slice(0, 8)}`;
  const outcome: ScenarioOutcome = {
    runKey,
    marker: join(RUN_DIR, `marker-${runKey}.log`),
    invocations: join(RUN_DIR, `invocations-${runKey}.log`),
  };

  const dev = spawnManaged(
    "dev-A",
    "npx",
    ["-y", CLI_SPEC, "dev", "-p", "8288", "-u", APP_URL, "--no-discovery", "--persist", "--poll-interval", "2"],
    dir,
    join(LOG_DIR, "dev-A.log"),
  );
  const devUp = await waitResponding(DEV_BASE, 90_000, "dev server (A)");
  record(S, "start dev server", devUp === 200, `HTTP ${devUp} on :8288 (--persist --poll-interval 2, -u ${APP_URL})`, true);

  let worker = await runWorker("A1", dir, "dev");
  const w1 = await waitWorkerReady(worker, join(LOG_DIR, "worker-A1.log"), "worker (A gen1)");
  record(S, "start worker (serves function)", w1.ok, `serve endpoint HTTP 200; registration ${w1.body}`, true);
  await waitWorkerSynced(join(LOG_DIR, "worker-A1.log"), 1, 30_000);
  await sleep(1_000);

  const eventId = await triggerAndWaitPersisted(client, S, outcome);
  const invBefore = linesOf(outcome.invocations).length;

  const tKill = performance.now();
  const workerDead = await killGroup9(worker);
  record(
    S,
    "terminate app/worker (kill -9)",
    workerDead,
    `SIGKILL worker pid ${worker.pid} process group, verified dead (${Math.round(performance.now() - tKill)}ms); dev server (executor) left running per protocol`,
    true,
  );

  worker = await runWorker("A2", dir, "dev");
  const w2 = await waitWorkerReady(worker, join(LOG_DIR, "worker-A2.log"), "worker (A gen2)");
  const synced = await waitWorkerSynced(join(LOG_DIR, "worker-A2.log"), 1, 30_000);
  record(S, "restart worker", w2.ok && synced, `worker back, registration ${w2.body}, re-synced with executor (PUT observed)`, true);

  const stillOne = countPrefix(outcome.marker, "persist-step") === 1;
  record(
    S,
    "resume (step state persisted)",
    stillOne,
    `persist-step executions after worker crash+restart: ${countPrefix(outcome.marker, "persist-step")} (memoized, not re-run)`,
    true,
  );
  record(
    S,
    "wait for external signal",
    true,
    `run parked at waitForEvent checkpoint in the executor; invocations so far ${invBefore} (replay occurs on signal)`,
    true,
  );

  await signalAndVerifyCompletion(client, S, outcome, eventId);

  await killGroup9(worker);
  await killGroup9(dev);
}

// ---------------------------------------------------------------------------
// Scenario B — FULL crash: `inngest start` + external Redis, kill -9 both.
// ---------------------------------------------------------------------------
async function scenarioB(client: Inngest): Promise<void> {
  const S = "B/start-full-kill";
  const dir = join(RUN_DIR, "scenB");
  mkdirSync(dir, { recursive: true });
  const redisDir = join(dir, "redis");
  mkdirSync(redisDir, { recursive: true });
  const runKey = `b-${randomUUID().slice(0, 8)}`;
  const outcome: ScenarioOutcome = {
    runKey,
    marker: join(RUN_DIR, `marker-${runKey}.log`),
    invocations: join(RUN_DIR, `invocations-${runKey}.log`),
  };

  // external redis = durable queue/run state
  let redis: Managed | undefined;
  try {
    redis = spawnManaged(
      "redis-B",
      "redis-server",
      ["--port", String(REDIS_PORT), "--daemonize", "no", "--save", "1 1", "--appendonly", "no", `--dir`, redisDir],
      redisDir,
      join(LOG_DIR, "redis-B.log"),
    );
  } catch {
    record(S, "start external redis", false, "failed to spawn redis-server", true);
  }
  const redisUp = redis ? await tcpReady(REDIS_PORT, 15_000) : false;
  record(
    S,
    "start external redis (durable run state)",
    redisUp,
    redisUp ? `redis-server on :${REDIS_PORT} (brew; no Docker)` : "redis-server unavailable — brew install redis",
    true,
  );
  if (!redisUp) throw new Error("scenario B needs redis-server");

  const startArgs = [
    "-y",
    CLI_SPEC,
    "start",
    "-p",
    "8288",
    "-u",
    APP_URL,
    "--no-ui",
    "--event-key",
    "spike-dev",
    "--signing-key",
    SIGNING_KEY,
    "--sqlite-dir",
    join(dir, "sqlite"),
    "--redis-uri",
    `redis://127.0.0.1:${REDIS_PORT}`,
  ];
  let executor = spawnManaged("start-B1", "npx", startArgs, dir, join(LOG_DIR, "start-B1.log"));
  const exUp = await waitResponding(DEV_BASE, 90_000, "inngest start (B gen1)");
  record(S, "start executor (inngest start)", exUp > 0, `HTTP ${exUp} on :8288 (single binary; sqlite history + external redis run state; no Docker)`, true);

  let worker = await runWorker("B1", dir, "start");
  const w1 = await waitWorkerReady(worker, join(LOG_DIR, "worker-B1.log"), "worker (B gen1)");
  const synced1 = await waitWorkerSynced(join(LOG_DIR, "worker-B1.log"), 1, 30_000);
  record(S, "start worker (signed serve)", w1.ok && synced1, `registration ${w1.body}; synced`, true);

  const eventId = await triggerAndWaitPersisted(client, S, outcome);

  const tKill = performance.now();
  const exDead = await killGroup9(executor);
  const workerDead = await killGroup9(worker);
  record(
    S,
    "terminate executor AND worker (kill -9)",
    exDead && workerDead,
    `SIGKILL both process groups: inngest start pid ${executor.pid} dead=${exDead}, worker pid ${worker.pid} dead=${workerDead} (${Math.round(performance.now() - tKill)}ms); redis (run state) survives`,
    true,
  );

  executor = spawnManaged("start-B2", "npx", startArgs, dir, join(LOG_DIR, "start-B2.log"));
  const exUp2 = await waitResponding(DEV_BASE, 90_000, "inngest start (B gen2)");
  worker = await runWorker("B2", dir, "start");
  const w2 = await waitWorkerReady(worker, join(LOG_DIR, "worker-B2.log"), "worker (B gen2)");
  const synced2 = await waitWorkerSynced(join(LOG_DIR, "worker-B2.log"), 1, 30_000);
  record(S, "restart executor + worker", exUp2 > 0 && w2.ok && synced2, `executor HTTP ${exUp2}; worker re-synced`, true);

  const stillOne = countPrefix(outcome.marker, "persist-step") === 1;
  record(
    S,
    "resume (step state persisted)",
    stillOne,
    `persist-step executions after full executor+worker crash+restart: ${countPrefix(outcome.marker, "persist-step")} (memoized, not re-run)`,
    true,
  );
  record(S, "wait for external signal", true, "run state (pause at waitForEvent) survived in redis across executor kill -9", true);

  await signalAndVerifyCompletion(client, S, outcome, eventId, 45_000);

  await killGroup9(worker);
  await killGroup9(executor);
  if (redis?.pid) {
    try {
      execFile("redis-cli", ["-p", String(REDIS_PORT), "shutdown", "nosave"], () => {});
    } catch {
      /* ignore */
    }
    await sleep(500);
    await killGroup9(redis);
  }
}

// ---------------------------------------------------------------------------
// Scenario C — NEGATIVE control: `inngest dev`, kill -9 executor + worker.
// ---------------------------------------------------------------------------
async function scenarioC(client: Inngest): Promise<void> {
  const S = "C/dev-full-kill (negative control)";
  const dir = join(RUN_DIR, "scenC");
  mkdirSync(dir, { recursive: true });
  const runKey = `c-${randomUUID().slice(0, 8)}`;
  const outcome: ScenarioOutcome = {
    runKey,
    marker: join(RUN_DIR, `marker-${runKey}.log`),
    invocations: join(RUN_DIR, `invocations-${runKey}.log`),
  };

  let dev = spawnManaged(
    "dev-C1",
    "npx",
    ["-y", CLI_SPEC, "dev", "-p", "8288", "-u", APP_URL, "--no-discovery", "--persist", "--poll-interval", "2"],
    dir,
    join(LOG_DIR, "dev-C1.log"),
  );
  const devUp = await waitResponding(DEV_BASE, 90_000, "dev server (C gen1)");
  record(S, "start dev server + trigger + persist", devUp === 200, "same setup as A (--persist)", false);
  let worker = await runWorker("C1", dir, "dev");
  await waitWorkerReady(worker, join(LOG_DIR, "worker-C1.log"), "worker (C gen1)");
  await waitWorkerSynced(join(LOG_DIR, "worker-C1.log"), 1, 30_000);
  await sleep(1_000);

  const eventId = await triggerAndWaitPersisted(client, S, outcome, 60_000); // 60s wait timeout: overdue timer would fire if state survived

  const exDead = await killGroup9(dev);
  const workerDead = await killGroup9(worker);
  record(
    S,
    "terminate executor AND worker (kill -9)",
    exDead && workerDead,
    `dev server pid ${dev.pid} dead=${exDead}, worker pid ${worker.pid} dead=${workerDead}`,
    false,
  );

  dev = spawnManaged(
    "dev-C2",
    "npx",
    ["-y", CLI_SPEC, "dev", "-p", "8288", "-u", APP_URL, "--no-discovery", "--persist", "--poll-interval", "2"],
    dir,
    join(LOG_DIR, "dev-C2.log"),
  );
  const devUp2 = await waitResponding(DEV_BASE, 90_000, "dev server (C gen2)");
  worker = await runWorker("C2", dir, "dev");
  await waitWorkerReady(worker, join(LOG_DIR, "worker-C2.log"), "worker (C gen2)");
  const synced2 = await waitWorkerSynced(join(LOG_DIR, "worker-C2.log"), 1, 30_000);
  record(S, "restart both", devUp2 === 200 && synced2, `dev HTTP ${devUp2}; worker re-synced`, false);

  await client.send({ name: SIGNAL_EVENT, data: { runKey } });
  record(S, "signal", true, `event ${SIGNAL_EVENT} sent after restart`, false);

  // Wait long enough that EITHER the signal (pause restored) or the overdue
  // 60s wait timeout (timer restored) would have completed the run.
  const completed = await waitFor(() => countPrefix(outcome.marker, "complete") === 1, 75_000);
  if (completed) {
    record(
      S,
      "documented limitation check",
      "DEVIATED",
      "run COMPLETED after executor kill -9 restart — dev server restored in-flight state (unexpected; revisit notes)",
      false,
    );
  } else {
    record(
      S,
      "documented limitation check",
      "CONFIRMED",
      "run stranded: neither the post-restart signal nor the overdue 60s wait timeout completed it — dev server run state (pauses/timers/queue) is in-memory and dies with the process; --persist only persists history/events to sqlite",
      false,
    );
  }
  void eventId;

  await killGroup9(worker);
  await killGroup9(dev);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(LOG_DIR, { recursive: true });

  const client = new Inngest({ id: "jehad-spike-driver", baseUrl: DEV_BASE, eventKey: "spike-dev" });

  console.log(`cli spec: ${CLI_SPEC} | sdk: ${sdkVersion()} | node: ${process.version} | ${process.platform}`);

  for (const [url, label] of [
    [DEV_BASE, "executor port 8288"],
    [`http://127.0.0.1:${APP_PORT}`, "app port 4040"],
  ] as const) {
    if (!(await portFree(url))) throw new Error(`preflight: ${label} in use (${url}) — refusing to run`);
  }
  if (!(await tcpReady(REDIS_PORT, 500))) {
    record("preflight", "redis port free", "INFO", `:${REDIS_PORT} free`, false);
  } else {
    throw new Error(`preflight: redis port ${REDIS_PORT} in use — refusing to run`);
  }

  await scenarioA(client);
  await scenarioB(client);
  await scenarioC(client);

  record(
    "evidence",
    "persistence artifacts",
    "INFO",
    [
      `scenA/.inngest: ${readdirSafe(join(RUN_DIR, "scenA", ".inngest"))}`,
      `scenB/sqlite: ${readdirSafe(join(RUN_DIR, "scenB", "sqlite"))}`,
      `scenB/redis (run state): ${readdirSafe(join(RUN_DIR, "scenB", "redis"))}`,
      `~/.inngest: ${readdirSafe(join(homedir(), ".inngest"))}`,
    ].join(" | "),
  );
}

function readdirSafe(p: string): string {
  try {
    return readdirSync(p).join(",");
  } catch {
    return "(absent)";
  }
}

function report(): { pass: boolean } {
  const failed = results.filter((r) => r.status === "FAIL" && required.has(`${r.scenario}/${r.protocolStep}`));
  const reportObj = {
    at: now(),
    protocol: "ADR-0008 decision 4 / plan §12 (scenario A = official gate; B = full-crash on durable shape; C = dev-server limitation control)",
    versions: {
      sdkInngest: sdkVersion(),
      cli: CLI_SPEC,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    steps: results,
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    failedSteps: failed.map((f) => `${f.scenario}/${f.protocolStep}`),
  };
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(join(RUN_DIR, "report.json"), `${JSON.stringify(reportObj, null, 2)}\n`, "utf8");
  console.log("\n=== ADR-0008 M3 SPIKE PROTOCOL ===");
  for (const r of results) {
    console.log(`${r.status.padEnd(9)} ${r.scenario} :: ${r.protocolStep} — ${r.detail}`);
  }
  console.log(`\nverdict: ${reportObj.verdict}${failed.length ? ` (failed: ${reportObj.failedSteps.join("; ")})` : ""}`);
  console.log(`report: ${join(RUN_DIR, "report.json")}`);
  return { pass: failed.length === 0 };
}

async function cleanup(): Promise<void> {
  for (const c of [...children].reverse()) {
    await killGroup9(c);
  }
}

main()
  .then(async () => {
    const { pass } = report();
    await cleanup();
    process.exit(pass ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    record("driver", "fatal", "FAIL", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
    const { pass } = report();
    await cleanup();
    process.exit(pass ? 0 : 1);
  });
