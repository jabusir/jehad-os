// Eval comparison unit tests (hermetic): metric diffing (incl. the new
// normalizer + commitment-state rows), per-category pairing, report
// rendering (golden string — structure stability is the contract the
// owner's step-2 decision relies on), cache round-trip fidelity, and the
// fake-vs-fake zero-delta proof over the REAL v3 eval pipeline.

import { describe, expect, it } from "vitest";
import { compareTiers, renderCompareConsole, renderCompareMarkdown, reportFileName } from "./compare.js";
import { runHermeticEval } from "./runner.js";
import {
  computeEvalReport,
  evaluateGates,
  type EvalPrediction,
  type GoldenItem,
} from "./metrics.js";
import { perCategoryAccuracy, type TierMeta, type TierRun } from "./tiers.js";

function item(id: string, category: string, expected: GoldenItem["expected"]): GoldenItem {
  return { id, category, occurredAt: "2026-09-17T09:00:00.000Z", text: `text for ${id}`, expected };
}

const SYNTHETIC_ITEMS: readonly GoldenItem[] = [
  item("base-01", "base", {
    is_commitment: true,
    direction: "i_owe",
    counterparty: "Jehad",
    temporal_expression: "Friday",
    resolved_due_date: "2026-09-18",
    resolution_status: "resolved",
    commitment_state: "active",
    confidence: [0.75, 1.0],
  }),
  item("base-02", "base", {
    is_commitment: true,
    direction: "i_owe",
    counterparty: null,
    temporal_expression: null,
    resolved_due_date: null,
    resolution_status: "none",
    commitment_state: "active",
  }),
  item("hard-negation-01", "negation", {
    is_commitment: false,
    temporal_expression: null,
    resolved_due_date: null,
    resolution_status: "none",
    commitment_state: "cancelled",
    confidence: [0.5, 0.7],
  }),
  item("hard-injection-01", "prompt-injection", {
    is_commitment: false,
    temporal_expression: null,
    resolved_due_date: null,
    resolution_status: "none",
  }),
];

function pred(overrides: Partial<EvalPrediction>): EvalPrediction {
  return {
    isCommitment: false,
    direction: null,
    counterparty: null,
    confidence: 0.2,
    commitmentState: null,
    temporal: null,
    ...overrides,
  };
}

const HERMETIC_PREDS = new Map<string, EvalPrediction>([
  ["base-01", pred({ isCommitment: true, direction: "i_owe", counterparty: "Jehad", confidence: 0.9, temporal: { rawExpression: "Friday", normalizedTime: "2026-09-18", resolutionStatus: "resolved" } })],
  ["base-02", pred({ isCommitment: true, confidence: 0.8 })],
  ["hard-negation-01", pred({ confidence: 0.3, commitmentState: "cancelled" })], // correctly not-open, correct stance
  ["hard-injection-01", pred({})],
]);

const LIVE_PREDS = new Map<string, EvalPrediction>([
  ["base-01", pred({ isCommitment: true, direction: "i_owe", counterparty: "Jehad", confidence: 0.9, temporal: { rawExpression: "Friday", normalizedTime: "2026-09-18", resolutionStatus: "resolved" } })],
  ["base-02", pred({ isCommitment: true, confidence: 0.8 })],
  ["hard-negation-01", pred({ isCommitment: true, direction: "i_owe", counterparty: "Sara", confidence: 0.8, commitmentState: "active", temporal: { rawExpression: null, normalizedTime: null, resolutionStatus: "none" } })], // live FP: calls a negation an active commitment
  ["hard-injection-01", pred({})],
]);

function tierRun(predictions: ReadonlyMap<string, EvalPrediction>, meta: TierMeta): TierRun {
  const report = computeEvalReport(SYNTHETIC_ITEMS, predictions);
  return { meta, report, gates: evaluateGates(report), categories: perCategoryAccuracy(SYNTHETIC_ITEMS, predictions) };
}

const HERMETIC_META: TierMeta = {
  tier: "hermetic",
  provider: "eval-fake",
  model: "eval-fake-heuristic-v2",
  ranAt: "2026-09-17T10:00:00.000Z",
  goldenVersion: 2,
};

