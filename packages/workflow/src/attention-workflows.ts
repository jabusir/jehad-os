/**
 * attention-liveness (W1; ADR-0018 §4, w1-contract "Delivery"): the
 * resolver backstop + delivery retry, every 5 minutes.
 *
 * Steps (per contract):
 *   1. kill switch  — policy.yaml `attention.enabled !== false` (absent
 *      section runs: the contract's switch is explicitly !== false).
 *   2. livenessSweep — resolver pass over open/seen items (gone → resolve
 *      by 'liveness'; unknown never closes) + terminal-row GC, per the
 *      frozen service contract for livenessSweep itself.
 *   3. retryEligibleUndelivered — ONLY inside local hours 07:00–22:00
 *      America/Los_Angeles (the brief-workflows local-hour guard pattern:
 *      DST-safe via Intl, never a UTC-pinned window; every off-window
 *      firing is a clean no-op).
 *   4. terminal GC — rides livenessSweep (step 2) per the service contract
 *      (resolved/dismissed rows retained ATTENTION_TERMINAL_RETENTION_DAYS,
 *      chunked); no second writer here.
 *
 * POLICY: loaded module-relative exactly like loadCalibrationPolicy (THREE
 * directory ups from packages/workflow/src reach the repo root;
 * POLICY_YAML_PATH overrides for tests). `attention.cooldownMinutes` feeds
 * the retry loop's salience cooldown.
 *
 * Each firing builds its own pg pool from DATABASE_URL inside a memoized
 * step (short-lived, closed in finally) like every scheduled workflow in
 * this package.
 */

import { Pool } from "pg";
import {
  livenessSweep,
  parsePolicyV1,
  retryEligibleUndelivered,
  type AttentionDeliveryConfig,
} from "@jehad/core";
import { BRIEF_LOCAL_TZ } from "./brief-workflows.js";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";

export const ATTENTION_LIVENESS_CRON = "*/5 * * * *";
/** Local retry window (owner timezone): [07:00, 22:00) — alert hours only. */
export const ATTENTION_RETRY_LOCAL_START_HOUR = 7;
export const ATTENTION_RETRY_LOCAL_END_HOUR = 22; // exclusive
export const ATTENTION_LIVENESS_ACTOR = "system:attention-liveness";

/** policy.yaml `attention:` — kill switch + retry cooldown. */
export interface AttentionPolicy {
  readonly enabled: boolean;
  readonly cooldownMinutes: number;
}

/** Contract-literal defaults: `attention.enabled !== false` ⇒ absent runs. */
export const DEFAULT_ATTENTION_POLICY: AttentionPolicy = { enabled: true, cooldownMinutes: 60 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The effective attention policy: the parsed `policy.attention` section when
 * well-shaped, else the contract defaults. Tolerant on key spelling
 * (cooldownMinutes | cooldown_minutes); anything off degrades to the
 * default cooldown, never to a disabled (or enabled) flip.
 */
export function attentionPolicyOf(policy: unknown): AttentionPolicy {
  const section = (policy as { attention?: unknown } | null | undefined)?.attention;
  if (!isPlainObject(section)) return DEFAULT_ATTENTION_POLICY;
  const rawCooldown = section["cooldownMinutes"] ?? section["cooldown_minutes"];
  const cooldownMinutes =
    typeof rawCooldown === "number" && Number.isInteger(rawCooldown) && rawCooldown > 0
      ? rawCooldown
      : DEFAULT_ATTENTION_POLICY.cooldownMinutes;
  return { enabled: section["enabled"] !== false, cooldownMinutes };
}

/** Mirrors loadCalibrationPolicy EXACTLY (module-relative, env override,
 *  any failure → the contract defaults — the kill switch is !== false). */
export async function loadAttentionPolicy(): Promise<AttentionPolicy> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // THREE ups from src/ = repo root (cwd-independent — the LaunchAgent
    // worker runs from /).
    const moduleDefault = resolve(
      fileURLToPath(new URL("../../../policy.yaml", import.meta.url)),
    );
    const file = process.env.POLICY_YAML_PATH ?? moduleDefault;
    return attentionPolicyOf(parsePolicyV1(await readFile(file, "utf8")));
  } catch {
    return DEFAULT_ATTENTION_POLICY;
  }
}

