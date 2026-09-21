import { describe, expect, it } from "vitest";
import { loadScenarioFile, parseScenarioFile } from "./scenarios.js";
import type { Scenario } from "./scenarios.js";
import { checkExpectations, evaluatePins, runConversationEval } from "./runner.js";
import type { TurnObservation } from "./runner.js";
import { probeCoreCapabilities } from "./run.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function scenario(raw: Record<string, unknown>): Scenario {
  return parseScenarioFile({ version: 1, scenarios: [raw] }).scenarios[0]!;
}

function turn(overrides: Partial<TurnObservation> = {}): TurnObservation {
  return {
    user: "u",
    replied: true,
    replyReason: null,
    reply: "ok",
    routedTools: [],
    passes: ["route", "answer"],
    scriptIssues: [],
    ...overrides,
  };
}

describe("checkExpectations (pure)", () => {
  it("passes when every expected tool was routed", () => {
    const failures = checkExpectations({ routedTools: ["calendar.day"] }, turn({ routedTools: ["calendar.day"] }));
    expect(failures).toEqual([]);
  });

  it("fails when an expected tool is missing and names what actually routed", () => {
    const failures = checkExpectations({ routedTools: ["day.state"] }, turn({ routedTools: ["calendar.day"] }));
    expect(failures).toEqual(['expected tool day.state not routed (routed: [calendar.day])']);
  });

  it("routed_none fails when a tool executed and passes when none did", () => {
    expect(checkExpectations({ routedNone: true }, turn({ routedTools: ["calendar.next"] }))).toEqual([
      "expected no tools routed, got [calendar.next]",
    ]);
    expect(checkExpectations({ routedNone: true }, turn())).toEqual([]);
  });

  it("checks reply_contains and reply_not_contains against the final reply", () => {
    const expectations = { replyContains: ["synced"], replyNotContains: ["calendar"] };
    expect(checkExpectations(expectations, turn({ reply: "last synced 7h ago" }))).toEqual([]);
    expect(checkExpectations(expectations, turn({ reply: "see your calendar" }))).toEqual([
      'reply missing "synced"',
      'reply contains "calendar"',
    ]);
  });

  it("fails a final turn that produced no reply", () => {
    const failures = checkExpectations({ routedNone: true }, turn({ replied: false, replyReason: "model-error", reply: null }));
    expect(failures).toEqual(["final turn produced no reply (model-error)"]);
  });
});

