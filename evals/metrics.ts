/**
 * Eval metrics (M5B; docs/evals.md §3.1) — pure functions, unit-tested in
 * metrics.test.ts. Definitions:
 *
 * - Commitment detection: TP/FP/FN/TN over is_commitment → precision,
 *   recall, F1, FPR = FP/(FP+TN).
 * - Direction accuracy: among items that are commitments in BOTH golden and
 *   prediction — share where predicted direction equals golden direction.
 * - Counterparty accuracy: additionally conditioned on golden counterparty
 *   non-null — exact match, case-insensitive.
 * - Due-date accuracy: additionally conditioned on golden due_date non-null —
 *   exact ISO date match (predicted null = miss).
 * - Confidence-in-band: among CORRECTLY classified items — share whose
 *   predicted confidence falls inside the golden confidence band.
 * - Calibration (reported): predictions bucketed by confidence; per bucket,
 *   mean confidence vs observed classification accuracy.
 * - Action-driving precision: among predictions with is_commitment=true and
 *   confidence ≥ threshold (0.7) — share that are real commitments. This is
 *   the ≥0.9 plan §13 gate any propose→act automation must clear.
 */

export type Direction = "owes_me" | "i_owe";

export interface GoldenExpected {
  readonly is_commitment: boolean;
  readonly direction?: Direction | null;
  readonly counterparty?: string | null;
  readonly due_date?: string | null;
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

export interface EvalPrediction {
  readonly isCommitment: boolean;
  readonly direction: Direction | null;
  readonly counterparty: string | null;
  readonly dueDate: string | null;
  readonly confidence: number;
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

export interface CalibrationBucket {
  readonly label: string;
  readonly n: number;
  readonly meanConfidence: number;
  readonly observedAccuracy: number;
}

export interface EvalReport {
  readonly n: number;
  readonly detection: ClassificationMetrics;
  readonly direction: FieldAccuracy;
  readonly counterparty: FieldAccuracy;
  readonly dueDate: FieldAccuracy;
  readonly confidenceInBand: FieldAccuracy;
  readonly calibration: readonly CalibrationBucket[];
  readonly actionDriving: { readonly threshold: number } & FieldAccuracy;
  readonly failures: readonly {
    readonly id: string;
    readonly category: string;
    readonly kind:
      | "false-positive"
      | "false-negative"
      | "direction"
      | "counterparty"
      | "due-date";
  }[];
}

function accuracy(correct: number, total: number): number {
  return total === 0 ? 1 : correct / total;
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
  let bandCorrect = 0;
  let bandTotal = 0;
  let actionCorrect = 0;
  let actionTotal = 0;
  const failures: {
    id: string;
    category: string;
    kind: "false-positive" | "false-negative" | "direction" | "counterparty" | "due-date";
  }[] = [];

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
      // Direction / counterparty / due-date: conditioned on shared positives.
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
      if (expected.due_date !== undefined && expected.due_date !== null) {
        dueTotal += 1;
        if (predicted.dueDate === expected.due_date) dueCorrect += 1;
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

/** Bootstrap gates (plan §13; docs/evals.md §3.1): F1 ≥ 0.8 overall,
 *  precision ≥ 0.9 for action-driving predictions. */
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
  ];
  return { gates, passed: gates.every((g) => g.passed) };
}
