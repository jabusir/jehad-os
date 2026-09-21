/**
 * Scheduled calibration workflows (lane C2): the daily prompt
 * ("calibration-daily", plan §15) and the weekly rollup
 * ("calibration-weekly"). The domain (item lifecycle, rollup rendering)
 * is lane C1's in packages/core; this file owns the cron wiring, the
 * local-hour guards, and the notification enqueue — coding against C1's
 * contract via calibration-contract.d.ts until that lane merges.
 *
 * TIME-WINDOW SEMANTICS (brief-workflows pattern): the executor's cron
 * granularity is per-minute and evaluates in UTC; the workflow bodies
 * render/send only inside their LOCAL windows (owner timezone, DST-safe
 * via Intl — no UTC-offset math). The daily prompt fires at :30 past the
 * hour (cron "30 * * * *") with an hour guard equal to the policy's
 * `prompt_local_hour` (default 20 → 20:30 local); every other firing is
 * a no-op before any step. The weekly rollup keeps the briefs' hourly
 * cron and selects Sunday 20:00 local via the guard (localHour === 20 &&
 * localWeekday === 0) — a UTC-pinned Sunday cron would drift across DST
 * and can never even hit 20:00 PT Sunday (that is 03:00 UTC Monday).
 *
 * §15: the daily prompt sends INDEPENDENT of the evening close
 * suppression — this workflow never consults it (calibration asks the
 * owner to rate the day; it is not a brief).
 *
 * POLICY: `policy.calibration { enabled, principals, prompt_local_hour }`
 * (repo-root policy.yaml, loaded module-relative exactly like
 * loadGmailSensorPolicy — THREE directory ups from packages/workflow/src
 * reach the repo root; the two-up variant bit this repo twice). Until
 * lane C1's parser section lands, a policy.yaml carrying a `calibration:`
 * key fails parsePolicyV1 (strict, fail-closed) and the loader falls
 * back to the disabled default — the kill switch holds. Defaults are
 * fail-safe: disabled, no principals, 20:00 local.
 *
 * Each firing builds its own pg pool from DATABASE_URL inside a memoized
 * step (short-lived, closed in finally) like every scheduled workflow in
 * this package.
 */

import { Pool } from "pg";
import {
  createNotification,
  openDailyCalibration,
  parsePolicyV1,
  runWeeklyCalibrationRollup,
  type SqlExecutor,
} from "@jehad/core";
import { BRIEF_LOCAL_TZ, isLocalHour } from "./brief-workflows.js";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";

/** Owner timezone — same as briefs (core: briefs/timezone). */
export const CALIBRATION_LOCAL_TZ = BRIEF_LOCAL_TZ;
/** Default daily-prompt local hour (policy `prompt_local_hour`; 20 → 8 PM). */
export const CALIBRATION_PROMPT_LOCAL_HOUR_DEFAULT = 20;
/** The :30 of "20:30 local" — pinned by the cron, not the guard. */
export const CALIBRATION_PROMPT_CRON_MINUTE = 30;
/** Weekly rollup window: Sunday (0) at 20:00 local. */
export const CALIBRATION_WEEKLY_LOCAL_HOUR = 20;
export const CALIBRATION_WEEKLY_LOCAL_WEEKDAY = 0;

/** The workflow's service identity (notification created_by, audit actor). */
export const CALIBRATION_SERVICE_PRINCIPAL = "service/calibration";
export const CALIBRATION_SERVICE_ACTOR = "service:calibration";
export const CALIBRATION_DOMAIN_KEY = "personal";

export interface CalibrationPolicy {
  /** Kill switch: false (or absent section) → clean no-op tick. */
  readonly enabled: boolean;
  /** Principal NAMES (policy-facing); resolved to ids per tick. */
  readonly principals: readonly string[];
  /** Local hour the daily prompt fires; the cron pins the :30 minute. */
  readonly promptLocalHour: number;
}