/** Wall-clock hour of `now` in the owner timezone (DST-safe via Intl). */
export function localAttentionRetryHour(date: Date, timeZone: string = BRIEF_LOCAL_TZ): number {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(date),
  );
  return hour % 24; // hourCycle quirk: 24 for midnight in some engines
}

/** Pure local-window check: [07:00, 22:00) PT. Exported for tests. */
export function isAttentionRetryLocalHour(date: Date, timeZone: string = BRIEF_LOCAL_TZ): boolean {
  const hour = localAttentionRetryHour(date, timeZone);
  return hour >= ATTENTION_RETRY_LOCAL_START_HOUR && hour < ATTENTION_RETRY_LOCAL_END_HOUR;
}

/** Injected core seams (tests); defaults are the real @jehad/core calls. */
export interface AttentionLivenessDeps {
  readonly sweep?: (
    db: Parameters<typeof livenessSweep>[0],
    opts: { now: Date; cap?: number },
  ) => Promise<{ checked: number; resolved: number }>;
  readonly retry?: (
    db: Parameters<typeof retryEligibleUndelivered>[0],
    opts: { now: Date; config?: AttentionDeliveryConfig },
  ) => Promise<number>;
}

export interface AttentionLivenessResult {
  /** "disabled" — kill switch (clean no-op, no step ran). */
  readonly status: "disabled" | "completed";
  /** True when the retry step was skipped as off-window (07:00–22:00 PT). */
  readonly skippedWindow?: boolean;
  readonly sweep?: { checked: number; resolved: number };
  readonly retried?: number;
}

/**
 * One liveness tick against an explicit db executor — hermetic and
 * injectable (policy + core seams); the workflow body wraps it in a pool.
 */
export async function runAttentionLivenessTick(
  db: Parameters<typeof livenessSweep>[0],
  opts: { now?: Date; policy?: AttentionPolicy; deps?: AttentionLivenessDeps; config?: AttentionDeliveryConfig } = {},
): Promise<AttentionLivenessResult> {
  const policy = opts.policy ?? (await loadAttentionPolicy());
  if (policy.enabled === false) {
    console.log(JSON.stringify({ workflow: "attention-liveness", status: "disabled" }));
    return { status: "disabled" };
  }
  const now = opts.now ?? new Date();
  const sweep = opts.deps?.sweep ?? livenessSweep;
  const retry = opts.deps?.retry ?? retryEligibleUndelivered;
  const sweepResult = await sweep(db, { now });
  const inWindow = isAttentionRetryLocalHour(now);
  let retried = 0;
  if (inWindow) {
    retried = await retry(db, { now, config: { cooldownMinutes: policy.cooldownMinutes, ...opts.config } });
  }
  const result: AttentionLivenessResult = {
    status: "completed",
    skippedWindow: !inWindow,
    sweep: sweepResult,
    retried,
  };
  console.log(
    JSON.stringify({
      workflow: "attention-liveness",
      status: result.status,
      checked: sweepResult.checked,
      resolved: sweepResult.resolved,
      retried,
      skippedWindow: !inWindow,
    }),
  );
  return result;
}

async function tickWithPool(): Promise<AttentionLivenessResult> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    return await runAttentionLivenessTick(pool);
  } finally {
    await pool.end();
  }
}

export const attentionLivenessWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "attention-liveness",
  cron: ATTENTION_LIVENESS_CRON,
  fn: async (ctx): Promise<AttentionLivenessResult> =>
    ctx.step.run("attention-liveness-tick", () => tickWithPool()),
});
