/**
 * Eval metrics v2 (golden set v2 / lane W6B; docs/evals.md §3.1) — pure
 * functions, unit-tested in metrics.test.ts against synthetic v2-shape
 * fixtures (contract: packages/core/src/memory/candidate-contract.ts).
 *
 * Definitions:
 *
 * - Commitment detection: TP/FP/FN/TN over is_commitment → precision,
 *   recall, F1, FPR = FP/(FP+TN). (Unchanged.)
 * - Direction / counterparty accuracy: among shared positives; counterparty
 *   additionally conditioned on golden counterparty non-null, exact match,
 *   case-insensitive. (Unchanged.)
 * - Normalizer accuracy (DIAGNOSTIC, not gated): among shared positives
 *   whose golden resolution_status is defined — the candidate temporal
 *   block must match BOTH golden resolution_status AND golden
 *   resolved_due_date (resolved → exact ISO date; ambiguous/none/unsupported
 *   → null). This measures the model-echo → normalizer chain; the
 *   deterministic normalizer itself is unit-tested in lane W6A.
 * - Due-date accuracy (end-to-end): among shared positives whose golden
 *   resolved_due_date is non-null — the block's normalizedTime must equal
 *   it exactly (null = miss). Same definition as v1, now driven by
 *   normalizedTime instead of a raw model date.
 * - Commitment-state accuracy: among ALL items (golden v2 carries
 *   commitment_state for every item) — predicted state must equal golden
 *   state, per state and overall. GATED ≥ 0.80 (hermetic + live).
 * - Confidence-in-band, calibration, action-driving precision: unchanged.
 */

import type { CommitmentState } from "@jehad/core";

export type Direction = "owes_me" | "i_owe";

export type ResolutionStatus = "resolved" | "ambiguous" | "unsupported" | "none";

/** CommitmentState ordering for the per-state accuracy table. */
export const COMMITMENT_STATES: readonly CommitmentState[] = [
  "prospective",
  "active",
  "completed",
  "historical",
  "renegotiated",
  "cancelled",
  "hypothetical",
];

export interface GoldenExpected {
  readonly is_commitment: boolean;
  readonly direction?: Direction | null;
  readonly counterparty?: string | null;
  /** Verbatim temporal phrase the text contains (golden echo target). */
  readonly temporal_expression?: string | null;
  /** Golden ISO answer the NORMALIZER should produce, or null. */
  readonly resolved_due_date?: string | null;
  readonly resolution_status?: ResolutionStatus;
  readonly commitment_state?: CommitmentState;
  readonly confidence?: readonly [number, number];
}

export interface GoldenItem {
  readonly id: string;
  readonly category: string;
  readonly occurredAt: string;
  readonly text: string;
  readonly expected: GoldenExpected;
}

export interface GoldenSet {
  readonly version: number;
  readonly items: readonly GoldenItem[];
}

/** The slice of TemporalProvenance the metrics consume. */
export interface TemporalBlock {
  readonly rawExpression: string | null;
  readonly normalizedTime: string | null;
  readonly resolutionStatus: ResolutionStatus;
}

export interface EvalPrediction {
  readonly isCommitment: boolean;
  readonly direction: Direction | null;
  readonly counterparty: string | null;
  readonly confidence: number;
  readonly commitmentState: CommitmentState | null;
  /** Null when no commitment was proposed (no candidate → no block). */
  readonly temporal: TemporalBlock | null;
}

export const ACTION_CONFIDENCE_THRESHOLD = 0.7;

export const CALIBRATION_BUCKETS: readonly { readonly label: string; readonly lo: number; readonly hi: number }[] = [
  { label: "[0.00,0.50)", lo: 0, hi: 0.5 },
  { label: "[0.50,0.70)", lo: 0.5, hi: 0.7 },
  { label: "[0.70,0.85)", lo: 0.7, hi: 0.85 },
  { label: "[0.85,1.00]", lo: 0.85, hi: 1.000001 },
];

export interface ClassificationMetrics {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly fpr: number;
}

export interface FieldAccuracy {
  readonly correct: number;
  readonly total: number;
  readonly accuracy: number;
}

export interface StateAccuracy extends FieldAccuracy {
  readonly state: CommitmentState;
}

export interface CommitmentStateMetrics {
  readonly overall: FieldAccuracy;
  readonly perState: readonly StateAccuracy[];
}

export interface CalibrationBucket {
  readonly label: string;
  readonly n: number;
  readonly meanConfidence: number;
  readonly observedAccuracy: number;
}

