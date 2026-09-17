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

/** Calendar-month spend to date (UTC month boundary; A13 "monthly" caps). */
export async function monthlyModelSpendUsd(db: SqlExecutor): Promise<number> {
  const result = await db.query(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM model_calls WHERE created_at >= date_trunc('month', now())",
  );
  const spent = Number(result.rows[0]?.spent ?? 0);
  return Number.isFinite(spent) ? spent : 0;
}
