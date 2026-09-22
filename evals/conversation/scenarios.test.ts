import { describe, expect, it } from "vitest";
import {
  ScenarioFormatError,
  loadScenarioFile,
  parseScenarioFile,
} from "./scenarios.js";

const FILE = new URL("./scenarios.yaml", import.meta.url).pathname;

function baseScenario(): Record<string, unknown> {
  return {
    id: "s1",
    description: "trivial",
    principal: "jehad",
    turns: [
      {
        user: "hello there",
        modelScript: [
          { pass: "route", output: '{"tool":"none"}' },
          { pass: "answer", output: "hi" },
        ],
      },
    ],
    expectations: { routed_none: true },
  };
}

function expectInvalid(raw: unknown): void {
  expect(() => parseScenarioFile(raw)).toThrow(ScenarioFormatError);
}

describe("scenarios.yaml (checked-in suite)", () => {
  it("validates and carries exactly the four v1 scenarios with unique ids", () => {
    const file = loadScenarioFile(FILE);
    expect(file.version).toBe(1);
    expect(file.scenarios.map((scenario) => scenario.id)).toEqual([
      "referent-continuity-01",
      "daystate-grounding-01",
      "staleness-honesty-01",
      "plain-chat-none-01",
    ]);
  });

  it("referent continuity: two scripted turns, final turn expects the same calendar read", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "referent-continuity-01")!;
    expect(scenario.turns).toHaveLength(2);
    expect(scenario.turns[0]!.modelScript.map((p) => p.pass)).toEqual(["route", "answer"]);
    expect(scenario.turns[1]!.modelScript[0]).toEqual({
      pass: "route",
      output: '{"tool":"calendar.day","day":"tomorrow"}',
    });
    expect(scenario.expectations.routedTools).toEqual(["calendar.day"]);
    expect(scenario.expectations.dbPins).toEqual([
      { sql: "SELECT 1 FROM interaction_threads WHERE status = 'active'", expectOne: true, expectZero: false },
    ]);
  });

  it("day.state grounding declares requires: [day.state] and a section-label expectation", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "daystate-grounding-01")!;
    expect(scenario.requires).toEqual(["day.state"]);
    expect(scenario.expectations.routedTools).toEqual(["day.state"]);
    expect(scenario.expectations.replyContains).toEqual(["WAITING"]);
  });

  it("staleness honesty declares requires: [staleness]", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "staleness-honesty-01")!;
    expect(scenario.requires).toEqual(["staleness"]);
    expect(scenario.expectations.replyContains).toEqual(["synced"]);
  });

  it("plain chat expects routed_none and no fabricated world state", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "plain-chat-none-01")!;
    expect(scenario.requires).toEqual([]);
    expect(scenario.expectations.routedNone).toBe(true);
    expect(scenario.expectations.replyContains).toEqual(["Canberra"]);
    expect(scenario.expectations.replyNotContains).toEqual(["calendar", "commitment"]);
  });
});

