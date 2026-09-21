// packages/core/src/imessage/deep-budget.ts — W3 per-day DEEP-tier budget
// guard (plan §7 W3, §8 R4, §13).
//
// The DEEP/day cap is DERIVED from the ratified monthly envelope, never
// hardcoded: cap = 0.5 × (envelope_soft / 30) USD. The envelope comes from
// MODEL_BUDGET_SOFT_USD / the budget module's ratified defaults (plan
// §18-1: $40 soft during the proving phase) — changing the envelope changes
// the DEEP cap with zero code edits.
//
// Tier discriminator: DEEP-tier answer calls are ledgered in `model_calls`
// with a `:deep` prompt_version suffix (e.g. "imessage-converse-v2:deep").
// Chosen over a schema change — migrations for a single enum column are
// not warranted in W3; the suffix is the documented convention the
// orchestrator stamps at dispatch (`deepPromptVersion`). FAST/STANDARD
// calls ride their base prompt version unsuffixed.
//
// This guard NEVER throws on exhaustion — exceeding the cap downgrades the
// turn's tier to standard via the return value (policy §8: budgets are
// runaway-guardrails; sustained overshoot is an envelope decision made
// with ledger evidence, never a crash and never a silent answer failure).

import { modelBudgetFromEnv } from "../model/budget.js";
import type { SqlExecutor } from "../policy/grants.js";

/** Prompt-version suffix marking a DEEP-tier answer call in the ledger. */
export const DEEP_PROMPT_VERSION_SUFFIX = ":deep";

/** The base prompt version for a DEEP-tier answer call. */
export function deepPromptVersion(basePromptVersion: string): string {
  return `${basePromptVersion}${DEEP_PROMPT_VERSION_SUFFIX}`;
}

/** DEEP share of the derived daily planning number (plan §13: ≤0.5×). */
export const DEEP_BUDGET_FRACTION_OF_DAILY = 0.5;

/** Days in the envelope month the daily planning number divides over. */
export const ENVELOPE_DAYS = 30;

/**
 * The per-day DEEP spend cap in USD: 0.5 × (envelope_soft / 30). Reads
 * MODEL_BUDGET_SOFT_USD via the budget module (misconfiguration fails
 * closed and loud there, before any dispatch).
 */
export function deepDailyCapUsd(
  env: Record<string, string | undefined> = process.env,
): number {
  return (modelBudgetFromEnv(env).softUsd / ENVELOPE_DAYS) * DEEP_BUDGET_FRACTION_OF_DAILY;
}

/** UTC-day-start boundary for `now` (deterministic, session-TZ-proof). */
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface DeepBudgetState {
  /** Finalized DEEP-tier model_calls rows today (UTC day), reserved excluded. */
  readonly deepCallsToday: number;
  /** Their summed cost_usd. */
  readonly spentUsd: number;
  /** 0.5 × (envelope_soft / 30) — the derived DEEP/day cap. */
  readonly capUsd: number;
  readonly remainingUsd: number;
  /** False once spent >= cap → the turn runs at STANDARD instead. */
  readonly allowDeep: boolean;
  /** The tier this turn should run at after the guard. */
  readonly effectiveTier: "deep" | "standard";
  readonly reason: "within-budget" | "daily-deep-cap-exceeded";
}

/**
 * Counts today's DEEP-tier spend from the `model_calls` ledger and decides
 * whether a DEEP turn may run. Never throws on budget exhaustion — the
 * downgrade is the return value, so the caller logs and proceeds.
 *
 * `result_status = 'reserved'` rows are excluded: a reservation
 * provisionally holds the ENTIRE remaining monthly hard-cap headroom
 * (call-model.ts race protocol), not its eventual actual cost — counting
 * reservations would over-state DEEP spend by orders of magnitude.
 */
export async function deepBudgetState(
  db: SqlExecutor,
  opts: { readonly now: Date; readonly env?: Record<string, string | undefined> },
): Promise<DeepBudgetState> {
  const capUsd = deepDailyCapUsd(opts.env);
  const result = await db.query(
    `SELECT COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0) AS spent
       FROM model_calls
      WHERE created_at >= $1::timestamptz
        AND prompt_version LIKE $2
        AND result_status <> 'reserved'`,
    [utcDayStart(opts.now).toISOString(), `%${DEEP_PROMPT_VERSION_SUFFIX}`],
  );
  const deepCallsToday = Number(result.rows[0]?.calls ?? 0);
  const spentUsd = Number(result.rows[0]?.spent ?? 0);
  const allowDeep = spentUsd < capUsd;
  return {
    deepCallsToday,
    spentUsd: Number.isFinite(spentUsd) ? spentUsd : 0,
    capUsd,
    remainingUsd: Math.max(0, capUsd - spentUsd),
    allowDeep,
    effectiveTier: allowDeep ? "deep" : "standard",
    reason: allowDeep ? "within-budget" : "daily-deep-cap-exceeded",
  };
}
