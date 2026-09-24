// §5 Track A runner — hermetic tests (fake provider, zero network).
// Pins: the plan §5 candidate list, the extended candidates[] schema
// writer (per-scenario five-dim scores, mean, total cost, p50/p95), the
// judge-family refusal, and the full-grid hermetic dry run.

import { describe, expect, it } from "vitest";
import {
  type ScoredReply,
  fixturesPath,
  loadAnswerFixtures,
  modelFamily,
} from "../answer-quality/runner.js";
import {
  type TrackACandidateSummary,
  runTrackAWithOptions,
  smokeMeasuresOf,
  summarizeCandidate,
  trackAMarkdown,
} from "./track-a.js";
import { TRACK_A_CANDIDATES } from "./shared.js";

const fixtures = loadAnswerFixtures(fixturesPath());

const record = (over: Partial<ScoredReply>): ScoredReply => ({
  scenarioId: "S01",
  group: "synthesis",
  model: "a/model",
  reply: "r",
  scores: { groundedness: 5, prioritization: 4, honesty: 5, concision: 3, referents: 5, notes: "" },
  latencyMs: 100,
  costUsd: 0.01,
  promptTokens: 100,
  completionTokens: 50,
  ...over,
});

describe("plan §5 candidate surface", () => {
  it("is exactly the six §5 candidates in plan order", () => {
    expect([...TRACK_A_CANDIDATES]).toEqual([
      "openai/gpt-4o-mini",
      "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4.1",
      "anthropic/claude-opus-4.6",
      "google/gemini-3.8-flash",
    ]);
  });

  it("the default judge family is NOT independent of every default candidate — surfaced, not silent", () => {
    // The plan picked google/gemini-2.5-flash as judge AND google/gemini-3.8-flash
    // as candidate #6: same family. The live runner must refuse (R5); this pin
    // keeps the conflict visible instead of silently weakening the rule.
    const judgeFamily = modelFamily("google/gemini-2.5-flash");
    const families = new Set(TRACK_A_CANDIDATES.map(modelFamily));
    expect(families.has(judgeFamily)).toBe(true);
  });
});

describe("candidates[] schema writer", () => {
  it("summarizeCandidate carries per-scenario five-dim scores, mean, cost, p50/p95", () => {
    const summary: TrackACandidateSummary = summarizeCandidate("a/model", [
      record({ latencyMs: 100 }),
      record({ scenarioId: "S02", latencyMs: 300, scores: { groundedness: 1, prioritization: 1, honesty: 1, concision: 1, referents: 1, notes: "" } }),
      record({ scenarioId: "S03", scores: null }),
      record({ scenarioId: "S04", error: "candidate: boom" }),
    ]);
    expect(summary.scored).toBe(2);
    expect(summary.judgeFailures).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.mean).toBeCloseTo((22 / 5 + 1) / 2, 10);
    expect(summary.perScenario).toHaveLength(4);
    expect(summary.perScenario[0]).toMatchObject({ scenarioId: "S01", mean: 4.4 });
    expect(summary.perScenario[2]?.scores).toBeNull();
    expect(summary.totalCostUsd).toBeCloseTo(0.03, 10);
    expect(summary.p50LatencyMs).toBe(100);
    expect(summary.p95LatencyMs).toBe(300);
    // five-dim rubric intact
    expect(Object.keys(summary.perRubric).sort()).toEqual([
      "concision",
      "groundedness",
      "honesty",
      "prioritization",
      "referents",
    ]);
  });

  it("smokeMeasuresOf derives per-candidate means + judge spend per completed call", () => {
    const measures = smokeMeasuresOf(
      [
        record({ model: "m/1", scenarioId: "S01", costUsd: 0.002 }),
        record({ model: "m/1", scenarioId: "S02", costUsd: 0.004 }),
        record({ model: "m/2", scenarioId: "S01", costUsd: 0.01 }),
        record({ model: "m/2", scenarioId: "S02", costUsd: 0.03, error: "candidate: boom" }),
      ],
      ["m/1", "m/2"],
      0.0009,
      3,
    );
    expect(measures.candidatePerAnswerUsd.get("m/1")).toBeCloseTo(0.003, 10);
    expect(measures.candidatePerAnswerUsd.get("m/2")).toBeCloseTo(0.01, 10); // errored S02 excluded, S01 kept
    expect(measures.judgePerCallUsd).toBeCloseTo(0.0003, 10);
    // All measured costs count toward smoke spend (live errored records carry
    // costUsd null, so this sums the real paid calls).
    expect(measures.smokeSpendUsd).toBeCloseTo(0.002 + 0.004 + 0.01 + 0.03 + 0.0009, 10);
  });
});

describe("live-mode guards (no network reachable in these paths)", () => {
  it("REFUSES a judge sharing a family with a candidate (R5) before any call", async () => {
    // live:true would verify model ids over the network — the family check
    // fires FIRST and returns before that, so this test never reaches IO.
    const result = await runTrackAWithOptions(fixtures, "key-not-used", {
      candidates: [...TRACK_A_CANDIDATES],
      judge: "google/gemini-2.5-flash", // google family vs google/gemini-3.8-flash
      live: true,
      dryRunReason: null,
      smokeOnly: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.records).toHaveLength(0);
    expect(String(result.raw["error"])).toContain("refusing self-family judging");
    expect(String(result.raw["error"])).toContain("--judge");
  });
});

describe("hermetic full-grid dry run (fake provider, no network)", () => {
  it("runs every scenario × candidate, scores via the scripted judge, writes the extended schema", async () => {
    const result = await runTrackAWithOptions(fixtures, "", {
      candidates: ["fake/one", "fake/two"],
      judge: "google/gemini-2.5-flash",
      live: false,
      dryRunReason: "test hermetic",
      smokeOnly: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.records).toHaveLength(fixtures.scenarios.length * 2);
    const raw = result.raw as {
      track: string;
      candidates: TrackACandidateSummary[];
      models: Record<string, ScoredReply[]>;
      live: boolean;
      smoke: unknown;
      aborted: string | null;
    };
    expect(raw.track).toBe("A");
    expect(raw.live).toBe(false);
    expect(raw.smoke).toBeNull(); // smoke gate is live-only
    expect(raw.aborted).toBeNull();
    expect(raw.candidates).toHaveLength(2);
    for (const candidate of raw.candidates) {
      expect(candidate.scored).toBe(fixtures.scenarios.length);
      expect(candidate.perScenario).toHaveLength(fixtures.scenarios.length);
      expect(candidate.mean).toBeCloseTo(23 / 5, 10); // scripted 5,4,5,4,5
      expect(candidate.totalCostUsd).toBe(0); // hermetic: no live costs
    }
    // Same blind-judge contract as the W3 runner: every record scored.
    expect(raw.models["fake/one"]!.every((r) => r.scores !== null)).toBe(true);
  });

  it("the hermetic markdown report renders the per-candidate table + decision ladder", async () => {
    const result = await runTrackAWithOptions(fixtures, "", {
      candidates: ["fake/one"],
      judge: "google/gemini-2.5-flash",
      live: false,
      dryRunReason: "test hermetic",
      smokeOnly: false,
    });
    const md = trackAMarkdown({
      fixtures,
      raw: result.raw,
      candidates: result.raw["candidates"] as TrackACandidateSummary[],
    });
    expect(md).toContain("fake/one");
    expect(md).toContain("+0.3");
    expect(md).toContain("HERMETIC dry run");
    expect(md).toContain("24 → 12"); // trim order note
  });
});
