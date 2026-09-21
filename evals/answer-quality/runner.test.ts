// W3 answer-quality bake-off — hermetic tests (no network, no DB).

import { describe, expect, it } from "vitest";
import {
  type AnswerFixtures,
  type ScoredReply,
  RUBRIC_ITEMS,
  buildJudgePrompt,
  buildScenarioPrompt,
  checkPromptStructure,
  fixturesPath,
  hermeticPipelineSmoke,
  loadAnswerFixtures,
  modelFamily,
  parseJudgeScores,
  projectedWithinCeiling,
  summarizeModel,
} from "./runner.js";

const fixtures: AnswerFixtures = loadAnswerFixtures(fixturesPath());

describe("answer-quality fixtures", () => {
  it("carry the planned breadth (~24 scenarios across all four groups)", () => {
    expect(fixtures.scenarios.length).toBeGreaterThanOrEqual(24);
    const groups = new Map<string, number>();
    for (const scenario of fixtures.scenarios) {
      groups.set(scenario.group, (groups.get(scenario.group) ?? 0) + 1);
    }
    expect(groups.get("synthesis")).toBeGreaterThanOrEqual(8);
    expect(groups.get("multiturn")).toBeGreaterThanOrEqual(5);
    expect(groups.get("explainwhy")).toBeGreaterThanOrEqual(5);
    expect(groups.get("plainchat")).toBeGreaterThanOrEqual(6);
    expect(new Set(fixtures.scenarios.map((s) => s.id)).size).toBe(fixtures.scenarios.length);
  });

  it("malformed fixtures fail closed", () => {
    expect(() => loadAnswerFixtures("/nonexistent/fixtures.json")).toThrow();
  });
});

describe("answer-quality prompt structure (hermetic, REAL buildAnswerPrompt)", () => {
  it("every scenario prompt carries its question, DATA boundary iff results, HISTORY iff prior turns", () => {
    expect(checkPromptStructure(fixtures)).toEqual([]);
  });

  it("multi-turn scenarios render a flattened history block with the prior exchange", () => {
    const scenario = fixtures.scenarios.find((s) => s.id === "M01");
    expect(scenario).toBeDefined();
    const prompt = buildScenarioPrompt(fixtures.principalName, "fake/candidate", scenario!);
    expect(prompt).toContain("BEGIN HISTORY");
    expect(prompt).toContain("I'm picking between two windows");
  });
});

describe("blind judge (R5)", () => {
  const scenario = fixtures.scenarios[0]!;

  it("judge prompt contains scenario + reply but never a candidate model name", () => {
    const prompt = buildJudgePrompt(scenario, "A reply mentioning Henna.");
    expect(prompt).toContain(scenario.question);
    expect(prompt).toContain("A reply mentioning Henna.");
    expect(prompt).toContain("impartial quality evaluator");
    for (const forbidden of ["gpt-4.1", "sonnet", "4o-mini", "candidate model", "openai/", "anthropic/", "google/"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it("judge scores parse only well-formed 1-5 integer rubric JSON", () => {
    const good = '{"groundedness":5,"prioritization":4,"honesty":5,"concision":3,"referents":5,"notes":"fine"}';
    expect(parseJudgeScores(good)?.honesty).toBe(5);
    expect(parseJudgeScores(`prose {"groundedness":1,"prioritization":1,"honesty":1,"concision":1,"referents":1,"notes":"x"} trailing`)).not.toBeNull();
    expect(parseJudgeScores('{"groundedness":0,"prioritization":1,"honesty":1,"concision":1,"referents":1}')).toBeNull();
    expect(parseJudgeScores('{"groundedness":6,"prioritization":1,"honesty":1,"concision":1,"referents":1}')).toBeNull();
    expect(parseJudgeScores('{"groundedness":2.5,"prioritization":1,"honesty":1,"concision":1,"referents":1}')).toBeNull();
    expect(parseJudgeScores('{"prioritization":1,"honesty":1,"concision":1,"referents":1}')).toBeNull();
    expect(parseJudgeScores("no json at all")).toBeNull();
  });

  it("the default judge family is independent of every default candidate family", () => {
    const judge = "google/gemini-2.5-flash";
    for (const candidate of ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5", "openai/gpt-4o-mini"]) {
      expect(modelFamily(candidate)).not.toBe(modelFamily(judge));
    }
  });
});

describe("aggregation + spend guard", () => {
  const record = (over: Partial<ScoredReply>): ScoredReply => ({
    scenarioId: "S01",
    group: "synthesis",
    model: "a/model",
    reply: "",
    scores: { groundedness: 5, prioritization: 4, honesty: 5, concision: 3, referents: 5, notes: "" },
    latencyMs: 100,
    costUsd: 0.01,
    promptTokens: 100,
    completionTokens: 50,
    ...over,
  });

  it("summarizeModel means over scored records only; judge failures and errors counted separately", () => {
    const summary = summarizeModel("a/model", [
      record({}),
      record({ scores: null }),
      record({ error: "boom" }),
      record({ scenarioId: "S02", scores: { groundedness: 1, prioritization: 1, honesty: 1, concision: 1, referents: 1, notes: "" } }),
    ]);
    expect(summary.scored).toBe(2);
    expect(summary.judgeFailures).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.overallMean).toBeCloseTo((22 / 5 + 1) / 2, 10); // (4.4 + 1)/2
    expect(summary.perRubric.groundedness).toBe(3);
    expect(summary.perRubric.concision).toBe(2);
    expect(summary.totalCostUsd).toBeCloseTo(0.03, 10);
  });

  it("projection aborts before a call that would breach the ceiling", () => {
    // 10 calls done at $0.20 each ($2.00) of 20 planned → projection $4.00 > $3 → abort.
    expect(projectedWithinCeiling({ spendUsd: 2.0, completedCalls: 10, plannedCalls: 20, ceilingUsd: 3.0 })).toBe(false);
    // 10 calls done at $0.05 each ($0.50) of 20 planned → projection $1.00 ≤ $3 → continue.
    expect(projectedWithinCeiling({ spendUsd: 0.5, completedCalls: 10, plannedCalls: 20, ceilingUsd: 3.0 })).toBe(true);
    // No data yet → never abort.
    expect(projectedWithinCeiling({ spendUsd: 0, completedCalls: 0, plannedCalls: 100, ceilingUsd: 3.0 })).toBe(true);
  });
});

describe("hermetic pipeline smoke (fake provider)", () => {
  it("scripted reply → blind judge → rubric parse runs green end to end", async () => {
    const failures = await hermeticPipelineSmoke(fixtures);
    expect(failures).toEqual([]);
  });
});

describe("rubric vocabulary", () => {
  it("is exactly the five W3 rubric items", () => {
    expect([...RUBRIC_ITEMS]).toEqual(["groundedness", "prioritization", "honesty", "concision", "referents"]);
  });
});
