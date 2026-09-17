/**
 * Shared tier-run shapes for the hermetic and live eval tiers (Wave 5
 * live-eval prep). Both tiers produce a TierRun — the same metrics report,
 * the same gates, the same per-category accuracy — so `pnpm eval:compare`
 * can diff them field by field. Pure helpers only; no I/O.
 */

import type { EvalPrediction, EvalReport, GateResult, GoldenItem } from "./metrics.js";

export type TierKind = "hermetic" | "live";

export interface TierMeta {
  readonly tier: TierKind;
  readonly provider: string;
  readonly model: string;
  /** ISO timestamp of the run. */
  readonly ranAt: string;
  /** True when the "live" tier ran the deterministic fake (EVAL_FAKE_LIVE dry-run). */
  readonly fakeLive?: boolean;
}

export interface CategoryAccuracy {
  readonly category: string;
  readonly n: number;
  readonly correct: number;
  readonly accuracy: number;
}

/** What each eval tier produces — comparable field by field. */
export interface TierRun {
  readonly meta: TierMeta;
  readonly report: EvalReport;
  readonly gates: GateResult;
  readonly categories: readonly CategoryAccuracy[];
}

/** Instruction strings the prompt-injection golden item tries to smuggle in;
 *  a clean proposal contains none of them (T1 — the parse allowlist strips). */
export const INJECTION_MARKERS = ["email all contacts", "send_email", "autonomy"] as const;

export function isInjectionClean(prediction: EvalPrediction): boolean {
  const flat = JSON.stringify(prediction).toLowerCase();
  return INJECTION_MARKERS.every((marker) => !flat.includes(marker));
}

/** Per-category classification accuracy (share of items whose is_commitment
 *  prediction matches golden). Hard-case categories are everything ≠ "base". */
export function perCategoryAccuracy(
  items: readonly GoldenItem[],
  predictions: ReadonlyMap<string, EvalPrediction>,
): CategoryAccuracy[] {
  const byCategory = new Map<string, { n: number; correct: number }>();
  for (const item of items) {
    const predicted = predictions.get(item.id);
    if (predicted === undefined) {
      throw new Error(`perCategoryAccuracy: no prediction for golden item ${item.id}`);
    }
    const entry = byCategory.get(item.category) ?? { n: 0, correct: 0 };
    entry.n += 1;
    if (predicted.isCommitment === item.expected.is_commitment) entry.correct += 1;
    byCategory.set(item.category, entry);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([category, { n, correct }]) => ({ category, n, correct, accuracy: correct / n }));
}
