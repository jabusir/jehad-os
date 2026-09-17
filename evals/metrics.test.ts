// Eval metrics v2 unit tests (hermetic): exact metric math on synthetic
// v2-shape fixtures — detection counts, conditioned accuracies, the
// temporal metrics (normalizer + end-to-end due-date), commitment-state
// accuracy (overall + per-state), buckets, gates.

import { describe, expect, it } from "vitest";
import {
  computeEvalReport,
  evaluateGates,
  temporalBlockMatches,
  type EvalPrediction,
  type GoldenItem,
  type TemporalBlock,
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

function block(overrides: Partial<TemporalBlock> = {}): TemporalBlock {
  return { rawExpression: "Friday", normalizedTime: "2026-09-18", resolutionStatus: "resolved", ...overrides };
}

function pred(overrides: Partial<EvalPrediction>): EvalPrediction {
  return {
    isCommitment: false,
    direction: null,
    counterparty: null,
    confidence: 0.5,
    commitmentState: "active",
    temporal: null,
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
        resolved_due_date: "2026-09-18",
        resolution_status: "resolved",
        commitment_state: "active",
      }),
      // FP (expected false): its predicted fields must NOT be scored.
      item("fp", { is_commitment: false, commitment_state: "active" }),
      // FN (expected true, predicted false): not scored either.
      item("fn", {
        is_commitment: true,
        direction: "i_owe",
        counterparty: "Mo",
        resolved_due_date: "2026-09-21",
        resolution_status: "resolved",
        commitment_state: "active",
      }),
    ];
    const predictions = new Map<string, EvalPrediction>([
      ["shared", pred({ isCommitment: true, direction: "i_owe", counterparty: "jane", temporal: block({ normalizedTime: "2026-09-30" }) })],
      ["fp", pred({ isCommitment: true, direction: "i_owe", counterparty: "x", temporal: block({ normalizedTime: "2026-09-30" }) })],
      ["fn", pred({ isCommitment: false })],
    ]);
    const report = computeEvalReport(items, predictions);
    expect(report.direction).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.counterparty).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.dueDate).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.normalizer).toEqual({ correct: 0, total: 1, accuracy: 0 });
    // State IS scored on every item: fp predicted active (matches), shared
    // predicted active (matches), fn predicted active (matches) → 3/3.
    expect(report.commitmentState.overall).toEqual({ correct: 3, total: 3, accuracy: 1 });
    expect(report.failures.map((f) => f.kind).sort()).toEqual([
      "counterparty",
      "direction",
      "due-date",
      "false-negative",
      "false-positive",
      "normalizer",
    ]);
  });

  it("normalizer accuracy requires BOTH status and resolved date to match", () => {
    const mk = (
      id: string,
      status: GoldenItem["expected"]["resolution_status"],
      date: string | null,
    ): GoldenItem =>
      item(id, { is_commitment: true, resolution_status: status, resolved_due_date: date, commitment_state: "active" });
    const items = [
      mk("hitResolved", "resolved", "2026-09-18"),
      mk("wrongDate", "resolved", "2026-09-18"),
      mk("hitAmbiguous", "ambiguous", null),
      mk("wrongStatusOnAmbiguous", "ambiguous", null),
      mk("hitNone", "none", null),
      // No golden resolution_status → not in the normalizer denominator.
      item("unscored", { is_commitment: true, commitment_state: "active" }),
    ];
    const predictions = new Map<string, EvalPrediction>([
      ["hitResolved", pred({ isCommitment: true, temporal: block() })],
      ["wrongDate", pred({ isCommitment: true, temporal: block({ normalizedTime: "2026-10-01" }) })],
      ["hitAmbiguous", pred({ isCommitment: true, temporal: block({ rawExpression: "sometime next week", normalizedTime: null, resolutionStatus: "ambiguous" }) })],
      ["wrongStatusOnAmbiguous", pred({ isCommitment: true, temporal: block({ normalizedTime: null, resolutionStatus: "none" }) })],
      ["hitNone", pred({ isCommitment: true, temporal: block({ rawExpression: null, normalizedTime: null, resolutionStatus: "none" }) })],
      ["unscored", pred({ isCommitment: true })],
    ]);
    const report = computeEvalReport(items, predictions);
    expect(report.normalizer).toEqual({ correct: 3, total: 5, accuracy: 0.6 });
  });

  it("a missing temporal block on a shared positive is a normalizer + due-date miss", () => {
    const items = [
      item("noblock", { is_commitment: true, resolution_status: "resolved", resolved_due_date: "2026-09-18", commitment_state: "active" }),
    ];
    const report = computeEvalReport(items, new Map([["noblock", pred({ isCommitment: true, temporal: null })]]));
    expect(report.normalizer).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(report.dueDate).toEqual({ correct: 0, total: 1, accuracy: 0 });
  });

  it("due-date accuracy counts a correct date with a mismatched status as an e2e hit but a normalizer miss", () => {
    const items = [
      item("x", { is_commitment: true, resolution_status: "resolved", resolved_due_date: "2026-09-18", commitment_state: "active" }),
    ];
    const report = computeEvalReport(
      items,
      new Map([["x", pred({ isCommitment: true, temporal: block({ resolutionStatus: "ambiguous", normalizedTime: "2026-09-18" }) })]]),
    );
    expect(report.dueDate).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(report.normalizer).toEqual({ correct: 0, total: 1, accuracy: 0 });
  });

  it("commitment-state accuracy is overall AND per state, over every item that defines a state", () => {
    const items = [
      item("a1", { is_commitment: true, commitment_state: "active" }),
      item("a2", { is_commitment: true, commitment_state: "active" }),
      item("h1", { is_commitment: false, commitment_state: "hypothetical" }),
      item("h2", { is_commitment: false, commitment_state: "hypothetical" }),
      item("c1", { is_commitment: false, commitment_state: "cancelled" }),
    ];
    const predictions = new Map<string, EvalPrediction>([
      ["a1", pred({ isCommitment: true, commitmentState: "active" })],
      ["a2", pred({ isCommitment: true, commitmentState: "active" })],
      ["h1", pred({ commitmentState: "active" })], // state miss (misread hypothetical)
      ["h2", pred({ commitmentState: "hypothetical" })],
      ["c1", pred({ commitmentState: "cancelled" })],
    ]);
    const report = computeEvalReport(items, predictions);
    expect(report.commitmentState.overall).toEqual({ correct: 4, total: 5, accuracy: 0.8 });
    const byState = new Map(report.commitmentState.perState.map((s) => [s.state, s]));
    expect(byState.get("active")).toEqual({ state: "active", correct: 2, total: 2, accuracy: 1 });
    expect(byState.get("hypothetical")).toEqual({ state: "hypothetical", correct: 1, total: 2, accuracy: 0.5 });
    expect(byState.get("cancelled")).toEqual({ state: "cancelled", correct: 1, total: 1, accuracy: 1 });
    expect(report.failures.filter((f) => f.kind === "commitment-state").map((f) => f.id)).toEqual(["h1"]);
  });

  it("a null predicted state never matches a golden state", () => {
    const items = [item("x", { is_commitment: false, commitment_state: "historical" })];
    const report = computeEvalReport(items, new Map([["x", pred({ commitmentState: null })]]));
    expect(report.commitmentState.overall).toEqual({ correct: 0, total: 1, accuracy: 0 });
  });

  it("matches counterparties case-insensitively and skips null expectations", () => {
    const items = [
      item("cased", { is_commitment: true, direction: "i_owe", counterparty: "Jehad", commitment_state: "active" }),
      item("nullcp", { is_commitment: true, direction: "i_owe", counterparty: null, commitment_state: "active" }),
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
      item("right", { is_commitment: true, confidence: [0.8, 1.0], commitment_state: "active" }),
      item("rightOutOfBand", { is_commitment: false, confidence: [0.0, 0.3], commitment_state: "active" }),
      item("wrong", { is_commitment: false, confidence: [0.0, 0.3], commitment_state: "active" }),
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

describe("temporalBlockMatches", () => {
  it("matches only when status AND date both equal the golden expectation", () => {
    const expected = { is_commitment: true, resolution_status: "resolved" as const, resolved_due_date: "2026-09-18" };
    expect(temporalBlockMatches(block(), expected)).toBe(true);
    expect(temporalBlockMatches(block({ normalizedTime: "2026-09-25" }), expected)).toBe(false);
    expect(temporalBlockMatches(block({ resolutionStatus: "ambiguous", normalizedTime: null }), expected)).toBe(false);
    expect(temporalBlockMatches(block(), { is_commitment: true, resolution_status: undefined })).toBe(false);
    // Golden null date: block must be null-dated with the same status.
    const ambiguous = { is_commitment: true, resolution_status: "ambiguous" as const, resolved_due_date: null };
    expect(temporalBlockMatches(block({ rawExpression: "x", normalizedTime: null, resolutionStatus: "ambiguous" }), ambiguous)).toBe(true);
    expect(temporalBlockMatches(block({ normalizedTime: "2026-09-18", resolutionStatus: "ambiguous" }), ambiguous)).toBe(false);
  });
});

describe("evaluateGates", () => {
  it("passes only when F1 ≥ 0.8 AND action precision ≥ 0.9 AND state accuracy ≥ 0.8", () => {
    const pass = computeEvalReport(
      [
        item("a", { is_commitment: true, commitment_state: "active" }),
        item("b", { is_commitment: false, commitment_state: "active" }),
      ],
      new Map([
        ["a", pred({ isCommitment: true, confidence: 0.95 })],
        ["b", pred({ isCommitment: false })],
      ]),
    );
    expect(evaluateGates(pass).passed).toBe(true);

    const failF1AndAction = computeEvalReport(
      [
        item("a", { is_commitment: true, commitment_state: "active" }),
        item("b", { is_commitment: false, commitment_state: "active" }),
      ],
      new Map([
        ["a", pred({ isCommitment: false })],
        ["b", pred({ isCommitment: true, confidence: 0.95 })],
      ]),
    );
    const gates = evaluateGates(failF1AndAction);
    expect(gates.passed).toBe(false);
    expect(gates.gates.map((g) => [g.name, g.passed])).toEqual([
      ["overall-f1", false],
      ["action-precision", false],
      ["commitment-state-accuracy", true],
    ]);
  });

  it("fails on commitment-state accuracy alone when detection is perfect", () => {
    const report = computeEvalReport(
      [
        item("a", { is_commitment: true, commitment_state: "active" }),
        item("b", { is_commitment: false, commitment_state: "hypothetical" }),
        item("c", { is_commitment: false, commitment_state: "hypothetical" }),
      ],
      new Map([
        ["a", pred({ isCommitment: true, confidence: 0.95 })],
        ["b", pred({ commitmentState: "hypothetical" })],
        ["c", pred({ commitmentState: "active" })], // state miss → 2/3 = 0.667 < 0.80
      ]),
    );
    const gates = evaluateGates(report);
    expect(gates.passed).toBe(false);
    expect(gates.gates.map((g) => [g.name, g.passed])).toEqual([
      ["overall-f1", true],
      ["action-precision", true],
      ["commitment-state-accuracy", false],
    ]);
  });
});