/** Fail-safe defaults — disabled until the owner ratifies the section. */
export const DEFAULT_CALIBRATION_POLICY: CalibrationPolicy = {
  enabled: false,
  principals: [],
  promptLocalHour: CALIBRATION_PROMPT_LOCAL_HOUR_DEFAULT,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The effective calibration policy: the parsed `policy.calibration`
 * section when present and well-shaped, else the fail-safe defaults.
 * Tolerant on key spelling (prompt_local_hour | promptLocalHour) so the
 * workflow survives C1's final parser naming; anything off degrades to
 * disabled, never to a broader firing.
 */
export function calibrationPolicyOf(policy: unknown): CalibrationPolicy {
  const section = (policy as { calibration?: unknown } | null | undefined)?.calibration;
  if (!isPlainObject(section)) return DEFAULT_CALIBRATION_POLICY;
  const principals = Array.isArray(section.principals)
    ? section.principals.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    : [];
  const rawHour = section.promptLocalHour ?? section.prompt_local_hour;
  const promptLocalHour =
    typeof rawHour === "number" && Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23
      ? rawHour
      : CALIBRATION_PROMPT_LOCAL_HOUR_DEFAULT;
  return { enabled: section.enabled === true, principals, promptLocalHour };
}

/** Pure local hour+weekday check in the owner's timezone (DST-safe). */
export function isLocalWeekdayHour(
  date: Date,
  hour: number,
  weekday: number,
  timeZone = CALIBRATION_LOCAL_TZ,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    hour12: false,
    timeZone,
  }).formatToParts(date);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value;
  const localHour = Number(parts.find((p) => p.type === "hour")?.value);
  return localHour === hour && weekdayName === ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday];
}

/** Mirrors loadGmailSensorPolicy EXACTLY (module-relative, env override,
 *  any failure → fail-safe defaults). See the file-header policy note. */
export async function loadCalibrationPolicy(): Promise<CalibrationPolicy> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // Module-relative like every other policy loader (cwd-independent —
    // the LaunchAgent worker runs from /). THREE ups from src/ = repo root.
    const moduleDefault = resolve(
      fileURLToPath(new URL("../../../policy.yaml", import.meta.url)),
    );
    const file = process.env.POLICY_YAML_PATH ?? moduleDefault;
    return calibrationPolicyOf(parsePolicyV1(await readFile(file, "utf8")));
  } catch {
    return DEFAULT_CALIBRATION_POLICY;
  }
}

export interface CalibrationPrincipalOutcome {
  readonly principal: string;
  /** Daily: did THIS tick open the calibration item (false → send skipped)? */
  readonly created?: boolean;
  /** Weekly: content rendered and notification enqueued. */
  readonly sent?: boolean;
  readonly skipped?: string;
  readonly daysRated?: number;
}

export interface CalibrationTickResult {
  /** "disabled" — kill switch or empty principal list (clean no-op). */
  readonly status?: "disabled";
  readonly outcomes?: readonly CalibrationPrincipalOutcome[];
}

/** True when the tick has nothing to do (no policy-driven sends at all). */
function isNoOp(policy: CalibrationPolicy): boolean {
  return !policy.enabled || policy.principals.length === 0;
}

function resolveNow(now?: Date | (() => Date)): () => Date {
  if (now === undefined) return () => new Date();
  return now instanceof Date ? () => now : now;
}

/** Resolve a policy principal NAME to its id; null when unknown. */
async function principalIdOf(db: SqlExecutor, name: string): Promise<string | null> {
  const found = await db.query("SELECT id FROM principals WHERE name = $1 LIMIT 1", [name]);
  const id = found.rows[0]?.id;
  return id === undefined ? null : String(id);
}

