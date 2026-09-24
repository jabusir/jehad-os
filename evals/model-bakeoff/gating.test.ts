// §5 model bake-off — hermetic tests for the spend-gating math (plan §5:
// Track A $4, probe $1, smoke-measured projection before the full run).

import { describe, expect, it } from "vitest";
import {
  PROBE_CEILING_USD,
  SMOKE_SCENARIOS,
  TRACK_A_CEILING_USD,
  gateFullRun,
  meanOf,
  percentile,
  projectFullRun,
} from "./gating.js";

describe("smoke projection (Track A shape)", () => {
  it("projects measured means × remaining scenarios × candidates + judge share + smoke spend", () => {
    // 6 candidates at $0.01/answer, judge $0.002/call, smoke spent $0.144:
    // 24 scenarios, 2 smoked → remaining 22 per candidate.
    const perAnswer = new Map(
      [...Array(6).keys()].map((i) => [`m/${i}`, 0.01]),
    );
    const projected = projectFullRun({
      measures: { candidatePerAnswerUsd: perAnswer, judgePerCallUsd: 0.002, smokeSpendUsd: 0.144 },
      totalScenarios: 24,
      smokeScenarios: SMOKE_SCENARIOS,
    });
    // 6×0.01×22 + 0.002×22×6 + 0.144 = 1.32 + 0.264 + 0.144 = 1.728
    expect(projected).toBeCloseTo(1.728, 10);
  });

  it("frontier-priced grid breaches the $4 split and the gate refuses", () => {
    // The §5 planning shape: 5 candidates at cents + opus at $0.10/answer.
    const perAnswer = new Map<string, number>([
      ["openai/gpt-4o-mini", 0.0001],
      ["openai/gpt-4.1-mini", 0.0002],
      ["anthropic/claude-sonnet-4.5", 0.0031],
      ["openai/gpt-4.1", 0.0015],
      ["google/gemini-3.8-flash", 0.0005],
      ["anthropic/claude-opus-4.6", 0.1], // frontier planning rate
    ]);
    const projected = projectFullRun({
      measures: { candidatePerAnswerUsd: perAnswer, judgePerCallUsd: 0.0004, smokeSpendUsd: 0.21 },
      totalScenarios: 24,
      smokeScenarios: SMOKE_SCENARIOS,
    });
    const gate = gateFullRun(projected, TRACK_A_CEILING_USD);
    // 22 × (0.1054 + 6×0.0004) + 0.21 ≈ 2.68 — actually inside $4: OPEN.
    expect(gate.ok).toBe(true);
    expect(gate.headroomUsd).toBeGreaterThan(0);
    // Doubling the frontier rate (0.2/answer) pushes past $4 → REFUSED.
    const steep = projectFullRun({
      measures: {
        candidatePerAnswerUsd: new Map(perAnswer).set("anthropic/claude-opus-4.6", 0.2),
        judgePerCallUsd: 0.0004,
        smokeSpendUsd: 0.41,
      },
      totalScenarios: 24,
      smokeScenarios: SMOKE_SCENARIOS,
    });
    expect(gateFullRun(steep, TRACK_A_CEILING_USD).ok).toBe(false);
    expect(gateFullRun(steep, TRACK_A_CEILING_USD).reason).toContain("trim");
  });

  it("gate is exactly at the ceiling boundary (<= passes)", () => {
    const gate = gateFullRun(4.0, TRACK_A_CEILING_USD);
    expect(gate.ok).toBe(true);
    expect(gateFullRun(4.0001, TRACK_A_CEILING_USD).ok).toBe(false);
  });

  it("probe projection gates at the $1 split", () => {
    // 6 candidates × $0.0006/turn (route+interpret) × 34 turns:
    const perAnswer = new Map([...Array(6).keys()].map((i) => [`m/${i}`, 0.0006]));
    const projected = projectFullRun({
      measures: { candidatePerAnswerUsd: perAnswer, judgePerCallUsd: 0, smokeSpendUsd: 0.0072 },
      totalScenarios: 34,
      smokeScenarios: 2,
    });
    // 32 × 6 × 0.0006 + 0.0072 = 0.1152 + 0.0072
    expect(projected).toBeCloseTo(0.1224, 10);
    expect(gateFullRun(projected, PROBE_CEILING_USD).ok).toBe(true);
  });
});

describe("aggregation helpers", () => {
  it("meanOf is null on empty and exact otherwise", () => {
    expect(meanOf([])).toBeNull();
    expect(meanOf([1, 2, 3])).toBe(2);
  });

  it("percentile is nearest-rank (p95 rounds up)", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });
});