const LIVE_META: TierMeta = {
  tier: "live",
  provider: "openrouter",
  model: "openai/gpt-4o-mini",
  ranAt: "2026-09-17T10:05:00.000Z",
  goldenVersion: 2,
};

function syntheticCompareInput() {
  const hermeticRun = {
    ...tierRun(HERMETIC_PREDS, HERMETIC_META),
    hygiene: {
      checks: [
        {
          id: "hard-injection-01",
          dropped: ["instructions", "tool", "system_directive"] as readonly string[],
          clean: true,
        },
      ],
      passed: true,
      johnOk: false,
    },
  };
  const liveSuccess = {
    skipped: false as const,
    run: tierRun(LIVE_PREDS, LIVE_META),
    spend: { totalUsd: 0.0123, calls: 4, budgetWarnings: 0 },
    ledger: { rows: 4, errorRows: 0, totalCostUsd: 0.0123 },
    parseFailures: [] as string[],
    hygiene: { checks: [{ id: "hard-injection-01", dropped: 3, clean: true }], passed: true },
    dbName: "jehad_test_evalive",
  };
  return { hermetic: hermeticRun, live: liveSuccess };
}

describe("compareTiers", () => {
  it("diffs fields (incl. normalizer + state), categories, and gates; flags non-identical tiers", () => {
    const { hermetic, live } = syntheticCompareInput();
    const cmp = compareTiers(hermetic, live.run);
    const f1 = cmp.fields.find((f) => f.label === "F1")!;
    expect(f1.hermetic).toBeCloseTo(1.0);
    expect(f1.live).toBeCloseTo(0.8, 3);
    expect(f1.delta).toBeCloseTo(-0.2, 3);
    const stateAcc = cmp.fields.find((f) => f.label === "state acc")!;
    expect(stateAcc.hermetic).toBeCloseTo(1.0);
    expect(stateAcc.live).toBeCloseTo(2 / 3, 3);
    const negation = cmp.categories.find((c) => c.category === "negation")!;
    expect(negation.hermetic).toBe(1);
    expect(negation.live).toBe(0);
    expect(cmp.identical).toBe(false);
    expect(cmp.gatesPassed).toBe(false);
    expect(cmp.gates.map((g) => [g.name, g.passed])).toEqual([
      ["overall-f1", true],
      ["action-precision", false],
      ["commitment-state-accuracy", false],
    ]);
  });

  it("fake-vs-fake over the REAL v3 eval pipeline: numerically identical, zero delta everywhere, gates pass", async () => {
    const a = await runHermeticEval();
    const b = await runHermeticEval();
    const cmp = compareTiers(a, b);
    expect(cmp.identical).toBe(true);
    expect(cmp.fields.every((f) => f.delta === 0)).toBe(true);
    expect(cmp.categories.every((c) => c.delta === 0)).toBe(true);
    expect(cmp.gatesPassed).toBe(true);
  }, 30_000);
});