// Resolve-or-create the service principal (notifications service pattern:
// idempotent upsert on the UNIQUE name).
const SERVICE_PRINCIPAL_UPSERT = `
  WITH ins AS (
    INSERT INTO principals (type, name) VALUES ('service', $1)
    ON CONFLICT (name) DO NOTHING
    RETURNING id
  )
  SELECT id FROM ins
  UNION ALL
  SELECT id FROM principals WHERE name = $1
  LIMIT 1
`;

export interface CalibrationSendInput {
  readonly title: string;
  /** Policy principal name (provenance in the payload; never content-free-only). */
  readonly principal: string;
  /** Daily: the calibration item id (source linkage); weekly: none. */
  readonly itemId?: string;
  /** The rendered content — delivered verbatim by the edge, NEVER logged. */
  readonly content: string;
  readonly now?: Date | (() => Date);
}

/**
 * Enqueue the calibration notification through the existing core
 * notifications service: kind=custom (owner-review queue — calibration is
 * not on the auto-approve list), sourceType=run (workflow-produced),
 * sourceId=itemId on the daily path. RECONCILIATION POINT (lane C1):
 * if C1 ships a dedicated producer hook (enqueueCalibrationNotification
 * or similar), swap this body to it — one call site, two tests.
 */
export async function sendCalibrationNotification(
  db: SqlExecutor,
  input: CalibrationSendInput,
): Promise<string> {
  const now = resolveNow(input.now);
  const service = await db.query(SERVICE_PRINCIPAL_UPSERT, [CALIBRATION_SERVICE_PRINCIPAL]);
  const createdBy = service.rows[0]?.id;
  if (createdBy === undefined) {
    throw new Error("calibration: could not resolve the service principal");
  }
  const domain = await db.query("SELECT id FROM domains WHERE key = $1 LIMIT 1", [
    CALIBRATION_DOMAIN_KEY,
  ]);
  const domainId = domain.rows[0]?.id;
  const notification = await createNotification(
    db,
    {
      kind: "custom",
      title: input.title,
      payload: {
        principal: input.principal,
        ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
        content: input.content,
      },
      domainId: domainId === undefined ? null : String(domainId),
      sourceType: "run",
      sourceId: input.itemId ?? null,
      createdBy: String(createdBy),
    },
    { actor: CALIBRATION_SERVICE_ACTOR, now },
  );
  return notification.id;
}

/**
 * One daily-prompt tick against an injected executor: for each policy
 * principal, open (idempotently) the day's calibration item and enqueue
 * the prompt notification when THIS call created it. Content never
 * enters the tick log — principal names and booleans only.
 */
export async function runDailyCalibrationTick(
  db: SqlExecutor,
  opts: { policy?: CalibrationPolicy; now?: Date | (() => Date) } = {},
): Promise<CalibrationTickResult> {
  const policy = opts.policy ?? (await loadCalibrationPolicy());
  if (isNoOp(policy)) {
    console.log(JSON.stringify({ workflow: "calibration-daily", status: "disabled" }));
    return { status: "disabled" };
  }
  const now = resolveNow(opts.now);
  const outcomes: CalibrationPrincipalOutcome[] = [];
  for (const name of policy.principals) {
    const principalId = await principalIdOf(db, name);
    if (principalId === null) {
      console.log(
        JSON.stringify({ workflow: "calibration-daily", principal: name, skipped: "principal-not-found" }),
      );
      outcomes.push({ principal: name, skipped: "principal-not-found" });
      continue;
    }
    const opened = await openDailyCalibration(db, { principalId, now: now() });
    if (!opened.created) {
      // Idempotent replay (executor retry / double fire): the item already
      // exists, the send is skipped — no duplicate notification.
      console.log(JSON.stringify({ workflow: "calibration-daily", principal: name, created: false }));
      outcomes.push({ principal: name, created: false });
      continue;
    }
    await sendCalibrationNotification(db, {
      title: "Daily calibration",
      principal: name,
      itemId: opened.itemId,
      content: opened.prompt,
      now,
    });
    console.log(JSON.stringify({ workflow: "calibration-daily", principal: name, created: true }));
    outcomes.push({ principal: name, created: true, sent: true });
  }
  return { outcomes };
}