describe("evaluatePins (pure)", () => {
  const pin = { sql: "SELECT 1 FROM interaction_threads WHERE status = 'active'", expectOne: true, expectZero: false };

  it("expect_one passes on exactly one row and fails otherwise", async () => {
    const one = await evaluatePins(async () => [{ n: 1 }], [pin]);
    expect(one).toEqual([]);
    const two = await evaluatePins(async () => [{ n: 1 }, { n: 2 }], [pin]);
    expect(two).toEqual([`db pin expected exactly 1 row, got 2 (${pin.sql})`]);
  });

  it("expect_zero passes on no rows and fails otherwise", async () => {
    const zero = { sql: "SELECT 1 FROM audit_log", expectOne: false, expectZero: true };
    expect(await evaluatePins(async () => [], [zero])).toEqual([]);
    expect(await evaluatePins(async () => [{}], [zero])).toEqual([
      `db pin expected 0 rows, got 1 (SELECT 1 FROM audit_log)`,
    ]);
  });

  it("turns query errors into failures", async () => {
    const failures = await evaluatePins(async () => {
      throw new Error("relation missing");
    }, [pin]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("relation missing");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("conversation eval runner (integration, hermetic)", () => {
  it("executes a trivial scripted scenario through the real turn pipeline", async () => {
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval1",
      capabilityProbes: {},
      scenarios: [
        scenario({
          id: "trivial-01",
          description: "plain chat through the real pipeline",
          principal: "jehad",
          turns: [
            {
              user: "hey — quick one, what's the capital of Australia?",
              modelScript: [
                { pass: "route", output: '{"tool":"none"}' },
                { pass: "answer", output: "Canberra." },
              ],
            },
          ],
          expectations: {
            routed_none: true,
            reply_contains: ["Canberra"],
            db_pins: [{ sql: "SELECT 1 FROM interaction_threads WHERE status = 'active'", expect_one: true }],
          },
        }),
      ],
    });
    expect(run.counts).toEqual({ pass: 1, fail: 0, skip: 0 });
    const observed = run.results[0]!.turns[0]!;
    expect(observed.replied).toBe(true);
    expect(observed.reply).toBe("Canberra.");
    expect(observed.routedTools).toEqual([]);
    expect(observed.passes).toEqual(["route", "answer"]);
  });

  it("reports expectation failures with detail", async () => {
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval2",
      capabilityProbes: {},
      scenarios: [
        scenario({
          id: "failing-01",
          description: "impossible expectation",
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
          expectations: { routed_tools: ["calendar.day"], reply_contains: ["nope"] },
        }),
      ],
    });
    expect(run.counts).toEqual({ pass: 0, fail: 1, skip: 0 });
    expect(run.results[0]!.failures).toEqual([
      'reply missing "nope"',
      "expected tool calendar.day not routed (routed: [])",
    ]);
  });

  it("flags a modelScript that never dispatched its scripted answer pass", async () => {
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval3",
      capabilityProbes: {},
      scenarios: [
        scenario({
          id: "leftover-01",
          description: "script has an extra pass",
          principal: "jehad",
          turns: [
            {
              user: "hello there",
              modelScript: [
                { pass: "route", output: '{"tool":"none"}' },
                { pass: "answer", output: "hi" },
                { pass: "answer", output: "never dispatched" },
              ],
            },
          ],
          expectations: { routed_none: true },
        }),
      ],
    });
    expect(run.counts).toEqual({ pass: 0, fail: 1, skip: 0 });
    expect(run.results[0]!.failures).toEqual(["turn 1 modelScript: 1 scripted pass(es) never dispatched"]);
  });

  it("skips scenarios whose required capability is not probed true", async () => {
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval4",
      capabilityProbes: { "day.state": false },
      scenarios: [
        scenario({
          id: "needs-cap-01",
          description: "requires a missing capability",
          principal: "jehad",
          requires: ["day.state"],
          turns: [
            {
              user: "What's going on today?",
              modelScript: [
                { pass: "route", output: '{"tool":"day.state"}' },
                { pass: "answer", output: "assembled" },
              ],
            },
          ],
          expectations: { routed_tools: ["day.state"] },
        }),
      ],
    });
    expect(run.counts).toEqual({ pass: 0, fail: 0, skip: 1 });
    expect(run.results[0]!.reason).toBe("capability not available: day.state");
    expect(run.results[0]!.turns).toEqual([]);
  });

  it("runs the checked-in suite: continuity + plain chat pass; day.state/staleness skip until their lanes land", async () => {
    const file = loadScenarioFile(new URL("./scenarios.yaml", import.meta.url).pathname);
    const requires = [...new Set(file.scenarios.flatMap((s) => [...s.requires]))];
    const probes = await probeCoreCapabilities(requires);
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval5",
      capabilityProbes: probes,
      scenarios: file.scenarios,
    });
    expect(run.counts).toEqual({ pass: 2, fail: 0, skip: 2 });
    const byId = new Map(run.results.map((result) => [result.id, result]));
    expect(byId.get("referent-continuity-01")!.status).toBe("pass");
    expect(byId.get("plain-chat-none-01")!.status).toBe("pass");
    expect(byId.get("daystate-grounding-01")!.status).toBe("skip");
    expect(byId.get("staleness-honesty-01")!.status).toBe("skip");
    const continuity = byId.get("referent-continuity-01")!;
    expect(continuity.turns[1]!.routedTools).toEqual(["calendar.day"]);
    expect(continuity.turns[1]!.reply).toContain("4–5 PM");
  });
});