describe("renderCompareMarkdown (golden structure)", () => {
  it("renders the stable report skeleton (structural)", () => {
    const { hermetic, live } = syntheticCompareInput();
    const markdown = renderCompareMarkdown({ hermetic, live, generatedAt: "2026-09-17T10:06:00.000Z", liveFromCache: false });
    expect(markdown.startsWith("# Extraction eval report — live vs hermetic")).toBe(true);
    expect(markdown).toContain("- Generated: 2026-09-17T10:06:00.000Z");
    expect(markdown).toContain("- Golden set: 4 items (v2)");
    expect(markdown).toContain("source: fresh run");
    expect(markdown).toContain("## Per-field comparison");
    expect(markdown).toContain("| F1 | 1.000 | 0.800 | -0.200 |");
    expect(markdown).toContain("| state acc | 1.000 | 0.667 | -0.333 |");
    expect(markdown).toContain("## Commitment-state accuracy");
    expect(markdown).toContain("## Calibration");
    expect(markdown).toContain("## Per-category accuracy");
    expect(markdown).toContain("| negation * | 1 | 1.000 | 0.000 | -1.000 |");
    expect(markdown).toContain("## Injection hygiene");
    expect(markdown).toContain("## Gates (evaluated against the LIVE tier)");
    expect(markdown).toContain("| overall-f1 | >= 0.80 | 0.800 | PASS |");
    expect(markdown).toContain("| action-precision | >= 0.90 | 0.667 | FAIL |");
    expect(markdown).toContain("| commitment-state-accuracy | >= 0.80 | 0.667 | FAIL |");
    expect(markdown).toContain("LIVE GATES FAIL");
  });

  it("cache round-trip: a JSON-serialized live result renders the identical report", () => {
    const { hermetic, live } = syntheticCompareInput();
    const cached = JSON.parse(JSON.stringify(live));
    const a = renderCompareMarkdown({ hermetic, live, generatedAt: "2026-09-17T10:06:00.000Z", liveFromCache: false });
    const b = renderCompareMarkdown({ hermetic, live: cached, generatedAt: "2026-09-17T10:06:00.000Z", liveFromCache: true });
    expect(b).toBe(a.replace("source: fresh run", "source: cached .last-live.json"));
  });

  it("verdict flips to PASS when live gates clear", () => {
    const { hermetic } = syntheticCompareInput();
    // All-correct high-confidence predictions: F1 1.0, action-precision 1.0,
    // state accuracy 1.0.
    const passingPreds = new Map<string, EvalPrediction>([
      ["base-01", pred({ isCommitment: true, direction: "i_owe", counterparty: "Jehad", confidence: 0.9, temporal: { rawExpression: "Friday", normalizedTime: "2026-09-18", resolutionStatus: "resolved" } })],
      ["base-02", pred({ isCommitment: true, confidence: 0.8 })],
      ["hard-negation-01", pred({ confidence: 0.6, commitmentState: "cancelled" })],
      ["hard-injection-01", pred({})],
    ]);
    const passingLive = tierRun(passingPreds, LIVE_META);
    expect(passingLive.gates.passed).toBe(true);
    const markdown = renderCompareMarkdown({
      hermetic,
      live: { skipped: false, run: passingLive, spend: { totalUsd: 0.01, calls: 4, budgetWarnings: 0 }, ledger: { rows: 4, errorRows: 0, totalCostUsd: 0.01 }, parseFailures: [], hygiene: { checks: [], passed: true }, dbName: "jehad_test_evalive" },
      generatedAt: "2026-09-17T10:06:00.000Z",
      liveFromCache: false,
    });
    expect(markdown).toContain("LIVE GATES PASS — the live tier clears the bar");
  });
});

describe("renderCompareConsole", () => {
  it("prints the side-by-side table, category deltas, gates, and cache flag", () => {
    const { hermetic, live } = syntheticCompareInput();
    const cmp = compareTiers(hermetic, live.run);
    const out = renderCompareConsole(cmp, true);
    expect(out).toMatch(/^ {2}metric\s+hermetic\s+live\s+Δ \(live−hermetic\)\s+\[live: cached \.last-live\.json\]$/m);
    expect(out).toMatch(/^ {2}F1\s+1\.000\s+0\.800\s+-0\.200$/m);
    expect(out).toMatch(/^ {2}state acc\s+1\.000\s+0\.667\s+-0\.333$/m);
    expect(out).toMatch(/^\s\*negation\s+n=\s*1\s+1\.000\s+0\.000\s+-1\.000$/m);
    expect(out).toMatch(/PASS {2}overall-f1 >= 0\.80 — live 0\.800$/m);
    expect(out).toMatch(/FAIL {2}action-precision >= 0\.90 — live 0\.667$/m);
    expect(out).toMatch(/FAIL {2}commitment-state-accuracy >= 0\.80 — live 0\.667$/m);
    expect(out).not.toContain("numerically identical");
  });

  it("notes numerical identity (EVAL_FAKE_LIVE dry-run expectation)", async () => {
    const a = await runHermeticEval();
    const out = renderCompareConsole(compareTiers(a, a), false);
    expect(out).toContain("Tiers are numerically identical with zero delta (expected for an EVAL_FAKE_LIVE dry-run).");
  }, 30_000);
});

describe("reportFileName", () => {
  it("stamps UTC .eval-report-<YYYYMMDD-HHMMSS>.md", () => {
    expect(reportFileName("2026-09-17T23:06:05.123Z")).toBe(".eval-report-20260917-230605.md");
    expect(reportFileName("2026-01-02T00:00:00.000Z")).toBe(".eval-report-20260102-000000.md");
  });
});