/**
 * One weekly-rollup tick: render the week's rollup per principal and
 * enqueue it only when there is enough rated data (content null → skip
 * send, tick-log the shortfall count).
 */
export async function runWeeklyCalibrationTick(
  db: SqlExecutor,
  opts: { policy?: CalibrationPolicy; now?: Date | (() => Date) } = {},
): Promise<CalibrationTickResult> {
  const policy = opts.policy ?? (await loadCalibrationPolicy());
  if (isNoOp(policy)) {
    console.log(JSON.stringify({ workflow: "calibration-weekly", status: "disabled" }));
    return { status: "disabled" };
  }
  const now = resolveNow(opts.now);
  const outcomes: CalibrationPrincipalOutcome[] = [];
  for (const name of policy.principals) {
    const principalId = await principalIdOf(db, name);
    if (principalId === null) {
      console.log(
        JSON.stringify({ workflow: "calibration-weekly", principal: name, skipped: "principal-not-found" }),
      );
      outcomes.push({ principal: name, skipped: "principal-not-found" });
      continue;
    }
    const rollup = await runWeeklyCalibrationRollup(db, { principalId, now: now() });
    if (rollup.content === null) {
      console.log(
        JSON.stringify({
          workflow: "calibration-weekly",
          principal: name,
          daysRated: rollup.daysRated,
          skipped: "insufficient-data",
        }),
      );
      outcomes.push({ principal: name, daysRated: rollup.daysRated, skipped: "insufficient-data" });
      continue;
    }
    await sendCalibrationNotification(db, {
      title: "Weekly calibration rollup",
      principal: name,
      content: rollup.content,
      now,
    });
    console.log(
      JSON.stringify({
        workflow: "calibration-weekly",
        principal: name,
        daysRated: rollup.daysRated,
        sent: true,
      }),
    );
    outcomes.push({ principal: name, daysRated: rollup.daysRated, sent: true });
  }
  return { outcomes };
}

async function calibrationWithPool<T>(run: (db: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

export const calibrationPromptWorkflow = defineScheduledWorkflow({
  name: "calibration-daily",
  cron: `${CALIBRATION_PROMPT_CRON_MINUTE} * * * *`,
  fn: async (ctx): Promise<CalibrationTickResult | { skippedWindow: true }> => {
    // The guard hour IS the policy's prompt_local_hour (default 20) —
    // loaded before the guard so an owner tuning the yaml moves the
    // window without a redeploy.
    const policy = await loadCalibrationPolicy();
    if (!isLocalHour(new Date(), policy.promptLocalHour)) return { skippedWindow: true };
    return ctx.step.run("calibration-daily-tick", () =>
      calibrationWithPool((db) => runDailyCalibrationTick(db, { policy, now: new Date() })),
    );
  },
});

export const calibrationWeeklyWorkflow = defineScheduledWorkflow({
  name: "calibration-weekly",
  cron: "0 * * * *",
  fn: async (ctx): Promise<CalibrationTickResult | { skippedWindow: true }> => {
    if (
      !isLocalWeekdayHour(
        new Date(),
        CALIBRATION_WEEKLY_LOCAL_HOUR,
        CALIBRATION_WEEKLY_LOCAL_WEEKDAY,
      )
    ) {
      return { skippedWindow: true };
    }
    return ctx.step.run("calibration-weekly-tick", () =>
      calibrationWithPool((db) => runWeeklyCalibrationTick(db, { now: new Date() })),
    );
  },
});

/** Registration export for the worker (brief-workflows wire-up pattern). */
export const calibrationWorkflows: readonly ScheduledWorkflowDefinition[] = [
  calibrationPromptWorkflow,
  calibrationWeeklyWorkflow,
];
