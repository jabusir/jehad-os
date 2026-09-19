// agent.ts tests — the full poll → ingest → heartbeat loop against fixture
// SQLite DBs and a fake fetch. Covers the binding wire shape
// (packages/core/src/imessage/service.ts), at-least-once + backoff, auth
// failure survival, LOUD DB-reset detection + operator acknowledgement,
// decoder-drift loud stop + recovery, heartbeat cadence, the privacy rule,
// and cursor persistence across restarts.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  HEALTHY_START,
  loadSensorState,
  runSensorCycle,
  runSensorLoop,
  saveSensorState,
  type CycleContext,
  type SensorCredentials,
  type SensorDeps,
  type SensorRuntimeState,
} from "../src/agent.js";
import { loadConfig, type SensorConfig } from "../src/config.js";
import {
  bodyFor,
  createFixtureChatDb,
  fixtureDir,
  malformedBody,
  type FixtureMessage,
} from "./fixture-db.js";

const PINNED_MORNING = "ff4dae0659223bc0223b82d779ceb3494d4c43109e9b7ae7502757e3f2575fa0";

const CREDENTIALS: SensorCredentials = { bearer: "test-bearer", capabilityToken: "test-capability" };

const root = mkdtempSync(join(tmpdir(), "imessage-sensor-agent-test-"));
afterAll(() => {});

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
  readonly body: unknown;
  readonly at: number;
}

type IngestHandler = (body: unknown) => Response | Error;
type HealthHandler = () => Response;

function okIngest(body: unknown): Response {
  const batch = (body as { batch: unknown[] }).batch ?? [];
  return new Response(
    JSON.stringify({ accepted: batch.length, duplicates: 0, fingerprint_matches: [] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const OK_INGEST: IngestHandler = (body) => okIngest(body);
const OK_HEALTH: HealthHandler = () => new Response(null, { status: 204 });

function parseBody(init: RequestInit | undefined): unknown {
  const raw = init?.body;
  return typeof raw === "string" ? (JSON.parse(raw) as unknown) : null;
}

function makeHarness(opts: {
  dbPath: string;
  statePath: string;
  env?: Record<string, string>;
  once?: boolean;
  ingest?: IngestHandler;
  health?: HealthHandler;
}): {
  calls: RecordedCall[];
  logs: string[];
  deps: SensorDeps;
  config: SensorConfig;
  clock: { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void };
} {
  const calls: RecordedCall[] = [];
  const logs: string[] = [];
  let t = 1_000_000;
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
  const config = loadConfig(
    {
      SENSOR_API_URL: "http://sensor.test",
      IMESSAGE_SENSOR_POLL_SECONDS: "1",
      IMESSAGE_SENSOR_HEARTBEAT_SECONDS: "30",
      IMESSAGE_SENSOR_DB_PATH: opts.dbPath,
      IMESSAGE_SENSOR_STATE_PATH: opts.statePath,
      ...opts.env,
    },
    opts.once === true ? ["node", "index.js", "--once"] : ["node", "index.js"],
    "/nonexistent-home",
  );
  const deps: SensorDeps = {
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init, body: parseBody(init), at: clock.now() });
      if (url.endsWith("/harness/imessage/ingest")) {
        const handler = opts.ingest ?? OK_INGEST;
        const result = handler(parseBody(init));
        if (result instanceof Error) throw result;
        return result;
      }
      if (url.endsWith("/harness/imessage/health")) {
        return (opts.health ?? OK_HEALTH)();
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch,
    resolveCredentials: async () => CREDENTIALS,
    log: (message) => {
      logs.push(message);
    },
  };
  return { calls, logs, deps, config, clock };
}

function appendMessages(path: string, messages: readonly FixtureMessage[]): void {
  const db = new DatabaseSync(path);
  const stmt = db.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, attributedBody, service, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const m of messages) {
    const blob =
      m.attributedBody === undefined || m.attributedBody === null
        ? null
        : typeof m.attributedBody === "string"
          ? bodyFor(m.attributedBody)
          : m.attributedBody;
    stmt.run(m.rowid, m.guid, m.text ?? null, m.handleRowid ?? null, blob, m.service ?? null, m.isFromMe);
  }
  db.close();
}

function seedState(statePath: string, cursor: number, extra: Partial<SensorRuntimeState> = {}): void {
  saveSensorState(statePath, {
    cursor_rowid: cursor,
    db_generation: null,
    schema_fingerprint: null,
    ever_own_observed: false,
    baselined_at: "2026-09-18T00:00:00.000Z",
    ...extra,
  });
}

function freshCtx(state: SensorRuntimeState): CycleContext {
  return {
    state,
    health: { ...HEALTHY_START, shadow: state.ever_own_observed ? "healthy" : "degraded" },
    consecutiveDecodeFailures: 0,
    decoderStopped: false,
    resetAlerted: false,
    lastHeartbeatAt: null,
    schemaDrift: false,
    ingestFailing: false,
  };
}

function ingestCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.url.endsWith("/harness/imessage/ingest"));
}

function healthCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.url.endsWith("/harness/imessage/health"));
}

describe("cold start, baseline, resume", () => {
  it("first run baselines at max rowid (no forwarding of history), persists state, heartbeats five dims", async () => {
    const dir = fixtureDir(root, "cold");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [
        { rowid: 10, guid: "g10", isFromMe: 0, text: "old third party" },
        { rowid: 20, guid: "g20", isFromMe: 1, text: "old own" },
      ],
    });
    const statePath = join(dir, "state.json");
    const h = makeHarness({ dbPath, statePath, once: true });
    await runSensorLoop(h.deps, h.config, () => false, h.clock.sleep, h.clock.now);

    expect(ingestCalls(h.calls)).toEqual([]);
    const state = loadSensorState(statePath);
    expect(state?.cursor_rowid).toBe(20);
    const health = healthCalls(h.calls);
    expect(health).toHaveLength(1);
    const body = health[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "details",
      "health_cursor",
      "health_database",
      "health_decoder",
      "health_process",
      "health_shadow",
    ]);
    expect(body["health_shadow"]).toBe("degraded");
    expect(h.logs.join("\n")).toContain("baselining cursor at max rowid 20");
  });

  it("new rows forward once; cursor persists across restart; resume forwards only newer rows", async () => {
    const dir = fixtureDir(root, "resume");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 10, guid: "g10", isFromMe: 0, text: "seed" }],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10);

    appendMessages(dbPath, [
      {
        rowid: 11,
        guid: "g11",
        isFromMe: 0,
        text: "SECRET-THIRD-PARTY-CONTENT",
        handleRowid: 1,
      },
      {
        rowid: 12,
        guid: "g12",
        isFromMe: 1,
        text: null,
        attributedBody: "Morning brief\r\nLINE ONE\r\nLINE TWO",
        handleRowid: 1,
      },
    ]);
    const h1 = makeHarness({ dbPath, statePath, once: true });
    await runSensorLoop(h1.deps, h1.config, () => false, h1.clock.sleep, h1.clock.now);
    const sent = ingestCalls(h1.calls);
    expect(sent).toHaveLength(1);
    expect(loadSensorState(statePath)?.cursor_rowid).toBe(12);
    expect(loadSensorState(statePath)?.ever_own_observed).toBe(true);

    // Restart: fresh process/loop, same state file — only newer rows.
    appendMessages(dbPath, [{ rowid: 13, guid: "g13", isFromMe: 0, text: "next" }]);
    const h2 = makeHarness({ dbPath, statePath, once: true });
    await runSensorLoop(h2.deps, h2.config, () => false, h2.clock.sleep, h2.clock.now);
    const batch = ingestCalls(h2.calls)[0]!.body as { batch: { guid: string }[] };
    expect(batch.batch.map((e) => e.guid)).toEqual(["g13"]);
    expect(loadSensorState(statePath)?.cursor_rowid).toBe(13);
  });

  it("no new rows → no ingest call (quiet DB is healthy; nothing silent)", async () => {
    const dir = fixtureDir(root, "quiet");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 10, guid: "g10", isFromMe: 0, text: "x" }],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10, { ever_own_observed: true });
    const h = makeHarness({ dbPath, statePath, once: true });
    await runSensorLoop(h.deps, h.config, () => false, h.clock.sleep, h.clock.now);
    expect(ingestCalls(h.calls)).toEqual([]);
    expect(healthCalls(h.calls)).toHaveLength(1);
  });
});

