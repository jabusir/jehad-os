// Model-spend budget (A13: $20 soft / $50 hard monthly caps from tito Q7,
// kernel-wide initially; plan §17 A13). Caps are read from the environment
// so tightening is configuration, not a code change. Spend is the
// `model_calls` cost ledger — the same table the caps police (plan §13:
// `pnpm eval` spend is recorded against the A13 caps).

import type { SqlExecutor } from "../policy/grants.js";

/** Monthly USD caps. `softUsd` warns; `hardUsd` denies before dispatch. */
export interface ModelBudget {
  readonly softUsd: number;
  readonly hardUsd: number;
}

export const DEFAULT_MODEL_BUDGET_SOFT_USD = 20;
export const DEFAULT_MODEL_BUDGET_HARD_USD = 50;

/** Misconfigured caps fail closed and loud — never silently fall back open. */
export class ModelBudgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelBudgetConfigError";
  }
}

/**
 * Reads MODEL_BUDGET_SOFT_USD / MODEL_BUDGET_HARD_USD (defaults per A13).
 * Values must be positive numbers and soft <= hard.
 */
export function modelBudgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): ModelBudget {
  const parse = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new ModelBudgetConfigError(`${name} must be a positive number (got "${raw}")`);
    }
    return value;
  };
  const softUsd = parse("MODEL_BUDGET_SOFT_USD", env.MODEL_BUDGET_SOFT_USD) ?? DEFAULT_MODEL_BUDGET_SOFT_USD;
  const hardUsd = parse("MODEL_BUDGET_HARD_USD", env.MODEL_BUDGET_HARD_USD) ?? DEFAULT_MODEL_BUDGET_HARD_USD;
  if (softUsd > hardUsd) {
    throw new ModelBudgetConfigError(
      `MODEL_BUDGET_SOFT_USD (${softUsd}) must not exceed MODEL_BUDGET_HARD_USD (${hardUsd})`,
    );
  }
  return { softUsd, hardUsd };
}

/**
 * Calendar-month spend to date (UTC month boundary; A13 "monthly" caps).
 *
 * Counts BOTH finalized rows and in-flight 'reserved' rows: a reservation
 * provisionally holds the remaining hard-cap headroom (see call-model.ts),
 * so concurrent racers see committed spend plus outstanding exposure the
 * moment the winner's reservation commits — that closes the check-then-
 * dispatch budget race. Stale reservations (crash between reserve and
 * finalize) keep holding their headroom — fail closed until swept.
 */
export async function monthlyModelSpendUsd(db: SqlExecutor): Promise<number> {
  const result = await db.query(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM model_calls WHERE created_at >= date_trunc('month', now())",
  );
  const spent = Number(result.rows[0]?.spent ?? 0);
  return Number.isFinite(spent) ? spent : 0;
}

/** One outstanding ('reserved') model_calls row — a call dispatched but never finalized. */
export interface StaleModelReservation {
  readonly id: string;
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  /** Headroom the reservation still holds against the caps (USD). */
  readonly reservedUsd: number;
  /** When the reservation was written (ISO timestamp). */
  readonly createdAt: string;
}

/**
 * Finds reservations older than `olderThanMs` — rows left 'reserved' by a
 * process crash between reserve and finalize. Read-only on purpose: ops
 * decides what to do with them (the held headroom keeps the budget fail
 * closed until they are reconciled).
 */
export async function staleReservations(
  db: SqlExecutor,
  opts: { readonly olderThanMs: number },
): Promise<StaleModelReservation[]> {
  if (!Number.isFinite(opts.olderThanMs) || opts.olderThanMs < 0) {
    throw new RangeError(`staleReservations: olderThanMs must be a non-negative finite number (got ${opts.olderThanMs})`);
  }
  const result = await db.query(
    `SELECT id::text AS id, run_id::text AS run_id, provider, model, cost_usd AS reserved_usd, created_at
       FROM model_calls
      WHERE result_status = 'reserved' AND created_at < now() - ($1::bigint * interval '1 millisecond')
      ORDER BY created_at`,
    [Math.round(opts.olderThanMs)],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    provider: String(row.provider),
    model: String(row.model),
    reservedUsd: Number(row.reserved_usd),
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}
