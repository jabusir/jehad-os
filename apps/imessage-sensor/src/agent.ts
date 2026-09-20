// The sensor agent loop (gateway Phase A). One cycle:
//
//   open chat.db read-only → snapshot (reset check, schema check)
//   → poll new rows (classify + hash own rows; content ONLY for handles
//     in the paired-handle cache) → POST /harness/imessage/ingest
//     (bearer + capability token) → persist cursor ONLY after a 2xx
//   → POST /harness/imessage/health (five dims) every heartbeatSeconds or
//     on any health-dim transition. The heartbeat RESPONSE carries the
//     sensor config `{ paired_handles: string[] }` (multi-principal
//     contract) — cached here and refreshed on every heartbeat (plus one
//     fetch at startup). Missing/invalid/absent config → EMPTY cache →
//     the sensor forwards NO message content (fail closed; every non-own
//     row degrades to its pairing hash).
//
// At-least-once: a failed ingest leaves the local cursor untouched, so the
// next cycle re-sends the same rows — guid is the server-side idempotency
// key. Failures back off exponentially (capped); the loop NEVER throws:
// launchd KeepAlive restarts are fine, but in-process resilience keeps
// logs meaningful.
//
// LOUD contracts (never silent):
//   DB reset (max rowid < stored cursor) → health_cursor=failed + alert
//   health POST; NO silent re-baseline — the operator acknowledges via
//   IMESSAGE_SENSOR_REBASELINE (config.ts), which skips the gap loudly.
//   Decoder drift (≥ threshold consecutive decode failures) →
//   health_decoder=failed + STOP forwarding (keep auditing; cursor frozen,
//   so nothing is lost — recovery forwards the whole backlog).
//   "0 new messages" is never accepted as healthy while the DB advances:
//   a cursor stuck below max rowid degrades health_cursor.
//
// Five health dims (plan §9): process / database / decoder / cursor /
// shadow — computed from facts each cycle, transitions logged + reported.
// The decoder dim reports only from cycles that ATTEMPTED ≥1 decode: an
// idle cycle (no attributedBody rows) reports healthy rather than carrying
// a stale degraded from a past failure (see runSensorCycle).

import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SensorConfig } from "./config.js";
import { ChatDbError, openChatDb, type ChatDbSnapshot } from "./db.js";
import { PairedHandleCache, parsePairedHandlesBody } from "./paired.js";
import { pollOnce, type TransportEventWire } from "./poll.js";

export interface SensorCredentials {
  readonly bearer: string;
  readonly capabilityToken: string;
}

export interface SensorDeps {
  readonly fetchFn: typeof fetch;
  readonly resolveCredentials: () => Promise<SensorCredentials>;
  /** stderr logger; must never receive secret-shaped values. */
  readonly log?: (message: string) => void;
}

export type HealthDim = "healthy" | "degraded" | "failed";

export interface SensorHealth {
  readonly process: HealthDim;
  readonly database: HealthDim;
  readonly decoder: HealthDim;
  readonly cursor: HealthDim;
  readonly shadow: HealthDim;
}

export const HEALTHY_START: SensorHealth = {
  process: "healthy",
  database: "healthy",
  decoder: "healthy",
  cursor: "healthy",
  shadow: "degraded",
};

/** Persisted sensor state (the cursor survives restarts; the server tracks its own copy per ingest). */
export interface SensorRuntimeState {
  readonly cursor_rowid: number;
  readonly db_generation: string | null;
  readonly schema_fingerprint: string | null;
  readonly ever_own_observed: boolean;
  readonly baselined_at: string;
}

export class SensorStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SensorStateError";
  }
}

function parseState(raw: string): SensorRuntimeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SensorStateError("state file is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SensorStateError("state file is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const cursor = record["cursor_rowid"];
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new SensorStateError("state file cursor_rowid is not a non-negative integer");
  }
  return {
    cursor_rowid: cursor,
    db_generation: typeof record["db_generation"] === "string" ? record["db_generation"] : null,
    schema_fingerprint:
      typeof record["schema_fingerprint"] === "string" ? record["schema_fingerprint"] : null,
    ever_own_observed: record["ever_own_observed"] === true,
    baselined_at: typeof record["baselined_at"] === "string" ? record["baselined_at"] : "",
  };
}