describe("wire contract (matches packages/core imessage service types)", () => {
  it("ingest body: {batch, cursor} snake_case; events validate against the service shape", async () => {
    const { IMESSAGE_DECODED_STATUSES } = await import("@jehad/core");
    const dir = fixtureDir(root, "wire");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      handles: [{ rowid: 1, id: "+15550000001" }],
      messages: [
        {
          rowid: 11,
          guid: "g11",
          isFromMe: 0,
          text: "SECRET-THIRD-PARTY-CONTENT",
          handleRowid: 1,
        },
        {
          rowid: 12,
          guid: "g12",
          isFromMe: 1,
          text: null,
          attributedBody: "Morning brief\nLINE ONE\nLINE TWO",
          handleRowid: 1,
        },
        {
          rowid: 13,
          guid: "g13",
          isFromMe: 0,
          text: null,
          attributedBody: malformedBody(),
          handleRowid: 1,
        },
      ],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10);
    const h = makeHarness({ dbPath, statePath, once: true });
    await runSensorLoop(h.deps, h.config, () => false, h.clock.sleep, h.clock.now);

    const call = ingestCalls(h.calls)[0]!;
    expect(call.url).toBe("http://sensor.test/harness/imessage/ingest");
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CREDENTIALS.bearer}`);
    expect(headers.get("x-capability-token")).toBe(CREDENTIALS.capabilityToken);
    expect(headers.get("content-type")).toBe("application/json");

    const body = call.body as {
      batch: Record<string, unknown>[];
      cursor: Record<string, unknown>;
    };
    expect(Object.keys(body).sort()).toEqual(["batch", "cursor"]);
    expect(body.batch.map((e) => e.guid)).toEqual(["g11", "g12", "g13"]);
    const baseKeys = [
      "decoded_status",
      "guid",
      "has_attributed_body",
      "has_text",
      "is_from_me",
      "observed_at",
      "rowid",
      "service",
      "text_length",
      "transport_handle",
    ];
    for (const event of body.batch) {
      // The own row carries EXACTLY one extra key: the canonical hash.
      const expectedKeys = event["is_from_me"]
        ? [...baseKeys, "normalized_text_sha256"]
        : baseKeys;
      expect(Object.keys(event).sort()).toEqual(expectedKeys.sort());
      expect(typeof event["guid"]).toBe("string");
      expect(Number.isSafeInteger(event["rowid"])).toBe(true);
      expect(typeof event["is_from_me"]).toBe("boolean");
      expect(typeof event["transport_handle"]).toBe("string");
      expect(
        (IMESSAGE_DECODED_STATUSES as readonly string[]).includes(String(event["decoded_status"])),
      ).toBe(true);
      expect(new Date(String(event["observed_at"])).getTime()).toBeGreaterThan(0);
    }
    // The own row is the ONLY one carrying the canonical hash (pinned vector).
    const own = body.batch[1]!;
    expect(own["normalized_text_sha256"]).toBe(PINNED_MORNING);
    expect(Object.keys(body.batch[0]!).includes("normalized_text_sha256")).toBe(false);
    expect(body.batch[0]!["decoded_status"]).toBe("ok");
    expect(body.batch[2]!["decoded_status"]).toBe("skipped-malformed");
    // Cursor rides the same body.
    expect(body.cursor["rowid"]).toBe(13);
    expect(String(body.cursor["db_generation"]).length).toBeGreaterThan(0);
    expect(String(body.cursor["schema_fingerprint"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PRIVACY: third-party content never appears anywhere in the payload", async () => {
    const dir = fixtureDir(root, "privacy");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [
        { rowid: 11, guid: "g11", isFromMe: 0, text: "SECRET-THIRD-PARTY-CONTENT" },
        {
          rowid: 12,
          guid: "g12",
          isFromMe: 0,
          text: null,
          attributedBody: "TOPSECRET-BODY-CONTENT",
        },
      ],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10);
    const h = makeHarness({ dbPath, statePath, once: true });
    await runSensorLoop(h.deps, h.config, () => false, h.clock.sleep, h.clock.now);
    const wire = JSON.stringify(ingestCalls(h.calls)[0]!.body);
    expect(wire).not.toContain("SECRET-THIRD-PARTY-CONTENT");
    expect(wire).not.toContain("TOPSECRET-BODY-CONTENT");
    const body = ingestCalls(h.calls)[0]!.body as { batch: Record<string, unknown>[] };
    for (const event of body.batch) {
      expect(Object.keys(event).includes("normalized_text_sha256")).toBe(false);
      expect(Object.keys(event).includes("text")).toBe(false);
    }
  });
});

describe("at-least-once + backoff", () => {
  it("network failure → cursor frozen, identical batch re-sent, backoff doubles", async () => {
    const dir = fixtureDir(root, "atleastonce");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 10, guid: "g10", isFromMe: 0, text: "x" }],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10);
    appendMessages(dbPath, [{ rowid: 11, guid: "g11", isFromMe: 0, text: "new" }]);

    let ingestAttempts = 0;
    let stop = false;
    const h = makeHarness({
      dbPath,
      statePath,
      ingest: (body) => {
        ingestAttempts += 1;
        if (ingestAttempts === 1) return new Error("fetch failed: ECONNREFUSED");
        stop = true;
        return okIngest(body);
      },
    });
    await runSensorLoop(h.deps, h.config, () => stop, h.clock.sleep, h.clock.now);

    const sent = ingestCalls(h.calls);
    expect(sent).toHaveLength(2);
    const guids = (b: unknown) =>
      (b as { batch: { guid: string }[] }).batch.map((e) => e.guid);
    expect(guids(sent[0]!.body)).toEqual(["g11"]);
    expect(guids(sent[1]!.body)).toEqual(["g11"]);
    expect(loadSensorState(statePath)?.cursor_rowid).toBe(11);
    expect(h.logs.join("\n")).toContain("ingest failed: fetch failed: ECONNREFUSED");
    expect(h.logs.join("\n")).toContain("backing off");
  });

  it("auth failure (401) → backoff, never a crash; health keeps posting; cursor never advances", async () => {
    const dir = fixtureDir(root, "auth401");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 10, guid: "g10", isFromMe: 0, text: "x" }],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10);
    appendMessages(dbPath, [{ rowid: 11, guid: "g11", isFromMe: 0, text: "new" }]);

    const timestamps: number[] = [];
    let stop = false;
    const h = makeHarness({
      dbPath,
      statePath,
      ingest: () => {
        timestamps.push(h.clock.now());
        if (timestamps.length >= 3) stop = true;
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      },
    });
    await runSensorLoop(h.deps, h.config, () => stop, h.clock.sleep, h.clock.now);

    expect(ingestCalls(h.calls)).toHaveLength(3);
    expect(healthCalls(h.calls).length).toBeGreaterThanOrEqual(1);
    expect(loadSensorState(statePath)?.cursor_rowid).toBe(10);
    expect(h.logs.join("\n")).toContain("ingest failed: 401 (unauthorized)");
    // Backoff doubles per consecutive failed cycle (poll 1s → 2s → 4s).
    expect(timestamps[1]! - timestamps[0]!).toBe(2000);
    expect(timestamps[2]! - timestamps[1]!).toBe(4000);
  });
});

describe("DB reset detection (loud, never silent)", () => {
  it("max rowid below cursor → health_cursor=failed + alert, NO ingest, NO re-baseline", async () => {
    const dirB = fixtureDir(root, "reset-b");
    const dirShared = fixtureDir(root, "reset-shared");
    const dbB = createFixtureChatDb(join(dirB, "chat.db"), {
      messages: Array.from({ length: 3 }, (_, i) => ({
        rowid: 20 + i,
        guid: `gb${i}`,
        isFromMe: 0 as const,
        text: `b${i}`,
      })),
    });
    const statePath = join(dirShared, "state.json");
    seedState(statePath, 100);

    const h = makeHarness({ dbPath: dbB, statePath, once: true });
    const ctx = freshCtx(loadSensorState(statePath)!);
    const outcome = await runSensorCycle(h.deps, h.config, ctx, h.clock.now);

    expect(outcome.resetDetected).toBe(true);
    expect(outcome.ingested).toBe(false);
    expect(ingestCalls(h.calls)).toEqual([]);
    const health = healthCalls(h.calls)[0]!.body as {
      health_cursor: string;
      details: { reset: { cursor_rowid: number; max_rowid: number } };
    };
    expect(health.health_cursor).toBe("failed");
    expect(health.details.reset).toEqual({
      cursor_rowid: 100,
      max_rowid: 22,
      db_generation: expect.any(String),
    });
    expect(loadSensorState(statePath)?.cursor_rowid).toBe(100);
    expect(h.logs.join("\n")).toContain("DB RESET DETECTED");
    expect(h.logs.join("\n")).toContain("IMESSAGE_SENSOR_REBASELINE");
  });

  it("operator acknowledgement (IMESSAGE_SENSOR_REBASELINE=explicit-max-rowid) re-baselines loudly and resumes", async () => {
    const dir = fixtureDir(root, "reset-ack");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 22, guid: "g22", isFromMe: 0, text: "new db" }],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 100);

    const h = makeHarness({
      dbPath,
      statePath,
      once: true,
      env: { IMESSAGE_SENSOR_REBASELINE: "explicit-max-rowid" },
    });
    const ctx = freshCtx(loadSensorState(statePath)!);
    const outcome = await runSensorCycle(h.deps, h.config, ctx, h.clock.now);
    expect(outcome.rebaselined).toBe(true);
    expect(loadSensorState(statePath)?.cursor_rowid).toBe(22);
    expect(ingestCalls(h.calls)).toEqual([]);
    expect(h.logs.join("\n")).toContain("REBASELINE acknowledged");

    appendMessages(dbPath, [{ rowid: 23, guid: "g23", isFromMe: 0, text: "post-reset" }]);
    const h2 = makeHarness({ dbPath, statePath, once: true });
    const ctx2 = freshCtx(loadSensorState(statePath)!);
    await runSensorCycle(h2.deps, h2.config, ctx2, h2.clock.now);
    const batch = ingestCalls(h2.calls)[0]!.body as { batch: string[]; cursor: { rowid: number } };
    expect(batch.batch).toHaveLength(1);
    expect(batch.cursor.rowid).toBe(23);
  });
});

describe("decoder drift (loud stop)", () => {
  it("≥ threshold consecutive decode failures → health_decoder=failed, forwarding stops, cursor frozen", async () => {
    const dir = fixtureDir(root, "drift");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 10, guid: "g10", isFromMe: 0, text: "x" }],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10);
    appendMessages(
      dbPath,
      Array.from({ length: 20 }, (_, i) => ({
        rowid: 11 + i,
        guid: `gm${i}`,
        isFromMe: 0 as const,
        text: null as string | null,
        attributedBody: malformedBody() as Uint8Array,
      })),
    );

    const h = makeHarness({ dbPath, statePath, once: true });
    const ctx = freshCtx(loadSensorState(statePath)!);
    const outcome = await runSensorCycle(h.deps, h.config, ctx, h.clock.now);

    expect(outcome.ingested).toBe(false);
    expect(ingestCalls(h.calls)).toEqual([]);
    const health = healthCalls(h.calls).at(-1)!.body as { health_decoder: string };
    expect(health.health_decoder).toBe("failed");
    expect(loadSensorState(statePath)?.cursor_rowid).toBe(10);
    expect(h.logs.join("\n")).toContain("DECODER DRIFT");
  });

  it("a later successful decode recovers forwarding and flushes the frozen backlog", async () => {
    const dir = fixtureDir(root, "drift-recover");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 10, guid: "g10", isFromMe: 0, text: "x" }],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10);
    appendMessages(
      dbPath,
      Array.from({ length: 20 }, (_, i) => ({
        rowid: 11 + i,
        guid: `gm${i}`,
        isFromMe: 0 as const,
        text: null as string | null,
        attributedBody: malformedBody() as Uint8Array,
      })),
    );
    const h = makeHarness({ dbPath, statePath, once: true });
    const ctx = freshCtx(loadSensorState(statePath)!);
    await runSensorCycle(h.deps, h.config, ctx, h.clock.now);
    expect(ctx.health.decoder).toBe("failed");

    appendMessages(dbPath, [
      {
        rowid: 31,
        guid: "g31",
        isFromMe: 1,
        text: null,
        attributedBody: "Morning brief\nLINE ONE\nLINE TWO",
      },
    ]);
    await runSensorCycle(h.deps, h.config, ctx, h.clock.now);

    const sent = ingestCalls(h.calls);
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as { batch: { decoded_status: string; normalized_text_sha256?: string }[] };
    expect(body.batch).toHaveLength(21);
    expect(body.batch.filter((e) => e.decoded_status === "skipped-malformed")).toHaveLength(20);
    const own = body.batch.at(-1)!;
    expect(own.decoded_status).toBe("own-ok");
    expect(own.normalized_text_sha256).toBe(PINNED_MORNING);
    expect(ctx.health.decoder).toBe("healthy");
    expect(loadSensorState(statePath)?.cursor_rowid).toBe(31);
    expect(h.logs.join("\n")).toContain("decoder recovered");
  });
});

describe("heartbeat + failure health", () => {
  it("heartbeat posts on cadence (~30s) and immediately on forced alerts, not every cycle", async () => {
    const dir = fixtureDir(root, "heartbeat");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 10, guid: "g10", isFromMe: 0, text: "x" }],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10);
    const h = makeHarness({ dbPath, statePath });
    const ctx = freshCtx(loadSensorState(statePath)!);
    ctx.lastHeartbeatAt = h.clock.now() - 5_000;

    await runSensorCycle(h.deps, h.config, ctx, h.clock.now);
    expect(healthCalls(h.calls)).toEqual([]);

    h.clock.advance(26_000); // 31s since last heartbeat
    await runSensorCycle(h.deps, h.config, ctx, h.clock.now);
    expect(healthCalls(h.calls)).toHaveLength(1);

    h.clock.advance(5_000); // only 5s since the post
    await runSensorCycle(h.deps, h.config, ctx, h.clock.now);
    expect(healthCalls(h.calls)).toHaveLength(1);
  });

  it("chat.db open failure → health_database=failed with details, no crash, no ingest", async () => {
    const dir = fixtureDir(root, "openfail");
    const statePath = join(dir, "state.json");
    const h = makeHarness({
      dbPath: join(dir, "missing", "chat.db"),
      statePath,
      once: true,
    });
    await runSensorLoop(h.deps, h.config, () => false, h.clock.sleep, h.clock.now);
    expect(ingestCalls(h.calls)).toEqual([]);
    const health = healthCalls(h.calls)[0]!.body as {
      health_database: string;
      details: { db_open_error: string };
    };
    expect(health.health_database).toBe("failed");
    expect(String(health.details.db_open_error)).toContain("cannot open");
    expect(loadSensorState(statePath)).toBeNull();
  });

  it("credential resolution failure → failed cycle (backoff), never a crash; cursor frozen", async () => {
    const dir = fixtureDir(root, "nocred");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 10, guid: "g10", isFromMe: 0, text: "x" }],
    });
    const statePath = join(dir, "state.json");
    seedState(statePath, 10);
    appendMessages(dbPath, [{ rowid: 11, guid: "g11", isFromMe: 0, text: "new" }]);
    const h = makeHarness({ dbPath, statePath });
    const deps: SensorDeps = {
      ...h.deps,
      resolveCredentials: async () => {
        throw new Error("no Keychain credential under jehad-os/imessage-sensor");
      },
    };
    const outcome = await runSensorCycle(deps, h.config, freshCtx(loadSensorState(statePath)!), h.clock.now);
    expect(outcome.failed).toBe(true);
    expect(outcome.ingested).toBe(false);
    expect(loadSensorState(statePath)?.cursor_rowid).toBe(10);
    expect(h.logs.join("\n")).toContain("credential resolution failed");
  });

  it("corrupt state file → LOUD refusal (never a silent re-baseline)", async () => {
    const dir = fixtureDir(root, "corrupt");
    const dbPath = createFixtureChatDb(join(dir, "chat.db"), {
      messages: [{ rowid: 10, guid: "g10", isFromMe: 0, text: "x" }],
    });
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, "{not json");
    const h = makeHarness({ dbPath, statePath, once: true });
    await runSensorLoop(h.deps, h.config, () => false, h.clock.sleep, h.clock.now);
    expect(ingestCalls(h.calls)).toEqual([]);
    expect(healthCalls(h.calls)).toEqual([]);
    expect(readFileSync(statePath, "utf8")).toBe("{not json");
    expect(h.logs.join("\n")).toContain("STATE FILE ERROR");
  });
});
