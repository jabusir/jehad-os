// Dev-server integration suite (M3 acceptance): start/signal/cancel/status,
// kill -9 resilience (step + approval wait), human_waits correlation, and the
// scheduled-workflow primitive — exercised against a real Inngest dev server
// with the worker served as in production shape (ADR-0008 recorded shape).
//
// Opt-in (process supervision + ports + DB): runs when TEST_DATABASE_URL is
// set AND WORKFLOW_DEVSERVER_TESTS=1. Start/stop per suite: the dev server
// and worker are spawned in beforeAll and torn down in afterAll.
//
// Note on cron: the executor's cron granularity floor is one minute (a
// 6-field seconds expression is rejected by inngest-cli 1.44.0), so the
// scheduled primitive is tested on an every-minute schedule.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrateUp } from "@jehad/db";
import {
  createIsolatedTestDb,
  dropIsolatedTestDb,
  type IsolatedDb,
} from "./isolated-db";
import {
  createSqlRunCorrelator,
  createWorkflowRuntime,
  type DetailedWorkflowStatus,
  type JehadWorkflowRuntime,
} from "../src/index.js";
import { markerDir, WORKFLOW_NAMES } from "./helpers/test-workflows.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ENABLED = process.env.WORKFLOW_DEVSERVER_TESTS === "1";
const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_SPEC = "inngest-cli@1.44.0";
const DEV_PORT = Number(process.env.WORKFLOW_DEV_PORT ?? 8397);
const WORKER_PORT = Number(process.env.WORKFLOW_WORKER_PORT ?? 4397);
const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}/api/inngest`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(label: string, cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(300);
  }
  throw new Error(`timeout after ${timeoutMs}ms waiting for ${label}`);
}

interface Managed {
  name: string;
  child: ChildProcess;
}

const children: Managed[] = [];

function spawnManaged(name: string, cmd: string, args: string[], cwd: string, logFile: string, env: NodeJS.ProcessEnv = {}): Managed {
  const child = spawn(cmd, args, {
    cwd,
    detached: true, // own process group — kill -9 the group, not just the shell
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const stream = createWriteStream(logFile, { flags: "a" });
  child.stdout?.on("data", (d: Buffer) => stream.write(d));
  child.stderr?.on("data", (d: Buffer) => stream.write(d));
  children.push({ name, child });
  return { name, child };
}

async function killGroup9(m: Managed | undefined): Promise<boolean> {
  const pid = m?.child.pid;
  if (pid === undefined) return false;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already dead */
  }
  await sleep(500);
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function httpJson(url: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  } catch {
    return null;
  }
}

function markerLines(key: string): string[] {
  const file = join(markerDir(), `${key}.log`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

/** Marker events for one specific run (marker lines carry the run id). */
function runMarkers(key: string, runId: string, event: string): string[] {
  return markerLines(key).filter((l) => l.includes(runId) && l.includes(event));
}

describe.skipIf(!(TEST_DATABASE_URL && ENABLED))("WorkflowRuntime over the Inngest dev server (integration)", () => {
  let db: IsolatedDb;
  let pool: Pool;
  let runtime: JehadWorkflowRuntime;
  let worker: Managed;
  let scratch: string;
  let principalId: string;
  let domainId: string;

  async function spawnWorker(gen: string): Promise<Managed> {
    return spawnManaged(`worker-${gen}`, "pnpm", ["exec", "tsx", "tests/helpers/worker-process.ts"], PKG_DIR, join(scratch, `worker-${gen}.log`), {
      WORKER_PORT: String(WORKER_PORT),
      INNGEST_BASE_URL: DEV_BASE,
      WORKFLOW_MARKER_DIR: markerDir(),
      WORKFLOW_TEST_DB_URL: db.dsn,
      WORKFLOW_PRINCIPAL_ID: principalId,
      WORKFLOW_DOMAIN_ID: domainId,
    });
  }

  async function waitWorkerServing(label: string): Promise<void> {
    await waitFor(label, async () => {
      const res = await httpJson(WORKER_URL);
      return res?.status === 200 && JSON.stringify(res.body).includes('"function_count":4');
    }, 30_000);
  }

  async function detailed(handle: { runId: string }): Promise<DetailedWorkflowStatus> {
    return runtime.detailedStatus(handle);
  }

  async function openHumanWaits(runId: string): Promise<number> {
    const result = await pool.query(
      `SELECT count(*)::int AS n FROM human_waits hw
       JOIN runs r ON hw.run_id = r.id
       WHERE r.workflow_id = $1 AND hw.resolved_at IS NULL`,
      [runId],
    );
    return result.rows[0]!.n;
  }

  async function runsRow(runId: string): Promise<{ status: string; ended_at: string | null } | undefined> {
    const result = await pool.query<{ status: string; ended_at: string | null }>(
      "SELECT status, ended_at FROM runs WHERE workflow_id = $1",
      [runId],
    );
    return result.rows[0];
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "jehad-workflow-it-"));
    process.env.WORKFLOW_MARKER_DIR = join(scratch, "markers");
    rmSync(markerDir(), { recursive: true, force: true });

    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "workflow_devserver");
    pool = db.pool;
    await migrateUp(pool);
    const domain = await pool.query<{ id: string }>(
      `INSERT INTO domains (key, name, sensitivity, retention_class)
       VALUES ('work', 'Work', 'standard', 'standard') RETURNING id`,
    );
    domainId = domain.rows[0]!.id;
    const principal = await pool.query<{ id: string }>(
      `INSERT INTO principals (type, name) VALUES ('user', 'devserver-it') RETURNING id`,
    );
    principalId = principal.rows[0]!.id;

    const dev = spawnManaged(
      "devserver",
      "npx",
      ["-y", CLI_SPEC, "dev", "-p", String(DEV_PORT), "-u", WORKER_URL, "--no-discovery", "--persist", "--poll-interval", "1"],
      scratch,
      join(scratch, "devserver.log"),
    );
    await waitFor("dev server healthy", async () => (await httpJson(`${DEV_BASE}/v1/events`)) !== null, 90_000);
    void dev;

    worker = await spawnWorker("gen1");
    await waitWorkerServing("worker gen1 serving 4 functions");
    // Give the executor a beat to sync registrations before the first start().
    await sleep(2_000);

    runtime = createWorkflowRuntime({
      config: { baseUrl: DEV_BASE },
      correlator: createSqlRunCorrelator(pool, { principalId, domainId }),
    });
  }, 120_000);

  afterAll(async () => {
    for (const c of [...children].reverse()) await killGroup9(c);
    children.length = 0;
    if (db) await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  it("start() produces a handle whose status becomes queryable and completes", async () => {
    const handle = await runtime.start(WORKFLOW_NAMES.quick, { hello: "world" });
    expect(handle.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // executor ULID
    await waitFor("quick workflow completes", async () => (await detailed(handle)) === "completed", 30_000);
    expect(markerLines("quick").some((l) => l.includes("persist"))).toBe(false);
    expect(markerLines("quick").filter((l) => l.includes('"step"')).length).toBe(1);
    // start()-side correlation wrote the semantic runs row.
    await waitFor("runs row exists", async () => (await runsRow(handle.runId)) !== undefined, 10_000);
    const row = await runsRow(handle.runId);
    expect(row?.status).toBe("completed"); // worker-side close:run stamped it
    expect(row?.ended_at).not.toBeNull();
  }, 60_000);

  it("signal() wakes a parked waitForSignal and delivers the payload", async () => {
    const handle = await runtime.start(WORKFLOW_NAMES.signalFlow, {});
    await waitFor("parks at signal wait", async () => (await detailed(handle)) === "waiting_signal", 30_000);
    expect(await runtime.status(handle)).toBe("waiting"); // port vocabulary
    expect(markerLines("signal-flow").some((l) => l.includes("prep"))).toBe(true);

    await runtime.signal(handle, { name: "go", payload: { ok: 1 } });
    await waitFor("completes after signal", async () => (await detailed(handle)) === "completed", 30_000);
    expect(markerLines("signal-flow").some((l) => l.includes("go"))).toBe(true);
  }, 60_000);

  it("cancel() cancels a parked approval wait and closes its human_waits row", async () => {
    const handle = await runtime.start(WORKFLOW_NAMES.approvalFlow, {});
    await waitFor("parks at approval wait", async () => (await detailed(handle)) === "waiting_approval", 30_000);
    await waitFor("human_waits row opened", async () => (await openHumanWaits(handle.runId)) === 1, 10_000);

    await runtime.cancel(handle);
    await waitFor("cancelled", async () => (await detailed(handle)) === "cancelled", 30_000);
    expect(await runtime.status(handle)).toBe("cancelled");
    await waitFor("human_waits row closed by cancel", async () => (await openHumanWaits(handle.runId)) === 0, 10_000);
    expect((await runsRow(handle.runId))?.status).toBe("cancelled");
  }, 60_000);

  it("survives worker kill -9 at a persisted step + approval wait, then resumes", async () => {
    const handle = await runtime.start(WORKFLOW_NAMES.approvalFlow, {});
    const persistCount = () => runMarkers("approval-flow", handle.runId, "persist-step").length;
    await waitFor("persist-step executed once", () => persistCount() === 1, 30_000);
    await waitFor("parks at approval wait", async () => (await detailed(handle)) === "waiting_approval", 30_000);
    await waitFor("human_waits row opened", async () => (await openHumanWaits(handle.runId)) === 1, 10_000);

    // kill -9 the worker process group; the executor (dev server) keeps the pause.
    const killed = await killGroup9(worker);
    expect(killed).toBe(true);
    children.splice(children.findIndex((c) => c.name === "worker-gen1"), 1);

    // Pause state is executor-held: status still queryable, step not re-run.
    expect(await detailed(handle)).toBe("waiting_approval");
    await sleep(1_500);
    expect(persistCount()).toBe(1);

    // Restart the worker (re-sync with executor), then approve.
    worker = await spawnWorker("gen2");
    await waitWorkerServing("worker gen2 re-synced");
    await sleep(2_000);
    expect(persistCount()).toBe(1); // memoization held across crash + restart

    await runtime.signal(handle, { name: "approve:release", payload: { by: "owner" } });
    await waitFor("completes after approval", async () => (await detailed(handle)) === "completed", 45_000);

    // Persist step still executed exactly once across the crash (spike proof).
    expect(persistCount()).toBe(1);
    expect(runMarkers("approval-flow", handle.runId, '"approved":true').length).toBe(1);
    // The approval wait closed on resume.
    await waitFor("human_waits closed on resume", async () => (await openHumanWaits(handle.runId)) === 0, 10_000);
    expect((await runsRow(handle.runId))?.status).toBe("completed");
  }, 150_000);

  it("scheduled workflow primitive fires on its cron schedule", async () => {
    // Every-minute cron (executor granularity floor); the suite's setup
    // typically lands mid-minute, so a firing arrives within ~70s.
    await waitFor("cron ticker fired", () => markerLines("ticker").length >= 1, 90_000);
  }, 120_000);
});
