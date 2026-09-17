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
    is_commitment: false,
    temporal_expression: null,
    resolved_due_date: null,
    resolution_status: "none",
    commitment_state: "active",
  }),
  item("hard-negation-01", "negation", {
    is_commitment: true,
    direction: "i_owe",
    counterparty: "Sara",
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
    commitment_state: "active",
  }),
];

function pred(overrides: Partial<EvalPrediction>): EvalPrediction {
  return {
    isCommitment: false,
    direction: null,
    counterparty: null,
    confidence: 0.2,
    commitmentState: "active",
    temporal: null,
    ...overrides,
  };
}

const HERMETIC_PREDS = new Map<string, EvalPrediction>([
  ["base-01", pred({ isCommitment: true, direction: "i_owe", counterparty: "Jehad", confidence: 0.9, temporal: { rawExpression: "Friday", normalizedTime: "2026-09-18", resolutionStatus: "resolved" } })],
  ["base-02", pred({ isCommitment: true, confidence: 0.8 })],
  ["hard-negation-01", pred({ confidence: 0.3, commitmentState: "active" })], // state miss
  ["hard-injection-01", pred({})],
]);

const LIVE_PREDS = new Map<string, EvalPrediction>([
  ["base-01", pred({ isCommitment: true, direction: "i_owe", counterparty: "Jehad", confidence: 0.9, temporal: { rawExpression: "Friday", normalizedTime: "2026-09-18", resolutionStatus: "resolved" } })],
  ["base-02", pred({ isCommitment: true, confidence: 0.8 })],
  ["hard-negation-01", pred({ isCommitment: true, direction: "i_owe", counterparty: "Sara", confidence: 0.6, commitmentState: "cancelled", temporal: { rawExpression: null, normalizedTime: null, resolutionStatus: "none" } })],
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
    expect(f1.hermetic).toBeCloseTo(0.5);
    expect(f1.live).toBeCloseTo(0.8, 3);
    expect(f1.delta).toBeCloseTo(0.3, 3);
    const stateAcc = cmp.fields.find((f) => f.label === "state acc")!;
    expect(stateAcc.hermetic).toBeCloseTo(0.75);
    expect(stateAcc.live).toBe(1);
    const negation = cmp.categories.find((c) => c.category === "negation")!;
    expect(negation.hermetic).toBe(0);
    expect(negation.live).toBe(1);
    expect(cmp.identical).toBe(false);
    expect(cmp.gatesPassed).toBe(false);
    expect(cmp.gates.map((g) => [g.name, g.passed])).toEqual([
      ["overall-f1", true],
      ["action-precision", false],
      ["commitment-state-accuracy", true],
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
  it("renders the stable report skeleton with exact numbers", () => {
    const { hermetic, live } = syntheticCompareInput();
    const markdown = renderCompareMarkdown({ hermetic, live, generatedAt: "2026-09-17T10:06:00.000Z", liveFromCache: false });
    expect(markdown).toBe(`# Extraction eval report — live vs hermetic

- Generated: 2026-09-17T10:06:00.000Z
- Golden set: 4 items (v2)
- Hermetic tier: eval-fake / eval-fake-heuristic-v2 — ran 2026-09-17T10:00:00.000Z
- Live tier: openrouter / openai/gpt-4o-mini — ran 2026-09-17T10:05:00.000Z — source: fresh run
- Live spend: $0.0123 across 4 model_calls rows on isolated db \`jehad_test_evalive\` (0 error rows) · parse failures: none

## Per-field comparison

| Metric | Hermetic | Live | Δ (live−hermetic) |
| --- | --- | --- | --- |
| F1 | 0.500 | 0.800 | +0.300 |
| precision | 0.500 | 0.667 | +0.167 |
| recall | 0.500 | 1.000 | +0.500 |
| FPR | 0.500 | 0.500 | 0.000 |
| due-date acc (e2e) | 1.000 | 1.000 | 0.000 |
| normalizer acc | 1.000 | 1.000 | 0.000 |
| state acc | 0.750 | 1.000 | +0.250 |
| direction acc | 1.000 | 1.000 | 0.000 |
| counterparty acc | 1.000 | 1.000 | 0.000 |
| conf-in-band acc | 1.000 | 1.000 | 0.000 |
| action-precision | 0.500 | 0.500 | 0.000 |

## Commitment-state accuracy (per state; scored on every golden item)

| State | n (H/L) | Hermetic | Live |
| --- | --- | --- | --- |
| active | 3/3 | 1.000 | 1.000 |
| cancelled | 1/1 | 0.000 | 1.000 |

## Calibration (commitment predictions, bucketed)

| Bucket | n (H/L) | mean conf (H/L) | observed acc (H/L) |
| --- | --- | --- | --- |
| [0.00,0.50) | 0/0 | 0.000 / 0.000 | 1.000 / 1.000 |
| [0.50,0.70) | 0/1 | 0.000 / 0.600 | 1.000 / 1.000 |
| [0.70,0.85) | 1/1 | 0.800 / 0.800 | 0.000 / 0.000 |
| [0.85,1.00] | 1/1 | 0.900 / 0.900 | 1.000 / 1.000 |

## Per-category accuracy (Δ = live − hermetic; * marks hard-case categories)

| Category | n | Hermetic | Live | Δ |
| --- | --- | --- | --- | --- |
| base | 2 | 0.500 | 0.500 | 0.000 |
| negation * | 1 | 0.000 | 1.000 | +1.000 |
| prompt-injection * | 1 | 1.000 | 1.000 | 0.000 |

## Injection hygiene

| Tier | Item | Result | Notes |
| --- | --- | --- | --- |
| hermetic | hard-injection-01 | PASS | 3 instruction field(s) stripped by the allowlist, none stored |
| live | hard-injection-01 | PASS | no instruction content stored (3 field(s) dropped) |

## Gates (evaluated against the LIVE tier)

| Gate | Requirement | Live | Result |
| --- | --- | --- | --- |
| overall-f1 | >= 0.80 | 0.800 | PASS |
| action-precision | >= 0.90 | 0.500 | FAIL |
| commitment-state-accuracy | >= 0.80 | 1.000 | PASS |

## Verdict

LIVE GATES FAIL — do NOT wire Calendar automation yet: the live tier must clear F1 ≥ 0.80, action-precision ≥ 0.90, and commitment-state accuracy ≥ 0.80 first.
`);
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
      ["base-02", pred({})],
      ["hard-negation-01", pred({ isCommitment: true, direction: "i_owe", counterparty: "Sara", confidence: 0.9, commitmentState: "cancelled", temporal: { rawExpression: null, normalizedTime: null, resolutionStatus: "none" } })],
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
    expect(out).toMatch(/^ {2}F1\s+0\.500\s+0\.800\s+\+0\.300$/m);
    expect(out).toMatch(/^ {2}state acc\s+0\.750\s+1\.000\s+\+0\.250$/m);
    expect(out).toMatch(/^\s\*negation\s+n=\s*1\s+0\.000\s+1\.000\s+\+1\.000$/m);
    expect(out).toMatch(/^\s\sbase\s+n=\s*2\s+0\.500\s+0\.500\s+0\.000$/m);
    expect(out).toMatch(/PASS {2}overall-f1 >= 0\.80 — live 0\.800$/m);
    expect(out).toMatch(/FAIL {2}action-precision >= 0\.90 — live 0\.500$/m);
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
