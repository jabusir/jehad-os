import { describe, expect, it } from "vitest";
import { loadScenarioFile } from "./scenarios.js";
import { runConversationEval } from "./runner.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const FILE = new URL("./scenarios-memory.yaml", import.meta.url).pathname;

describe("scenarios-memory.yaml (precision/recall fixtures, lane W2)", () => {
  it("validates and carries exactly the two memory scenarios with unique ids", () => {
    const file = loadScenarioFile(FILE);
    expect(file.version).toBe(1);
    expect(file.scenarios.map((scenario) => scenario.id)).toEqual([
      "memory-recall-01",
      "memory-recall-none-01",
    ]);
  });

  it("the recall-relevant scenario requires memory.recall and pins routing + attribution", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "memory-recall-01")!;
    expect(scenario.requires).toEqual(["memory.recall"]);
    expect(scenario.expectations.routedTools).toEqual(["memory.recall"]);
    expect(scenario.expectations.replyContains).toEqual(["Sep 12", "user_declared"]);
    expect(scenario.expectations.dbPins).toEqual([
      { sql: "SELECT 1 FROM memory_candidates", expectOne: false, expectZero: true },
    ]);
  });

  it("the no-relevant-memory scenario must not fabricate memory", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "memory-recall-none-01")!;
    expect(scenario.requires).toEqual(["memory.recall"]);
    expect(scenario.expectations.routedNone).toBe(true);
    expect(scenario.expectations.replyNotContains).toContain("per your decision");
    expect(scenario.expectations.replyNotContains).toContain("per your commitment");
    expect(scenario.expectations.dbPins).toEqual([
      { sql: "SELECT 1 FROM memory_candidates", expectOne: false, expectZero: true },
    ]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("memory scenarios skip until the orchestrator wires memory.recall", () => {
  it("every scenario skips when the capability probe is unavailable", async () => {
    const file = loadScenarioFile(FILE);
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      scenarios: file.scenarios,
      capabilityProbes: {},
      dbTag: "conv_eval_w2",
    });
    expect(run.counts).toEqual({ pass: 0, fail: 0, skip: 2 });
    for (const result of run.results) {
      expect(result.status).toBe("skip");
      expect(result.reason).toContain("memory.recall");
    }
  });
});
