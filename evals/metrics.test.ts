// Eval metrics unit tests (hermetic): exact metric math on synthetic
// fixtures — counts, conditioned accuracies, buckets, gates.

import { describe, expect, it } from "vitest";
import {
  computeEvalReport,
  evaluateGates,
  type EvalPrediction,
  type GoldenItem,
} from "./metrics.js";

function item(
  id: string,
  expected: GoldenItem["expected"],
  extra: Partial<GoldenItem> = {},
): GoldenItem {
  return {
    id,
    category: "synthetic",
    occurredAt: "2026-09-17T09:00:00.000Z",
    text: `text for ${id}`,
    expected,
    ...extra,
  };
}

function pred(overrides: Partial<EvalPrediction>): EvalPrediction {
  return {
    isCommitment: false,
    direction: null,
    counterparty: null,
    dueDate: null,
    confidence: 0.5,
    ...overrides,
  };
}

describe("computeEvalReport", () => {
  it("computes detection counts, precision/recall/F1/FPR exactly", () => {
    const items = [
      item("tp1", { is_commitment: true }),
      item("tp2", { is_commitment: true }),
      item("fp1", { is_commitment: false }),
      item("fn1", { is_commitment: true }),
      item("tn1", { is_commitment: false }),
    ];
    const predictions = new Map<string, EvalPrediction>([
      ["tp1", pred({ isCommitment: true })],
      ["tp2", pred({ isCommitment: true })],
      ["fp1", pred({ isCommitment: true })],
      ["fn1", pred({ isCommitment: false })],
      ["tn1", pred({ isCommitment: false })],
    ]);
    const report = computeEvalReport(items, predictions);
    expect(report.detection).toMatchObject({ tp: 2, fp: 1, fn: 1, tn: 1 });
    expect(report.detection.precision).toBeCloseTo(2 / 3);
    expect(report.detection.recall).toBeCloseTo(2 / 3);
    expect(report.detection.f1).toBeCloseTo(2 / 3);
    expect(report.detection.fpr).toBeCloseTo(1 / 2);
  });

  it("conditions direction/counterparty/due-date on SHARED positives only", () => {
    const items = [
      // TP with all fields wrong → counts in every conditioned denominator.
      item("shared", {
        is_commitment: true,
        direction: "owes_me",
        counterparty: "Sarah",
        due_date: "2026-09-18",
      }),
      // FP (expected false): its predicted fields must NOT be scored.
      item("fp", { is_commitment: false }),
      // FN (expected true, predicted false): not scored either.
      item("fn", {
        is_commitment: true,
        direction: "i_owe",
        counterparty: "Mo",
        due_date: "2026-09-21",
      }),
    ];
    const predictions = new Map<string, EvalPrediction>([
      ["shared", pred({ isCommitment: true, direction: "i_owe", counterparty: "jane", dueDate: "2026-09-30" })],
      ["fp", pred({ isCommitment: true, direction: "i_owe", counterparty: "x", dueDate: "2026-09-30" })],
      ["fn", pred({ isCommitment: false })],
    ]);
    const report = computeEvalReport(items, predictions);
    expect(report.direction).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.counterparty).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.dueDate).toEqual({ correct: 0, total: 1, accuracy: 0 });
    // All five failures recorded with their kinds.
    expect(report.failures.map((f) => f.kind).sort()).toEqual([
      "counterparty",
      "direction",
      "due-date",
      "false-negative",
      "false-positive",
    ]);
  });

  it("matches counterparties case-insensitively and skips null expectations", () => {
    const items = [
      item("cased", { is_commitment: true, direction: "i_owe", counterparty: "Jehad" }),
      item("nullcp", { is_commitment: true, direction: "i_owe", counterparty: null }),
    ];
    const predictions = new Map<string, EvalPrediction>([
      ["cased", pred({ isCommitment: true, direction: "i_owe", counterparty: "jehad" })],
      ["nullcp", pred({ isCommitment: true, direction: "i_owe", counterparty: null })],
    ]);
    const report = computeEvalReport(items, predictions);
    expect(report.counterparty).toEqual({ correct: 1, total: 1, accuracy: 1 });
  });

  it("scores confidence bands only on correctly classified items", () => {
    const items = [
      item("right", { is_commitment: true, confidence: [0.8, 1.0] }),
      item("rightOutOfBand", { is_commitment: false, confidence: [0.0, 0.3] }),
      item("wrong", { is_commitment: false, confidence: [0.0, 0.3] }),
    ];
    const predictions = new Map<string, EvalPrediction>([
      ["right", pred({ isCommitment: true, confidence: 0.9 })],
      ["rightOutOfBand", pred({ isCommitment: false, confidence: 0.9 })],
      ["wrong", pred({ isCommitment: true, confidence: 0.9 })], // misclassified → unscored
    ]);
    const report = computeEvalReport(items, predictions);
    expect(report.confidenceInBand).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
  });

  it("action-driving precision counts high-confidence false positives against the gate", () => {
    const items = [
      item("hit1", { is_commitment: true }),
      item("hit2", { is_commitment: true }),
      item("lowConfFp", { is_commitment: false }),
      item("highConfFp", { is_commitment: false }),
      item("lowConfTp", { is_commitment: true }),
    ];
    const predictions = new Map<string, EvalPrediction>([
      ["hit1", pred({ isCommitment: true, confidence: 0.95 })],
      ["hit2", pred({ isCommitment: true, confidence: 0.8 })],
      ["lowConfFp", pred({ isCommitment: true, confidence: 0.6 })], // below threshold: excluded
      ["highConfFp", pred({ isCommitment: true, confidence: 0.75 })], // counts against
      ["lowConfTp", pred({ isCommitment: true, confidence: 0.6 })], // below threshold: excluded
    ]);
    const report = computeEvalReport(items, predictions);
    expect(report.actionDriving).toMatchObject({ correct: 2, total: 3, accuracy: 2 / 3 });
  });

  it("buckets calibration over commitment predictions with mean confidence and accuracy", () => {
    const items = [
      item("a", { is_commitment: true }),
      item("b", { is_commitment: false }),
      item("c", { is_commitment: false }),
    ];
    const predictions = new Map<string, EvalPrediction>([
      ["a", pred({ isCommitment: true, confidence: 0.9 })],
      ["b", pred({ isCommitment: true, confidence: 0.6 })],
      ["c", pred({ isCommitment: false, confidence: 0.2 })], // negative: not a bucket member
    ]);
    const report = computeEvalReport(items, predictions);
    const mid = report.calibration.find((b) => b.label === "[0.50,0.70)")!;
    expect(mid).toMatchObject({ n: 1, meanConfidence: 0.6, observedAccuracy: 0 });
    const top = report.calibration.find((b) => b.label === "[0.85,1.00]")!;
    expect(top).toMatchObject({ n: 1, meanConfidence: 0.9, observedAccuracy: 1 });
    const empty = report.calibration.find((b) => b.label === "[0.00,0.50)")!;
    expect(empty).toMatchObject({ n: 0, meanConfidence: 0, observedAccuracy: 1 });
  });

  it("throws when a prediction is missing", () => {
    expect(() => computeEvalReport([item("x", { is_commitment: true })], new Map())).toThrow(
      "no prediction for golden item x",
    );
  });
});

describe("evaluateGates", () => {
  it("passes only when F1 ≥ 0.8 AND action precision ≥ 0.9", () => {
    const pass = computeEvalReport(
      [item("a", { is_commitment: true }), item("b", { is_commitment: false })],
      new Map([
        ["a", pred({ isCommitment: true, confidence: 0.95 })],
        ["b", pred({ isCommitment: false })],
      ]),
    );
    expect(evaluateGates(pass).passed).toBe(true);

    const failF1 = computeEvalReport(
      [item("a", { is_commitment: true }), item("b", { is_commitment: false })],
      new Map([
        ["a", pred({ isCommitment: false })],
        ["b", pred({ isCommitment: true, confidence: 0.95 })],
      ]),
    );
    const gates = evaluateGates(failF1);
    expect(gates.passed).toBe(false);
    expect(gates.gates.map((g) => [g.name, g.passed])).toEqual([
      ["overall-f1", false],
      ["action-precision", false],
    ]);
  });
});
