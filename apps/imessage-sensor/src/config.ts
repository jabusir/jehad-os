// imessage-sensor configuration (gateway Phase A — docs/plans/imessage-gateway.md
// §4.2, §7 row A; docs/plans/ig-phase-a-contracts.md Lane D).
//
// Every knob is an environment variable; NOTHING secret-shaped is ever
// logged (the bearer credential and capability token are read at use time
// and passed through headers only). The sensor is a boring daemon: read
// chat.db read-only, classify, POST transport METADATA to the ingest
// surface, heartbeat five health dims. It never writes the Messages DB.
//
// ┌─────────────────────────────────────┬────────────────────────────────────────────┐
// │ SENSOR_API_URL                      │ Jehad OS API base. Default http://127.0.0.1:3000 │
// │ IMESSAGE_SENSOR_PRINCIPAL           │ Harness principal — the Keychain account    │
// │                                     │ under service `jehad-os`. Default           │
// │                                     │ `imessage-sensor`.                          │
// │ IMESSAGE_SENSOR_POLL_SECONDS        │ Read cadence, 1–5s (plan §7 caps at 5).     │
// │                                     │ Default 5.                                  │
// │ IMESSAGE_SENSOR_HEARTBEAT_SECONDS   │ Health heartbeat cadence. Default 30.       │
// │ IMESSAGE_SENSOR_BATCH_CAP           │ Max rows per ingest batch (server hard cap │
// │                                     │ 1000). Default 500.                         │
// │ IMESSAGE_SENSOR_DRIFT_THRESHOLD     │ Consecutive decode failures that trip       │
// │                                     │ health_decoder=failed (STOP forwarding).   │
// │                                     │ Default 20.                                 │
// │ IMESSAGE_SENSOR_DB_PATH             │ chat.db path override (tests/diagnostics). │
// │ IMESSAGE_SENSOR_STATE_PATH          │ Cursor state file override.                 │
// │ IMESSAGE_SENSOR_REBASELINE          │ DB-reset acknowledgement (one-shot): the    │
// │                                     │ literal `explicit-max-rowid` re-baselines  │
// │                                     │ to the current max(rowid); a number sets   │
// │                                     │ that explicit rowid. Unset = loud stop.    │
// │ SENSOR_CAPABILITY_TOKEN             │ Capability token override; else Keychain   │
// │                                     │ `jehad-os-grants` / `imessage:ingest`.      │
// └─────────────────────────────────────┴────────────────────────────────────────────┘
//
// CLI: `--once` runs exactly one poll/ingest/heartbeat cycle (diagnostics);
// the default is a long-running loop with SIGINT/SIGTERM graceful shutdown.

export interface SensorConfig {
  readonly apiUrl: string;
  readonly principal: string;
  readonly pollSeconds: number;
  readonly heartbeatSeconds: number;
  readonly batchCap: number;
  readonly driftThreshold: number;
  readonly dbPath: string;
  readonly statePath: string;
  readonly rebaseline: number | "explicit-max-rowid" | null;
  readonly once: boolean;
}

/** Server-side hard limit (packages/core MAX_IMESSAGE_INGEST_BATCH). */
export const MAX_SERVER_BATCH = 1000;
/** Plan §7: sensor read cadence must stay ≤ 5s (Phase B latency math). */
export const MAX_POLL_SECONDS = 5;

const DEFAULT_API_URL = "http://127.0.0.1:3000";
const DEFAULT_PRINCIPAL = "imessage-sensor";
const DEFAULT_POLL_SECONDS = 5;
const DEFAULT_HEARTBEAT_SECONDS = 30;
const DEFAULT_BATCH_CAP = 500;
const DEFAULT_DRIFT_THRESHOLD = 20;

export const KEYCHAIN_BEARER_SERVICE = "jehad-os";
export const KEYCHAIN_GRANT_SERVICE = "jehad-os-grants";
export const KEYCHAIN_GRANT_ACCOUNT = "imessage:ingest";

export const REBASELINE_MAX_TOKEN = "explicit-max-rowid";

function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  max?: number,
): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    const bound = max === undefined ? ">= 1" : `between 1 and ${max}`;
    throw new Error(`config: ${name} must be an integer ${bound} (got "${raw}")`);
  }
  return value;
}

export function defaultDbPath(env: Record<string, string | undefined>, home: string): string {
  return env["IMESSAGE_SENSOR_DB_PATH"] ?? `${home}/Library/Messages/chat.db`;
}

export function defaultStatePath(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return (
    env["IMESSAGE_SENSOR_STATE_PATH"] ??
    `${home}/Library/Application Support/jehad-os/imessage-sensor-state.json`
  );
}

export function loadConfig(
  env: Record<string, string | undefined>,
  argv: readonly string[],
  home: string = defaultHome(),
): SensorConfig {
  const apiUrl = (env["SENSOR_API_URL"] ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const principal = env["IMESSAGE_SENSOR_PRINCIPAL"] ?? DEFAULT_PRINCIPAL;
  if (principal.trim().length === 0) {
    throw new Error("config: IMESSAGE_SENSOR_PRINCIPAL must not be blank");
  }
  const pollSeconds = positiveInt(env, "IMESSAGE_SENSOR_POLL_SECONDS", DEFAULT_POLL_SECONDS, MAX_POLL_SECONDS);
  const heartbeatSeconds = positiveInt(env, "IMESSAGE_SENSOR_HEARTBEAT_SECONDS", DEFAULT_HEARTBEAT_SECONDS);
  const batchCap = positiveInt(env, "IMESSAGE_SENSOR_BATCH_CAP", DEFAULT_BATCH_CAP, MAX_SERVER_BATCH);
  const driftThreshold = positiveInt(env, "IMESSAGE_SENSOR_DRIFT_THRESHOLD", DEFAULT_DRIFT_THRESHOLD);
  const rebaselineRaw = env["IMESSAGE_SENSOR_REBASELINE"];
  let rebaseline: number | "explicit-max-rowid" | null = null;
  if (rebaselineRaw !== undefined && rebaselineRaw !== "") {
    if (rebaselineRaw === REBASELINE_MAX_TOKEN) {
      rebaseline = REBASELINE_MAX_TOKEN;
    } else {
      const parsed = Number(rebaselineRaw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(
          `config: IMESSAGE_SENSOR_REBASELINE must be "${REBASELINE_MAX_TOKEN}" or a non-negative integer (got "${rebaselineRaw}")`,
        );
      }
      rebaseline = parsed;
    }
  }
  return {
    apiUrl,
    principal,
    pollSeconds,
    heartbeatSeconds,
    batchCap,
    driftThreshold,
    dbPath: defaultDbPath(env, home),
    statePath: defaultStatePath(env, home),
    rebaseline,
    once: argv.includes("--once"),
  };
}

function defaultHome(): string {
  const home = process.env["HOME"];
  if (home === undefined || home.length === 0) {
    throw new Error("config: HOME is not set and no path override was provided");
  }
  return home;
}