describe("scenario file validation", () => {
  it("accepts the base shape and defaults requires to empty", () => {
    const file = parseScenarioFile({ version: 1, scenarios: [baseScenario()] });
    expect(file.scenarios[0]!.requires).toEqual([]);
  });

  it("rejects a wrong version", () => {
    expectInvalid({ version: 2, scenarios: [baseScenario()] });
  });

  it("rejects a non-mapping document and an empty scenario list", () => {
    expectInvalid("nope");
    expectInvalid({ version: 1, scenarios: [] });
  });

  it("rejects duplicate ids", () => {
    expectInvalid({ version: 1, scenarios: [baseScenario(), baseScenario()] });
  });

  it("rejects an unknown script pass", () => {
    const raw = baseScenario() as { turns: { modelScript: { pass: string }[] }[] };
    raw.turns[0]!.modelScript[0]!.pass = "tool";
    expectInvalid({ version: 1, scenarios: [raw] });
  });

  it("rejects empty turns, empty modelScript, and a blank user line", () => {
    const emptyTurns = baseScenario();
    emptyTurns["turns"] = [];
    expectInvalid({ version: 1, scenarios: [emptyTurns] });

    // Empty modelScript is VALID since W6a — it encodes a deterministic
    // turn (confirm verbs) with zero expected model dispatches.
    const deterministicScript = baseScenario() as { turns: { modelScript: unknown[] }[] };
    deterministicScript.turns[0]!.modelScript = [];
    const ok = parseScenarioFile({ version: 1, scenarios: [deterministicScript] });
    expect(ok.scenarios[0]!.turns[0]!.modelScript).toEqual([]);

    const blankUser = baseScenario() as { turns: { user: string }[] };
    blankUser.turns[0]!.user = "  ";
    expectInvalid({ version: 1, scenarios: [blankUser] });
  });

  it("rejects expectations with neither key and routed_tools together with routed_none", () => {
    const none = baseScenario();
    delete none["expectations"];
    expectInvalid({ version: 1, scenarios: [none] });

    const both = baseScenario() as {
      expectations: { routed_tools?: string[] };
    };
    both.expectations["routed_tools"] = ["calendar.day"];
    expectInvalid({ version: 1, scenarios: [both] });
  });

  it("rejects db pins without a flag, with both flags, and with write SQL", () => {
    const noFlag = baseScenario() as { expectations: Record<string, unknown> };
    noFlag.expectations = { db_pins: [{ sql: "SELECT 1" }] };
    expectInvalid({ version: 1, scenarios: [noFlag] });

    const bothFlags = baseScenario() as { expectations: Record<string, unknown> };
    bothFlags.expectations = { db_pins: [{ sql: "SELECT 1", expect_one: true, expect_zero: true }] };
    expectInvalid({ version: 1, scenarios: [bothFlags] });

    const write = baseScenario() as { expectations: Record<string, unknown> };
    write.expectations = { db_pins: [{ sql: "DELETE FROM interaction_messages", expect_one: true }] };
    expectInvalid({ version: 1, scenarios: [write] });

    const multi = baseScenario() as { expectations: Record<string, unknown> };
    multi.expectations = { db_pins: [{ sql: "SELECT 1; SELECT 2", expect_zero: true }] };
    expectInvalid({ version: 1, scenarios: [multi] });
  });

  it("rejects an empty requires array and empty routed_tools", () => {
    const emptyRequires = baseScenario();
    emptyRequires["requires"] = [];
    expectInvalid({ version: 1, scenarios: [emptyRequires] });

    const emptyTools = baseScenario() as { expectations: Record<string, unknown> };
    emptyTools.expectations = { routed_tools: [] };
    expectInvalid({ version: 1, scenarios: [emptyTools] });
  });

  it("accepts an interpret pass in modelScript alongside route and answer", () => {
    const raw = baseScenario() as { turns: { modelScript: { pass: string; output: string }[] }[] };
    raw.turns[0]!.modelScript = [
      { pass: "interpret", output: '{"proposals":[]}' },
      { pass: "route", output: '{"tool":"none"}' },
      { pass: "answer", output: "ok" },
    ];
    const file = parseScenarioFile({ version: 1, scenarios: [raw] });
    expect(file.scenarios[0]!.turns[0]!.modelScript.map((p) => p.pass)).toEqual([
      "interpret",
      "route",
      "answer",
    ]);
  });

  it("parses no_persistence_claim_without_write and interpret_audits expectations", () => {
    const raw = baseScenario() as { expectations: Record<string, unknown> };
    raw.expectations = { no_persistence_claim_without_write: true, interpret_audits: 2 };
    const file = parseScenarioFile({ version: 1, scenarios: [raw] });
    expect(file.scenarios[0]!.expectations.noPersistenceClaimWithoutWrite).toBe(true);
    expect(file.scenarios[0]!.expectations.interpretAudits).toBe(2);
  });

  it("no_persistence_claim_without_write alone satisfies the at-least-one-expectation rule", () => {
    const raw = baseScenario() as { expectations: Record<string, unknown> };
    raw.expectations = { no_persistence_claim_without_write: true };
    expect(() => parseScenarioFile({ version: 1, scenarios: [raw] })).not.toThrow();
  });

  it("rejects a non-boolean no_persistence_claim_without_write and bad interpret_audits values", () => {
    const badFlag = baseScenario() as { expectations: Record<string, unknown> };
    badFlag.expectations = { no_persistence_claim_without_write: "yes" };
    expectInvalid({ version: 1, scenarios: [badFlag] });

    for (const bad of [0, -1, 1.5, "2"]) {
      const badAudits = baseScenario() as { expectations: Record<string, unknown> };
      badAudits.expectations = { interpret_audits: bad };
      expectInvalid({ version: 1, scenarios: [badAudits] });
    }
  });
});