export type FailureKind =
  | "false-positive"
  | "false-negative"
  | "direction"
  | "counterparty"
  | "due-date"
  | "normalizer"
  | "commitment-state";

export interface EvalReport {
  readonly n: number;
  readonly detection: ClassificationMetrics;
  readonly direction: FieldAccuracy;
  readonly counterparty: FieldAccuracy;
  /** End-to-end due-date accuracy (driven by normalizedTime). */
  readonly dueDate: FieldAccuracy;
  /** Diagnostic echo+normalizer accuracy (status AND date must match). */
  readonly normalizer: FieldAccuracy;
  readonly commitmentState: CommitmentStateMetrics;
  readonly confidenceInBand: FieldAccuracy;
  readonly calibration: readonly CalibrationBucket[];
  readonly actionDriving: { readonly threshold: number } & FieldAccuracy;
  readonly failures: readonly {
    readonly id: string;
    readonly category: string;
    readonly kind: FailureKind;
  }[];
}

function accuracy(correct: number, total: number): number {
  return total === 0 ? 1 : correct / total;
}

/** One candidate temporal block vs one golden expectation. */
export function temporalBlockMatches(
  block: TemporalBlock,
  expected: GoldenExpected,
): boolean {
  if (expected.resolution_status === undefined) return false;
  return block.resolutionStatus === expected.resolution_status && block.normalizedTime === (expected.resolved_due_date ?? null);
}