/**
 * Loads the cursor state. Missing file → null (first run: loud baseline).
 * A PRESENT-but-corrupt file THROWS — auto-baselining over a corrupt state
 * would be a silent re-baseline; the operator must inspect and ack via
 * IMESSAGE_SENSOR_REBASELINE.
 */
export function loadSensorState(path: string): SensorRuntimeState | null {
  if (!existsSync(path)) return null;
  return parseState(readFileSync(path, "utf8"));
}

/** Atomic persist (tmp file + rename in the same directory). */
export function saveSensorState(path: string, state: SensorRuntimeState): void {
  const dir = path.substring(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export interface IngestCursor {
  readonly rowid: number;
  readonly db_generation: string | null;
  readonly schema_fingerprint: string | null;
}

export interface IngestReport {
  readonly accepted: number;
  readonly duplicates: number;
  readonly fingerprint_matches: readonly { guid: string; fingerprint_id: string }[];
}

interface HttpResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T | null;
  readonly error: string | null;
}

function authHeaders(credentials: SensorCredentials): Record<string, string> {
  return {
    authorization: `Bearer ${credentials.bearer}`,
    "x-capability-token": credentials.capabilityToken,
  };
}

async function postJson<T>(
  deps: SensorDeps,
  url: string,
  credentials: SensorCredentials,
  body: unknown,
): Promise<HttpResult<T>> {
  let response: Response;
  try {
    response = await deps.fetchFn(url, {
      method: "POST",
      headers: { ...authHeaders(credentials), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (response.status === 204) {
    return { ok: true, status: 204, body: null, error: null };
  }
  let parsed: T | null = null;
  try {
    parsed = (await response.json()) as T;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const described =
      parsed !== null && typeof (parsed as { error?: unknown }).error === "string"
        ? `${response.status} (${String((parsed as { error: string }).error)})`
        : String(response.status);
    return { ok: false, status: response.status, body: parsed, error: described };
  }
  return { ok: true, status: response.status, body: parsed, error: null };
}

async function resolveOrError(
  deps: SensorDeps,
): Promise<{ credentials: SensorCredentials | null; error: string | null }> {
  try {
    return { credentials: await deps.resolveCredentials(), error: null };
  } catch (err) {
    return {
      credentials: null,
      error: `credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** POST /harness/imessage/ingest — never throws. */
export async function postIngest(
  deps: SensorDeps,
  config: SensorConfig,
  batch: readonly TransportEventWire[],
  cursor: IngestCursor,
): Promise<HttpResult<IngestReport>> {
  const { credentials, error } = await resolveOrError(deps);
  if (credentials === null) {
    return { ok: false, status: 0, body: null, error };
  }
  return postJson<IngestReport>(
    deps,
    `${config.apiUrl}/harness/imessage/ingest`,
    credentials,
    { batch, cursor },
  );
}

/** POST /harness/imessage/health — never throws. */
export async function postHealth(
  deps: SensorDeps,
  config: SensorConfig,
  health: SensorHealth,
  details?: Record<string, unknown>,
): Promise<HttpResult<unknown>> {
  const { credentials, error } = await resolveOrError(deps);
  if (credentials === null) {
    return { ok: false, status: 0, body: null, error };
  }
  return postJson<unknown>(
    deps,
    `${config.apiUrl}/harness/imessage/health`,
    credentials,
    {
      health_process: health.process,
      health_database: health.database,
      health_decoder: health.decoder,
      health_cursor: health.cursor,
      health_shadow: health.shadow,
      ...(details === undefined ? {} : { details }),
    },
  );
}

export interface CycleOutcome {
  /** A batch was accepted (2xx) and the cursor advanced. */
  readonly ingested: boolean;
  readonly rows: number;
  readonly resetDetected: boolean;
  readonly rebaselined: boolean;
  /** true when the cycle hit a failure that should grow the backoff. */
  readonly failed: boolean;
}

interface CycleContext {
  state: SensorRuntimeState;
  health: SensorHealth;
  consecutiveDecodeFailures: number;
  decoderStopped: boolean;
  /** true when a reset alert is unacknowledged (already alerted once). */
  resetAlerted: boolean;
  lastHeartbeatAt: number | null;
  schemaDrift: boolean;
  ingestFailing: boolean;
  /**
   * Paired-handle config cache (heartbeat response). Optional with a
   * fail-closed default: when absent, runSensorCycle installs an EMPTY
   * cache — no handle is ever paired, so no content is forwarded.
   */
  paired?: PairedHandleCache;
  /** log-once latch for a missing/invalid paired-handle config. */
  pairedConfigNotice?: boolean;
}

function healthEquals(a: SensorHealth, b: SensorHealth): boolean {
  return (
    a.process === b.process &&
    a.database === b.database &&
    a.decoder === b.decoder &&
    a.cursor === b.cursor &&
    a.shadow === b.shadow
  );
}

/**
 * Runs one full poll→ingest→health cycle against ctx (mutated in place).
 * Never throws: every failure degrades health + returns a failed outcome.
 */
export async function runSensorCycle(
  deps: SensorDeps,
  config: SensorConfig,
  ctx: CycleContext,
  now: () => number = Date.now,
): Promise<CycleOutcome> {
  const log = deps.log ?? (() => {});
  let ingested = false;
  let rows = 0;
  let resetDetected = false;
  let rebaselined = false;
  let failed = false;
  const details: Record<string, unknown> = {};
  ctx.paired ??= new PairedHandleCache();

  const { chat } = await openOrAlert(deps, config, ctx, details, now);
  if (chat === null) {
    failed = true;
    return { ingested, rows, resetDetected, rebaselined, failed };
  }

  try {
    const snapshot = chat.snapshot();
    details.max_rowid = snapshot.maxRowid;
    details.wal = snapshot.walPresent;
    details.shm = snapshot.shmPresent;

    // DB reset / replacement: max rowid below the stored cursor.
    if (snapshot.maxRowid < ctx.state.cursor_rowid) {
      const ack = config.rebaseline;
      if (ack !== null) {
        const target = ack === "explicit-max-rowid" ? snapshot.maxRowid : Math.min(ack, snapshot.maxRowid);
        log(
          `imessage-sensor: REBASELINE acknowledged (${ack}) — cursor ${ctx.state.cursor_rowid} → ${target}; ` +
            `the gap is deliberately skipped and audited here, never silently`,
        );
        ctx.state = {
          ...ctx.state,
          cursor_rowid: target,
          db_generation: snapshot.dbGeneration,
          schema_fingerprint: snapshot.schema.fingerprint,
        };
        saveSensorState(config.statePath, ctx.state);
        ctx.resetAlerted = false;
        rebaselined = true;
      } else {
        if (!ctx.resetAlerted) {
          log(
            `imessage-sensor: DB RESET DETECTED — max rowid ${snapshot.maxRowid} < cursor ` +
              `${ctx.state.cursor_rowid}; health_cursor=failed, forwarding STOPPED. Acknowledge with ` +
              `IMESSAGE_SENSOR_REBASELINE=explicit-max-rowid after inspecting (never silent)`,
          );
          ctx.resetAlerted = true;
        }
        ctx.health = { ...ctx.health, cursor: "failed" };
        details.reset = {
          cursor_rowid: ctx.state.cursor_rowid,
          max_rowid: snapshot.maxRowid,
          db_generation: snapshot.dbGeneration,
        };
        await heartbeat(deps, config, ctx, details, now, true);
        resetDetected = true;
        failed = true;
        return { ingested, rows, resetDetected, rebaselined, failed };
      }
    }

    // Schema gate: missing required tables/columns → database failed,
    // forwarding stopped (the poll query cannot be trusted), auditing kept.
    if (!snapshot.schema.ok) {
      if (ctx.health.database !== "failed") {
        log(
          `imessage-sensor: SCHEMA DRIFT — missing expected columns ${snapshot.schema.missing.join(", ")}; ` +
            `health_database=failed, forwarding stopped (auditing continues)`,
        );
      }
      ctx.health = { ...ctx.health, database: "failed" };
      details.schema_missing = snapshot.schema.missing;
      await heartbeat(deps, config, ctx, details, now);
      failed = true;
      return { ingested, rows, resetDetected, rebaselined, failed };
    }
    ctx.schemaDrift =
      ctx.state.schema_fingerprint !== null &&
      ctx.state.schema_fingerprint !== snapshot.schema.fingerprint;

    const poll = pollOnce(chat, ctx.state.cursor_rowid, config.batchCap, () => new Date(now()), ctx.paired);
    details.new_rows = poll.events.length;
    details.decode_attempted = poll.decodeAttempted;
    details.decode_failed = poll.decodeFailed;

    // Decoder drift: consecutive decode failures across decode-attempted
    // rows (rows that decode fine reset the run; not-attempted rows are
    // neutral — no decoder signal). The run persists across cycles.
    ctx.consecutiveDecodeFailures = poll.hasDecodeSuccess
      ? poll.decodeFailureTailRun
      : ctx.consecutiveDecodeFailures + poll.decodeFailed;

    const before = ctx.health;
    if (ctx.consecutiveDecodeFailures >= config.driftThreshold) {
      if (!ctx.decoderStopped) {
        log(
          `imessage-sensor: DECODER DRIFT — ${ctx.consecutiveDecodeFailures} consecutive decode failures ` +
            `(threshold ${config.driftThreshold}); health_decoder=failed, forwarding STOPPED (auditing continues; ` +
            `cursor frozen — backlog forwards on recovery)`,
        );
        ctx.decoderStopped = true;
      }
    } else if (ctx.decoderStopped && ctx.consecutiveDecodeFailures < config.driftThreshold) {
      log(
        `imessage-sensor: decoder recovered (${ctx.consecutiveDecodeFailures} consecutive failures) — resuming forwarding`,
      );
      ctx.decoderStopped = false;
    }
    // Decoder health is only reportable from cycles that ATTEMPTED ≥1
    // decode. An idle cycle (no attributedBody rows to decode) carries no
    // decoder evidence, so reporting a stale 'degraded' from a past
    // failure would show degraded forever on a quiet chat.db. Idle cycles
    // report 'healthy' — honest per-cycle semantics ("nothing is failing
    // now") — while the consecutive-failure RUN itself is preserved
    // across cycles for drift detection (a later failure still degrades,
    // and the threshold stop still latches). A drift STOP ('failed')
    // stays latched until an observed recovery decode clears it.
    const decoderDim: HealthDim = ctx.decoderStopped
      ? "failed"
      : poll.decodeAttempted === 0
        ? "healthy"
        : ctx.consecutiveDecodeFailures > 0
          ? "degraded"
          : "healthy";
    ctx.health = { ...ctx.health, decoder: decoderDim };
    if (!healthEquals(before, ctx.health)) details.health_transition = { from: before, to: ctx.health };

    const databaseDim: HealthDim = ctx.schemaDrift ? "degraded" : "healthy";
    ctx.health = { ...ctx.health, database: databaseDim };
    if (ctx.schemaDrift) {
      details.schema_fingerprint_changed = {
        stored: ctx.state.schema_fingerprint,
        current: poll.snapshot.schema.fingerprint,
      };
    }

    const schemaBlocked = !poll.snapshot.schema.ok;
    if (poll.events.length > 0 && !ctx.decoderStopped && !schemaBlocked) {
      const result = await postIngest(deps, config, poll.events, {
        rowid: poll.cursorRowid,
        db_generation: poll.snapshot.dbGeneration,
        schema_fingerprint: poll.snapshot.schema.fingerprint,
      });
      if (result.ok) {
        ctx.ingestFailing = false;
        ctx.state = {
          ...ctx.state,
          cursor_rowid: poll.cursorRowid,
          db_generation: poll.snapshot.dbGeneration,
          schema_fingerprint: poll.snapshot.schema.fingerprint,
          ever_own_observed: ctx.state.ever_own_observed || poll.ownObserved,
        };
        saveSensorState(config.statePath, ctx.state);
        ingested = true;
        rows = poll.events.length;
        details.accepted = result.body?.accepted ?? null;
        details.duplicates = result.body?.duplicates ?? null;
      } else {
        ctx.ingestFailing = true;
        log(`imessage-sensor: ingest failed: ${result.error ?? "unknown"} — cursor frozen, retrying next cycle`);
        await heartbeat(deps, config, ctx, { ...details, ingest_error: result.error }, now);
        rows = poll.events.length;
        failed = true;
        return { ingested, rows, resetDetected, rebaselined, failed };
      }
    }

    // Cursor health: "0 new messages" is never silently healthy while the
    // DB advances — a cursor stuck below max rowid degrades.
    const stuckBelowMax = ctx.state.cursor_rowid < poll.maxRowid;
    const cursorDim: HealthDim =
      stuckBelowMax && (ctx.decoderStopped || schemaBlocked || ctx.ingestFailing)
        ? "degraded"
        : "healthy";
    ctx.health = { ...ctx.health, cursor: cursorDim };

    // Shadow health: own deliveries observed + classified (hash computed).
    const shadowDim: HealthDim = ctx.state.ever_own_observed
      ? poll.ownDecodeFailure
        ? "degraded"
        : "healthy"
      : "degraded";
    ctx.health = { ...ctx.health, shadow: shadowDim };
    if (!ctx.state.ever_own_observed) details.shadow_note = "no own delivery observed yet";
    if (poll.ownDecodeFailure) details.own_decode_failure = true;

    await heartbeat(deps, config, ctx, details, now);
    return { ingested, rows, resetDetected, rebaselined, failed };
  } finally {
    chat.close();
  }
}

async function openOrAlert(
  deps: SensorDeps,
  config: SensorConfig,
  ctx: CycleContext,
  details: Record<string, unknown>,
  now: () => number,
): Promise<{ chat: ReturnType<typeof openChatDb> | null }> {
  const log = deps.log ?? (() => {});
  try {
    return { chat: openChatDb(config.dbPath) };
  } catch (err) {
    const message = err instanceof ChatDbError ? err.message : String(err);
    if (ctx.health.database !== "failed") {
      log(`imessage-sensor: chat.db OPEN FAILED: ${message} — health_database=failed`);
    }
    ctx.health = { ...ctx.health, database: "failed" };
    details.db_open_error = message;
    await heartbeat(deps, config, ctx, details, now, true);
    return { chat: null };
  }
}

/**
 * Posts health on any dim transition (immediately) or heartbeat cadence.
 * A failed health post is logged and survived — it must not stop ingest.
 * The response body IS the sensor config (paired_handles): applied on
 * every successful post; any missing/invalid body or failed post leaves
 * the cache EMPTY (fail closed — no content forwarding).
 */
async function heartbeat(
  deps: SensorDeps,
  config: SensorConfig,
  ctx: CycleContext,
  details: Record<string, unknown>,
  now: () => number,
  force = false,
): Promise<void> {
  const log = deps.log ?? (() => {});
  const t = now();
  const due = ctx.lastHeartbeatAt === null || t - ctx.lastHeartbeatAt >= config.heartbeatSeconds * 1000;
  if (!force && !due) return;
  const result = await postHealth(deps, config, ctx.health, details);
  if (result.ok) {
    ctx.lastHeartbeatAt = t;
    applyPairedHandleConfig(deps, ctx, result.body);
  } else {
    ctx.paired?.refresh([]);
    log(`imessage-sensor: health post failed: ${result.error ?? "unknown"}`);
  }
}

/** Applies the heartbeat-response config to the cache; fail closed on anything but a valid body. */
function applyPairedHandleConfig(deps: SensorDeps, ctx: CycleContext, body: unknown): void {
  const log = deps.log ?? (() => {});
  const parsed = parsePairedHandlesBody(body);
  if (parsed.ok) {
    ctx.paired?.refresh(parsed.handles);
    if (ctx.pairedConfigNotice === true) ctx.pairedConfigNotice = false;
    return;
  }
  ctx.paired?.refresh([]);
  if (ctx.pairedConfigNotice !== true) {
    ctx.pairedConfigNotice = true;
    log(
      parsed.reason === "absent"
        ? "imessage-sensor: health response carries no paired_handles config (old server, 204) — " +
            "paired-handle cache EMPTY, content forwarding OFF"
        : "imessage-sensor: health response paired_handles malformed — " +
            "paired-handle cache EMPTY, content forwarding OFF (fail closed)",
    );
  }
}

export interface LoopDeps extends SensorDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

const BACKOFF_CAP_MS = 60_000;

/**
 * The long-running loop: load state (loud first-run baseline; corrupt state
 * is a loud stop), cycle, sleep pollSeconds (exponential backoff capped at
 * 60s while cycles fail), repeat. `shouldStop` is checked between cycles
 * and every 250ms inside the sleep window (graceful SIGINT/SIGTERM).
 */
export async function runSensorLoop(
  deps: SensorDeps,
  config: SensorConfig,
  shouldStop: () => boolean,
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
): Promise<void> {
  const log = deps.log ?? (() => {});
  let state: SensorRuntimeState;
  try {
    const loaded = loadSensorState(config.statePath);
    if (loaded === null) {
      const baseline = await baselineAtMax(deps, config, now);
      if (baseline === null) {
        // First run with an unopenable DB: keep auditing loudly until the
        // DB opens (launchd keeps the process alive); no state is written.
        const ctx: CycleContext = {
          state: { cursor_rowid: 0, db_generation: null, schema_fingerprint: null, ever_own_observed: false, baselined_at: new Date(now()).toISOString() },
          health: { ...HEALTHY_START, database: "failed" },
          consecutiveDecodeFailures: 0,
          decoderStopped: false,
          resetAlerted: false,
          lastHeartbeatAt: null,
          schemaDrift: false,
          ingestFailing: false,
        };
        await runUntilStop(deps, config, ctx, shouldStop, sleep, now, log, true);
        return;
      }
      state = baseline;
    } else {
      state = loaded;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `imessage-sensor: STATE FILE ERROR: ${message} — refusing to run (auto-baseline over a corrupt ` +
        `state would be silent); inspect ${config.statePath}, fix or remove it deliberately, restart`,
    );
    return;
  }

  const ctx: CycleContext = {
    state,
    health: { ...HEALTHY_START, shadow: state.ever_own_observed ? "healthy" : "degraded" },
    consecutiveDecodeFailures: 0,
    decoderStopped: false,
    resetAlerted: false,
    lastHeartbeatAt: null,
    schemaDrift: false,
    ingestFailing: false,
    paired: new PairedHandleCache(),
  };
  // Startup config fetch: one health post whose response primes the
  // paired-handle cache BEFORE the first cycle classifies any rows (it
  // also satisfies the heartbeat cadence — the first cycle's periodic
  // heartbeat is not yet due). A failed post leaves the cache empty
  // (fail closed) and lastHeartbeatAt null → retried on cycle 1.
  await heartbeat(deps, config, ctx, { startup: true }, now, true);
  await runUntilStop(deps, config, ctx, shouldStop, sleep, now, log, false);
}

async function runUntilStop(
  deps: SensorDeps,
  config: SensorConfig,
  ctx: CycleContext,
  shouldStop: () => boolean,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  log: (message: string) => void,
  initialDbFailed: boolean,
): Promise<void> {
  let failures = initialDbFailed ? 1 : 0;
  while (!shouldStop()) {
    const outcome = await runSensorCycle(deps, config, ctx, now);
    if (config.once) return;
    failures = outcome.failed ? failures + 1 : 0;
    const wait = Math.min(config.pollSeconds * 1000 * 2 ** failures, BACKOFF_CAP_MS);
    if (failures > 0) log(`imessage-sensor: backing off ${wait}ms (${failures} consecutive failed cycles)`);
    const until = now() + wait;
    while (!shouldStop() && now() < until) {
      await sleep(Math.min(250, Math.max(0, until - now())));
    }
  }
}

/** First-run baseline: cursor = current max rowid (shadow starts now), loud. */
async function baselineAtMax(
  deps: SensorDeps,
  config: SensorConfig,
  now: () => number,
): Promise<SensorRuntimeState | null> {
  const log = deps.log ?? (() => {});
  try {
    const chat = openChatDb(config.dbPath);
    try {
      const snapshot = chat.snapshot();
      const state: SensorRuntimeState = {
        cursor_rowid: snapshot.maxRowid,
        db_generation: snapshot.dbGeneration,
        schema_fingerprint: snapshot.schema.ok ? snapshot.schema.fingerprint : null,
        ever_own_observed: false,
        baselined_at: new Date(now()).toISOString(),
      };
      saveSensorState(config.statePath, state);
      log(
        `imessage-sensor: first run — baselining cursor at max rowid ${state.cursor_rowid} ` +
          `(history before now is deliberately not forwarded; state: ${config.statePath})`,
      );
      return state;
    } finally {
      chat.close();
    }
  } catch {
    return null;
  }
}

export type { CycleContext, ChatDbSnapshot };