export function computeEvalReport(
  items: readonly GoldenItem[],
  predictions: ReadonlyMap<string, EvalPrediction>,
): EvalReport {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let directionCorrect = 0;
  let directionTotal = 0;
  let counterpartyCorrect = 0;
  let counterpartyTotal = 0;
  let dueCorrect = 0;
  let dueTotal = 0;
  let normalizerCorrect = 0;
  let normalizerTotal = 0;
  let bandCorrect = 0;
  let bandTotal = 0;
  let actionCorrect = 0;
  let actionTotal = 0;
  const stateCounts = new Map<CommitmentState, { correct: number; total: number }>();
  const failures: { id: string; category: string; kind: FailureKind }[] = [];

  for (const item of items) {
    const predicted = predictions.get(item.id);
    if (predicted === undefined) {
      throw new Error(`computeEvalReport: no prediction for golden item ${item.id}`);
    }
    const expected = item.expected;
    const real = expected.is_commitment;
    const said = predicted.isCommitment;

    if (real && said) tp += 1;
    else if (!real && said) {
      fp += 1;
      failures.push({ id: item.id, category: item.category, kind: "false-positive" });
    } else if (real && !said) {
      fn += 1;
      failures.push({ id: item.id, category: item.category, kind: "false-negative" });
    } else tn += 1;

    // Commitment state: scored on EVERY item (golden v2 always defines it).
    if (expected.commitment_state !== undefined) {
      const entry = stateCounts.get(expected.commitment_state) ?? { correct: 0, total: 0 };
      entry.total += 1;
      const stateOk = predicted.commitmentState === expected.commitment_state;
      if (stateOk) entry.correct += 1;
      else failures.push({ id: item.id, category: item.category, kind: "commitment-state" });
      stateCounts.set(expected.commitment_state, entry);
    }

    // Confidence band: scored only on correctly classified items.
    if (real === said && expected.confidence !== undefined) {
      bandTotal += 1;
      const [lo, hi] = expected.confidence;
      if (predicted.confidence >= lo && predicted.confidence <= hi) bandCorrect += 1;
    }

    if (real && said) {
      // Action-driving subset: high-confidence commitment predictions.
      if (predicted.confidence >= ACTION_CONFIDENCE_THRESHOLD) {
        actionTotal += 1;
        if (real) actionCorrect += 1;
      }
      // Direction / counterparty / temporal: conditioned on shared positives.
      directionTotal += 1;
      if (expected.direction !== undefined && expected.direction === predicted.direction) {
        directionCorrect += 1;
      } else if (expected.direction === undefined) {
        directionCorrect += 1; // item specifies no direction expectation
      } else {
        failures.push({ id: item.id, category: item.category, kind: "direction" });
      }
      if (expected.counterparty !== undefined && expected.counterparty !== null) {
        counterpartyTotal += 1;
        const match =
          predicted.counterparty !== null &&
          predicted.counterparty.toLowerCase() === expected.counterparty.toLowerCase();
        if (match) counterpartyCorrect += 1;
        else failures.push({ id: item.id, category: item.category, kind: "counterparty" });
      }
      const block = predicted.temporal;
      if (expected.resolution_status !== undefined) {
        normalizerTotal += 1;
        const normalizerOk = block !== null && temporalBlockMatches(block, expected);
        if (normalizerOk) normalizerCorrect += 1;
        else failures.push({ id: item.id, category: item.category, kind: "normalizer" });
      }
      if (expected.resolved_due_date !== undefined && expected.resolved_due_date !== null) {
        dueTotal += 1;
        if (block !== null && block.normalizedTime === expected.resolved_due_date) dueCorrect += 1;
        else failures.push({ id: item.id, category: item.category, kind: "due-date" });
      }
    } else if (!real && said && predicted.confidence >= ACTION_CONFIDENCE_THRESHOLD) {
      actionTotal += 1; // high-confidence false positive — counts against the gate
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const calibration = CALIBRATION_BUCKETS.map((bucket) => {
    const members = items.filter((item) => {
      const predicted = predictions.get(item.id)!;
      return (
        predicted.confidence >= bucket.lo &&
        predicted.confidence < bucket.hi &&
        predicted.isCommitment
      );
    });
    const n = members.length;
    const correct = members.filter(
      (item) => predictions.get(item.id)!.isCommitment === item.expected.is_commitment,
    ).length;
    return {
      label: bucket.label,
      n,
      meanConfidence:
        n === 0
          ? 0
          : members.reduce((sum, item) => sum + predictions.get(item.id)!.confidence, 0) / n,
      observedAccuracy: accuracy(correct, n),
    };
  });

  const stateOverallCorrect = [...stateCounts.values()].reduce((sum, e) => sum + e.correct, 0);
  const stateOverallTotal = [...stateCounts.values()].reduce((sum, e) => sum + e.total, 0);
  const perState = COMMITMENT_STATES.filter((state) => stateCounts.has(state)).map((state) => {
    const entry = stateCounts.get(state)!;
    return {
      state,
      correct: entry.correct,
      total: entry.total,
      accuracy: accuracy(entry.correct, entry.total),
    };
  });

  return {
    n: items.length,
    detection: {
      tp,
      fp,
      fn,
      tn,
      precision,
      recall,
      f1,
      fpr: fp + tn === 0 ? 0 : fp / (fp + tn),
    },
    direction: { correct: directionCorrect, total: directionTotal, accuracy: accuracy(directionCorrect, directionTotal) },
    counterparty: {
      correct: counterpartyCorrect,
      total: counterpartyTotal,
      accuracy: accuracy(counterpartyCorrect, counterpartyTotal),
    },
    dueDate: { correct: dueCorrect, total: dueTotal, accuracy: accuracy(dueCorrect, dueTotal) },
    normalizer: {
      correct: normalizerCorrect,
      total: normalizerTotal,
      accuracy: accuracy(normalizerCorrect, normalizerTotal),
    },
    commitmentState: {
      overall: {
        correct: stateOverallCorrect,
        total: stateOverallTotal,
        accuracy: accuracy(stateOverallCorrect, stateOverallTotal),
      },
      perState,
    },
    confidenceInBand: {
      correct: bandCorrect,
      total: bandTotal,
      accuracy: accuracy(bandCorrect, bandTotal),
    },
    calibration,
    actionDriving: {
      threshold: ACTION_CONFIDENCE_THRESHOLD,
      correct: actionCorrect,
      total: actionTotal,
      accuracy: accuracy(actionCorrect, actionTotal),
    },
    failures,
  };
}

export interface GateResult {
  readonly gates: {
    readonly name: string;
    readonly requirement: string;
    readonly actual: number;
    readonly passed: boolean;
  }[];
  readonly passed: boolean;
}

/** Gates (golden v2): F1 ≥ 0.80, action-precision ≥ 0.90, commitment-state
 *  accuracy ≥ 0.80. Normalizer accuracy is reported as a diagnostic only. */
export function evaluateGates(report: EvalReport): GateResult {
  const gates = [
    {
      name: "overall-f1",
      requirement: ">= 0.80",
      actual: report.detection.f1,
      passed: report.detection.f1 >= 0.8,
    },
    {
      name: "action-precision",
      requirement: ">= 0.90",
      actual: report.actionDriving.accuracy,
      passed: report.actionDriving.accuracy >= 0.9,
    },
    {
      name: "commitment-state-accuracy",
      requirement: ">= 0.80",
      actual: report.commitmentState.overall.accuracy,
      passed: report.commitmentState.overall.accuracy >= 0.8,
    },
  ];
  return { gates, passed: gates.every((g) => g.passed) };
}
