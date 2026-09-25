import { describe, expect, it } from "vitest";
import { loadScenarioFile, parseScenarioFile } from "./scenarios.js";
import type { Scenario } from "./scenarios.js";
import {
  checkExpectations,
  evaluatePins,
  passKindOf,
  requiredCapabilities,
  runConversationEval,
  ReadOverrideQueue,
  scriptedDispatch,
  singlePathDispatch,
} from "./runner.js";
import type { CognitiveTurnFn, CognitiveTurnOutcome, SinglePathConversationDeps, TurnObservation } from "./runner.js";
import type { ModelRequest } from "@jehad/adapters";
import { createNotification } from "@jehad/core";
import { probeCoreCapabilities, resolveCognitiveTurn } from "./run.js";

// §22 dual-window: legacy scenarios in this suite run through handleInbound,
// which reads the repo-root policy (now routing: single for dogfood) — pin
// the legacy fixture so legacy scripting stays valid; single-path scenarios
// are invoked directly (runCognitiveTurn) and never consult this flag.
process.env.POLICY_YAML_PATH ??= new URL("../../packages/core/src/imessage/legacy-routing.fixture.yaml", import.meta.url).pathname;

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
    interpretation: { audits: 0, payloads: [] },
    auditMarkers: [],
    answerPrompts: [],
    ledger: [],
    rounds: 0,
    intent: null,
    scriptIssues: [],
    ...overrides,
  };
}

const INTERPRET_PROMPT =
  "You are the turn interpreter for a personal assistant message gateway. Extract typed proposals.";
const ROUTE_PROMPT =
  "You are the query router for a personal assistant message gateway. Classify the user's message.";
const ANSWER_PROMPT = "You are a helpful, concise assistant chatting over iMessage.";

const req = (prompt: string): ModelRequest => ({ prompt }) as ModelRequest;

describe("passKindOf (W6(a) interpret pass marker)", () => {
  it("recognizes the interpret prompt marker and keeps route/answer detection intact", () => {
    expect(passKindOf(INTERPRET_PROMPT)).toBe("interpret");
    expect(passKindOf(ROUTE_PROMPT)).toBe("route");
    expect(passKindOf(ANSWER_PROMPT)).toBe("answer");
  });

  it("interpret wins when a prompt carries both markers (route-class pass)", () => {
    expect(passKindOf(`${INTERPRET_PROMPT} ${ROUTE_PROMPT}`)).toBe("interpret");
  });
});

describe("scriptedDispatch (interpret scripting)", () => {
  it("dispatches route → interpret → answer in scripted order with no mismatches", () => {
    const dispatch = scriptedDispatch([
      { pass: "route", output: '{"tool":"none"}' },
      { pass: "interpret", output: "[]" },
      { pass: "answer", output: "ok" },
    ]);
    expect(dispatch.responder(req(ROUTE_PROMPT))).toEqual({ text: '{"tool":"none"}' });
    expect(dispatch.responder(req(INTERPRET_PROMPT))).toEqual({ text: "[]" });
    expect(dispatch.responder(req(ANSWER_PROMPT))).toEqual({ text: "ok" });
    expect(dispatch.mismatches()).toEqual([]);
    expect(dispatch.consumed()).toBe(3);
  });

  it("unscripted interpret dispatches are auto-satisfied with no proposals (no consume, no mismatch)", () => {
    const dispatch = scriptedDispatch([
      { pass: "route", output: '{"tool":"none"}' },
      { pass: "answer", output: "ok" },
    ]);
    expect(dispatch.responder(req(ROUTE_PROMPT))).toEqual({ text: '{"tool":"none"}' });
    expect(dispatch.responder(req(INTERPRET_PROMPT))).toEqual({ text: "[]" });
    expect(dispatch.responder(req(ANSWER_PROMPT))).toEqual({ text: "ok" });
    expect(dispatch.mismatches()).toEqual([]);
    expect(dispatch.consumed()).toBe(2);
  });

  it("records a pass mismatch when the dispatched kind differs from the script", () => {
    const dispatch = scriptedDispatch([{ pass: "route", output: '{"tool":"none"}' }]);
    expect(dispatch.responder(req(ANSWER_PROMPT))).toEqual({ text: '{"tool":"none"}' });
    expect(dispatch.mismatches()).toEqual(["pass mismatch — scripted route, dispatched answer"]);
  });
});

describe("singlePathDispatch (§22 round-indexed scripting)", () => {
  it("answers every dispatch from script order regardless of prompt content — even prompts carrying legacy markers", () => {
    const dispatch = singlePathDispatch([
      { pass: "cognitive", output: '{"reads_requested":[]}' },
      { pass: "cognitive", output: '{"reads_requested":[],"reply":"done"}' },
      { pass: "verify", output: '{"verdict":"consistent"}' },
    ]);
    // Round-index matching: the marker-bearing ROUTE_PROMPT still gets the
    // FIRST script entry — no classification happens on the single path.
    expect(dispatch.responder(req(ROUTE_PROMPT))).toEqual({ text: '{"reads_requested":[]}' });
    expect(dispatch.responder(req("round 1 context with DATA blocks"))).toEqual({
      text: '{"reads_requested":[],"reply":"done"}',
    });
    expect(dispatch.responder(req("verify this reply against the ledger"))).toEqual({
      text: '{"verdict":"consistent"}',
    });
    expect(dispatch.mismatches()).toEqual([]);
    expect(dispatch.consumed()).toBe(3);
    expect(dispatch.kinds()).toEqual(["cognitive", "cognitive", "verify"]);
  });

  it("flags an unscripted extra dispatch as script exhaustion", () => {
    const dispatch = singlePathDispatch([{ pass: "cognitive", output: "{}" }]);
    dispatch.responder(req("round 0"));
    expect(() => dispatch.responder(req("round 1"))).toThrow("modelScript exhausted");
    expect(dispatch.mismatches()).toEqual(["model call 2 dispatched but modelScript is exhausted"]);
  });
});

describe("ReadOverrideQueue (§22.15(b) tool-boundary injection)", () => {
  it("consumes overrides in order per tool: first match wins, then it is spent", () => {
    const queue = new ReadOverrideQueue([
      { tool: "commitments.waiting", result: { otherOpenCount: 7 } },
      { tool: "commitments.waiting", result: { open: [{ title: "pick up suit" }] } },
      { tool: "gmail.search", result: { hits: [] } },
    ]);
    // G1's sparse variant: the old shape (no items) on the first read…
    expect(queue.take("commitments.waiting")).toEqual({ result: { otherOpenCount: 7 } });
    // …the full shape on the re-request — distinct results for repeat reads.
    expect(queue.take("commitments.waiting")).toEqual({ result: { open: [{ title: "pick up suit" }] } });
    // Both spent: the third read of the same tool falls through to the tool.
    expect(queue.take("commitments.waiting")).toBeNull();
    // Other tools keep their own queue.
    expect(queue.take("gmail.search")).toEqual({ result: { hits: [] } });
  });
});

describe("requiredCapabilities (§22 implicit cognitive_turn requirement)", () => {
  it("single-path scenarios require cognitive_turn on top of their declared requires", () => {
    expect(requiredCapabilities(scenario(singleBase()))).toEqual(["cognitive_turn"]);
    const withDeclared = scenario({
      ...singleBase(),
      requires: ["day.state", "cognitive_turn"],
    });
    expect(requiredCapabilities(withDeclared)).toEqual(["day.state", "cognitive_turn"]);
  });

  it("legacy scenarios keep exactly their declared requires", () => {
    expect(requiredCapabilities(scenario(legacyBase()))).toEqual([]);
  });
});

function legacyBase(): Record<string, unknown> {
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

function singleBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "single-01",
    description: "synthetic single-path scenario",
    principal: "jehad",
    path: "single",
    turns: [
      {
        user: "what's on my to do list?",
        modelScript: [
          { pass: "cognitive", output: '{"reads_requested":[],"reply":"all clear"}' },
        ],
      },
    ],
    expectations: { reply_contains: ["all clear"] },
    ...overrides,
  };
}

describe("checkExpectations (pure)", () => {
  it("passes when every expected tool was routed", () => {
    const failures = checkExpectations({ routedTools: ["calendar.day"] }, [turn({ routedTools: ["calendar.day"] })]);
    expect(failures).toEqual([]);
  });

  it("fails when an expected tool is missing and names what actually routed", () => {
    const failures = checkExpectations({ routedTools: ["day.state"] }, [turn({ routedTools: ["calendar.day"] })]);
    expect(failures).toEqual(['expected tool day.state not routed (routed: [calendar.day])']);
  });

  it("routed_none fails when a tool executed and passes when none did", () => {
    expect(checkExpectations({ routedNone: true }, [turn({ routedTools: ["calendar.next"] })])).toEqual([
      "expected no tools routed, got [calendar.next]",
    ]);
    expect(checkExpectations({ routedNone: true }, [turn()])).toEqual([]);
  });

  it("checks reply_contains and reply_not_contains against the final reply", () => {
    const expectations = { replyContains: ["synced"], replyNotContains: ["calendar"] };
    expect(checkExpectations(expectations, [turn({ reply: "last synced 7h ago" })])).toEqual([]);
    expect(checkExpectations(expectations, [turn({ reply: "see your calendar" })])).toEqual([
      'reply missing "synced"',
      'reply contains "calendar"',
    ]);
  });

  it("fails a final turn that produced no reply", () => {
    const failures = checkExpectations({ routedNone: true }, [turn({ replied: false, replyReason: "model-error", reply: null })]);
    expect(failures).toEqual(["final turn produced no reply (model-error)"]);
  });

  it("no_persistence_claim_without_write: a claim fails without write evidence and passes with it", () => {
    const expectations = { noPersistenceClaimWithoutWrite: true };
    const hallucinating = turn({ reply: "Got it — I've noted all 8 tasks." });
    expect(checkExpectations(expectations, [hallucinating])).toEqual([
      'persistence claim "I\'ve noted" without a durable write (no db write pin passed)',
    ]);
    expect(checkExpectations(expectations, [hallucinating], { writeEvidence: true })).toEqual([]);
  });

  it("no_persistence_claim_without_write: honest no-write wording passes with no write evidence", () => {
    const expectations = { noPersistenceClaimWithoutWrite: true };
    const honest = turn({ reply: "I see it in our conversation, but I'm not tracking it yet." });
    expect(checkExpectations(expectations, [honest])).toEqual([]);
    expect(checkExpectations(expectations, [honest], { writeEvidence: false })).toEqual([]);
  });

  it("interpret_audits pins the exact interpret audit row count on the final turn", () => {
    const observed = turn({ interpretation: { audits: 1, payloads: [{ proposals: [] }] } });
    expect(checkExpectations({ interpretAudits: 1 }, [observed])).toEqual([]);
    expect(checkExpectations({ interpretAudits: 2 }, [observed])).toEqual([
      "expected 2 interpret audit row(s) on the final turn, got 1",
    ]);
    expect(checkExpectations({ interpretAudits: 1 }, [turn()])).toEqual([
      "expected 1 interpret audit row(s) on the final turn, got 0",
    ]);
  });

  it("every_turn_not_contains fails on ANY turn's reply, not just the final one", () => {
    const turns = [
      turn({ reply: "Logged as a miss — that helps me see what I'm not observing." }),
      turn({ reply: "Fair — let's talk it through." }),
    ];
    expect(checkExpectations({ everyTurnNotContains: ["Logged as a miss"] }, turns)).toEqual([
      'turn 1 reply contains "Logged as a miss"',
    ]);
    expect(checkExpectations({ everyTurnNotContains: ["canned"] }, turns)).toEqual([]);
  });

  it("every_turn_not_contains skips unreplied turns (the final-turn check owns those)", () => {
    const turns = [turn({ replied: false, replyReason: "model-error", reply: null }), turn()];
    expect(checkExpectations({ everyTurnNotContains: ["x"] }, turns)).toEqual([]);
  });

  it("audit_markers counts deterministic markers across the whole scenario", () => {
    const pin = { marker: "calibration-missed", expectOne: false, expectZero: true };
    const hijacked = [turn({ auditMarkers: [] }), turn({ auditMarkers: ["calibration-missed"] })];
    expect(checkExpectations({ auditMarkers: [pin] }, hijacked)).toEqual([
      'audit marker "calibration-missed" terminal reply occurred 1 time(s) — expected none',
    ]);
    expect(checkExpectations({ auditMarkers: [pin] }, [turn(), turn()])).toEqual([]);
    const expectOnce = { marker: "proposal-affirm-applied", expectOne: true, expectZero: false };
    expect(
      checkExpectations({ auditMarkers: [expectOnce] }, [
        turn({ auditMarkers: ["proposal-affirm-applied"] }),
        turn({ auditMarkers: ["proposal-affirm-applied"] }),
      ]),
    ).toEqual([
      'audit marker "proposal-affirm-applied" expected exactly once across the scenario, got 2',
    ]);
  });

  it("answer prompt pins check the final turn's answer-pass prompts", () => {
    const withPrompt = turn({ answerPrompts: ['PERSONA for jehad.\nAddress: call the principal "Sir".'] });
    expect(
      checkExpectations(
        { answerPromptContains: ['call the principal "Sir"'], answerPromptNotContains: ['call the principal "Chief"'] },
        [withPrompt],
      ),
    ).toEqual([]);
    expect(
      checkExpectations(
        { answerPromptContains: ['call the principal "Sir"'], answerPromptNotContains: ['call the principal "Chief"'] },
        [turn({ answerPrompts: ['Address: call the principal "Chief".'] })],
      ),
    ).toEqual([
      'answer prompt missing "call the principal "Sir""',
      'answer prompt contains "call the principal "Chief""',
    ]);
    expect(checkExpectations({ answerPromptContains: ["x"] }, [turn({ answerPrompts: [] })])).toEqual([
      "answer prompt pins set but the final turn dispatched no answer pass",
    ]);
  });

  it("ledger_contains passes on a matching {opType, status} entry and fails with the observed ledger rendered", () => {
    const observed = turn({
      ledger: [
        { opType: "task_batch", status: "parked" },
        { opType: "profile_update", status: "applied" },
      ],
    });
    expect(checkExpectations({ ledgerContains: [{ opType: "task_batch", status: "parked" }] }, [observed])).toEqual([]);
    expect(checkExpectations({ ledgerContains: [{ opType: "task_batch", status: "applied" }] }, [observed])).toEqual([
      'ledger_contains: no "task_batch" entry with status "applied" (ledger: [task_batch:parked, profile_update:applied])',
    ]);
    expect(checkExpectations({ ledgerContains: [{ opType: "reminder_create", status: "rejected" }] }, [turn()])).toEqual([
      'ledger_contains: no "reminder_create" entry with status "rejected" (ledger: [])',
    ]);
  });

  it("rounds_at_least / rounds_at_most bound the final turn's cognitive round count", () => {
    const observed = turn({ rounds: 3 });
    expect(checkExpectations({ roundsAtLeast: 2, roundsAtMost: 3 }, [observed])).toEqual([]);
    expect(checkExpectations({ roundsAtLeast: 4 }, [observed])).toEqual([
      "rounds_at_least: expected at least 4 cognitive round(s), got 3",
    ]);
    expect(checkExpectations({ roundsAtMost: 2 }, [observed])).toEqual([
      "rounds_at_most: expected at most 2 cognitive round(s), got 3",
    ]);
    // The legacy path observes 0 rounds, so bounds pins fail there loudly.
    expect(checkExpectations({ roundsAtLeast: 1 }, [turn()])).toEqual([
      "rounds_at_least: expected at least 1 cognitive round(s), got 0",
    ]);
  });

  it("intent_is pins the final turn's structured intent and names what was observed instead", () => {
    expect(checkExpectations({ intentIs: "question" }, [turn({ intent: "question" })])).toEqual([]);
    expect(checkExpectations({ intentIs: "directive" }, [turn({ intent: "question" })])).toEqual([
      'intent_is: expected "directive", got "question"',
    ]);
    expect(checkExpectations({ intentIs: "chat" }, [turn()])).toEqual([
      'intent_is: expected "chat", got null (no intent observed)',
    ]);
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

describe("scenario schema (§22 single-path additions)", () => {
  it("parses path, cognitive/verify kinds, readOverrides, and the new expectations", () => {
    const parsed = scenario({
      id: "g1-sparse-01",
      description: "G1 sparse variant shape",
      principal: "jehad",
      path: "single",
      readOverrides: [
        { tool: "commitments.waiting", result: { otherOpenCount: 7 } },
        { tool: "commitments.waiting", result: { open: [{ title: "pick up suit" }] } },
      ],
      turns: [
        {
          user: "what's on my to do list?",
          modelScript: [
            { pass: "cognitive", output: '{"reads_requested":[{"tool":"commitments.waiting"}]}' },
            { pass: "cognitive", output: '{"reads_requested":[],"reply":"7 open"}' },
            { pass: "verify", output: '{"verdict":"consistent"}' },
          ],
        },
      ],
      expectations: {
        rounds_at_least: 2,
        rounds_at_most: 3,
        intent_is: "question",
        ledger_contains: [{ op_type: "task_batch", status: "parked" }],
        reply_contains: ["7 open"],
      },
    });
    expect(parsed.path).toBe("single");
    expect(parsed.readOverrides).toHaveLength(2);
    expect(parsed.turns[0]!.modelScript.map((entry) => entry.pass)).toEqual([
      "cognitive",
      "cognitive",
      "verify",
    ]);
    expect(parsed.expectations.roundsAtLeast).toBe(2);
    expect(parsed.expectations.roundsAtMost).toBe(3);
    expect(parsed.expectations.intentIs).toBe("question");
    expect(parsed.expectations.ledgerContains).toEqual([
      { opType: "task_batch", status: "parked" },
    ]);
  });

  it("defaults path to legacy and rejects cognitive/verify kinds there (and legacy kinds on single)", () => {
    expect(scenario(legacyBase()).path).toBe("legacy");
    const cognitiveOnLegacy = legacyBase() as {
      turns: { modelScript: { pass: string }[] }[];
    };
    cognitiveOnLegacy.turns[0]!.modelScript[0]!.pass = "cognitive";
    expect(() => scenario(cognitiveOnLegacy)).toThrow(/requires scenario path: "single"/);

    const routeOnSingle = singleBase() as unknown as {
      turns: { modelScript: { pass: string }[] }[];
    };
    routeOnSingle.turns[0]!.modelScript[0]!.pass = "route";
    expect(() => scenario(routeOnSingle)).toThrow(/requires path: "legacy"/);
  });

  it("rejects an unknown path value and readOverrides on the legacy path", () => {
    expect(() => scenario({ ...legacyBase(), path: "both" })).toThrow(/path: must be "legacy" or "single"/);
    expect(() => scenario({ ...legacyBase(), readOverrides: [{ tool: "x", result: {} }] })).toThrow(
      /readOverrides: requires path: "single"/,
    );
  });

  it("rejects malformed readOverrides and bad rounds/intent expectation values", () => {
    expect(() =>
      scenario(singleBase({ readOverrides: [{ tool: "commitments.waiting" }] })),
    ).toThrow(/result: is required/);
    expect(() => scenario(singleBase({ expectations: { rounds_at_least: 0 } }))).toThrow(
      /rounds_at_least: must be a positive integer/,
    );
    expect(() =>
      scenario(singleBase({ expectations: { rounds_at_least: 3, rounds_at_most: 2 } })),
    ).toThrow(/rounds_at_least must not exceed rounds_at_most/);
    expect(() => scenario(singleBase({ expectations: { intent_is: "" } }))).toThrow(
      /intent_is: must be a non-empty string/,
    );
    expect(() =>
      scenario(singleBase({ expectations: { ledger_contains: [{ op_type: "task_batch" }] } })),
    ).toThrow(/op_type and status must be non-empty strings/);
  });

  it("single-path expectation keys alone satisfy the at-least-one-expectation rule", () => {
    expect(() => scenario(singleBase({ expectations: { rounds_at_least: 1 } }))).not.toThrow();
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
    expect(observed.passes).toEqual(["route", "interpret", "answer"]);
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

  it("runs the checked-in suite: all four scenarios pass post-W1-integration", async () => {
    const file = loadScenarioFile(new URL("./scenarios.yaml", import.meta.url).pathname);
    const requires = [...new Set(file.scenarios.flatMap((s) => [...s.requires]))];
    const probes = await probeCoreCapabilities(requires);
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval5",
      capabilityProbes: probes,
      scenarios: file.scenarios,
    });
    expect(run.counts).toEqual({ pass: 4, fail: 0, skip: 0 });
    const byId = new Map(run.results.map((result) => [result.id, result]));
    expect(byId.get("referent-continuity-01")!.status).toBe("pass");
    expect(byId.get("plain-chat-none-01")!.status).toBe("pass");
    expect(byId.get("daystate-grounding-01")!.status).toBe("pass");
    expect(byId.get("staleness-honesty-01")!.status).toBe("pass");
    const continuity = byId.get("referent-continuity-01")!;
    expect(continuity.turns[1]!.routedTools).toEqual(["calendar.day"]);
    expect(continuity.turns[1]!.reply).toContain("4–5 PM");
  });

  it("no_persistence_claim_without_write: synthetic hallucination scenario fails end-to-end, honest twin passes", async () => {
    const base = (id: string, reply: string, expectations: Record<string, unknown>) =>
      scenario({
        id,
        description: "synthetic persistence-truth scenario",
        principal: "jehad",
        turns: [
          {
            user: "adding a task — build the console table",
            modelScript: [
              { pass: "route", output: '{"tool":"none"}' },
              { pass: "answer", output: reply },
            ],
          },
        ],
        expectations,
      });
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval6",
      capabilityProbes: {},
      scenarios: [
        base("synthetic-persistence-hallucination-01", "Noted — I've saved that task for you.", {
          no_persistence_claim_without_write: true,
        }),
        base("synthetic-persistence-honest-01", "I see it in our conversation, but I'm not tracking it yet.", {
          no_persistence_claim_without_write: true,
        }),
        base("synthetic-persistence-licensed-01", "I've added it — one commitment now in the world model.", {
          no_persistence_claim_without_write: true,
          db_pins: [{ sql: "SELECT 1 FROM interaction_threads WHERE status = 'active'", expect_one: true }],
        }),
      ],
    });
    // Wave SV1: the hallucinated claim never ships — the send-time claim
    // audit replaces it with the truthful line, so the scenario PASSES and
    // the delivered reply is the replacement, not the lie.
    expect(run.counts).toEqual({ pass: 3, fail: 0, skip: 0 });
    const byId = new Map(run.results.map((result) => [result.id, result]));
    const hallucination = byId.get("synthetic-persistence-hallucination-01")!;
    expect(hallucination.status).toBe("pass");
    expect(hallucination.turns[0]!.reply).not.toContain("I've saved");
    expect(hallucination.turns[0]!.reply).toContain("I haven't changed anything yet");
    expect(byId.get("synthetic-persistence-honest-01")!.status).toBe("pass");
    expect(byId.get("synthetic-persistence-licensed-01")!.status).toBe("pass");
  });

  it("interpret audit observation is captured (wired: one audit row, parsed payloads) alongside route/answer passes", async () => {
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval7",
      capabilityProbes: {},
      scenarios: [
        scenario({
          id: "synthetic-interpret-observation-01",
          description: "interpret audit capture",
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
        }),
      ],
    });
    expect(run.counts).toEqual({ pass: 1, fail: 0, skip: 0 });
    const observed = run.results[0]!.turns[0]!;
    expect(observed.passes).toEqual(["route", "interpret", "answer"]);
    expect(observed.interpretation.audits).toBe(1);
    expect(observed.interpretation.payloads).toEqual([
      { handle: expect.any(String), principalId: expect.any(String), proposals: [] },
    ]);
  });

  it("§22: single-path scenarios skip cleanly when the cognitive loop probe is dark", async () => {
    // The export HAS landed (runCognitiveTurn in @jehad/core) — the live
    // probe is true and the entry resolves. Pin the skip machinery by
    // forcing the probe dark, exactly like a pre-export world.
    const probes = await probeCoreCapabilities(["cognitive_turn"]);
    expect(probes["cognitive_turn"]).toBe(true);
    expect(await resolveCognitiveTurn()).not.toBeNull();
    probes["cognitive_turn"] = false;
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval8",
      capabilityProbes: probes,
      scenarios: [scenario(singleBase())],
    });
    expect(run.counts).toEqual({ pass: 0, fail: 0, skip: 1 });
    expect(run.results[0]!.reason).toBe("capability not available: cognitive_turn");
    expect(run.results[0]!.turns).toEqual([]);
  });

  it("§22: probe true but no entry supplied skips with an honest reason", async () => {
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval9",
      capabilityProbes: { cognitive_turn: true },
      scenarios: [scenario(singleBase())],
    });
    expect(run.counts).toEqual({ pass: 0, fail: 0, skip: 1 });
    expect(run.results[0]!.reason).toBe("single-path cognitive turn entry not resolved");
  });

  it("§22: synthetic single-path run through the full machinery (fake core seam)", async () => {
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conveval10",
      capabilityProbes: { cognitive_turn: true },
      cognitiveTurn: fakeCognitiveTurn(),
      scenarios: [
        // G1-sparse-flavored: read → sparse old shape → re-request → full
        // list → final reply woven from the SECOND override (proving the
        // override queue is consumed in order per tool). Empty ledger →
        // no verification dispatch (§22.9), so no verify script entry.
        scenario(
          singleBase({
            id: "g1-sparse-synthetic-01",
            description: "sparse read shape forces a second round",
            readOverrides: [
              { tool: "commitments.waiting", result: { otherOpenCount: 7 } },
              {
                tool: "commitments.waiting",
                result: {
                  open: [{ title: "pick up suit" }, { title: "print vows" }, { title: "book the caterer" }],
                  openTruncated: false,
                },
              },
            ],
            turns: [
              {
                user: "what's on my to do list?",
                modelScript: [
                  { pass: "cognitive", output: '{"reads_requested":[{"tool":"commitments.waiting"}]}' },
                  { pass: "cognitive", output: '{"reads_requested":[{"tool":"commitments.waiting"}]}' },
                  { pass: "cognitive", output: '{"reads_requested":[],"reply":"7 open: {{open}}"}' },
                ],
              },
            ],
            expectations: {
              rounds_at_least: 2,
              rounds_at_most: 3,
              intent_is: "question",
              reply_contains: ["pick up suit"],
            },
          }),
        ),
        // Directive leg: round-0 task_batch parks (§22.3 park-is-execution),
        // continuation ships the offer, non-empty ledger triggers the
        // §22.9 verification call (the scripted verify entry).
        scenario(
          singleBase({
            id: "g4-park-synthetic-01",
            description: "round-0 park then offer with verification",
            turns: [
              {
                user: "tasks: pick up suit, print vows",
                modelScript: [
                  {
                    pass: "cognitive",
                    output:
                      '{"reads_requested":[],"operations_requested":[{"type":"task_batch","items":[{"title":"pick up suit"},{"title":"print vows"}]}]}',
                  },
                  { pass: "cognitive", output: '{"reads_requested":[],"reply":"Want me to track these two?"}' },
                  { pass: "verify", output: '{"verdict":"consistent"}' },
                ],
              },
            ],
            expectations: {
              ledger_contains: [{ op_type: "task_batch", status: "parked" }],
              rounds_at_least: 2,
              rounds_at_most: 2,
              intent_is: "directive",
              reply_contains: ["track"],
            },
          }),
        ),
      ],
    });
    expect(run.counts).toEqual({ pass: 2, fail: 0, skip: 0 });
    const byId = new Map(run.results.map((result) => [result.id, result]));
    const sparse = byId.get("g1-sparse-synthetic-01")!;
    expect(sparse.status).toBe("pass");
    const sparseTurn = sparse.turns[0]!;
    expect(sparseTurn.passes).toEqual(["cognitive", "cognitive", "cognitive"]);
    expect(sparseTurn.rounds).toBe(3);
    expect(sparseTurn.intent).toBe("question");
    expect(sparseTurn.ledger).toEqual([]);
    expect(sparseTurn.reply).toContain("pick up suit");
    expect(sparseTurn.reply).toContain("book the caterer");
    expect(sparseTurn.scriptIssues).toEqual([]);

    const park = byId.get("g4-park-synthetic-01")!;
    expect(park.status).toBe("pass");
    const parkTurn = park.turns[0]!;
    expect(parkTurn.passes).toEqual(["cognitive", "cognitive", "verify"]);
    expect(parkTurn.rounds).toBe(2);
    expect(parkTurn.intent).toBe("directive");
    expect(parkTurn.ledger).toEqual([{ opType: "task_batch", status: "parked" }]);
    expect(parkTurn.reply).toBe("Want me to track these two?");
  });
});

/**
 * §22 harness smoke: a minimal synthetic single-author loop standing in for
 * core's cognitive-turn export (the `cognitive_turn` probe). Implements just
 * enough of the CognitiveTurnFn contract (runner.ts) to exercise the runner
 * machinery hermetically: every model call flows through deps.provider
 * (script order IS round order), reads consult deps.readOverrides before
 * "executing", round-0 ops park/apply into a typed ledger (later-round ops
 * reject per the §22.2 mutation window), the §22.9 verifier is dispatched
 * ONLY when the ledger is non-empty, and the reply lands as a notification
 * exactly like the real turn shell does. `{{open}}` in a final reply is
 * substituted with the titles from the most recent `open`-bearing read
 * result, making override flow observable in the shipped reply.
 */
function fakeCognitiveTurn(): CognitiveTurnFn {
  return async (
    deps: SinglePathConversationDeps,
    input: { principalId: string; handle: string; text: string },
  ): Promise<CognitiveTurnOutcome> => {
    interface FakeEnvelope {
      reads_requested?: { tool: string }[];
      operations_requested?: { type: string }[];
      reply?: string;
    }
    const dispatch = (round: number, context: string) =>
      deps.provider.complete({
        domainId: "personal",
        sensitivity: "normal",
        provider: "fake",
        model: "fake/model-x",
        prompt: `cognitive round ${round}\n${context}`,
      } as ModelRequest);

    let rounds = 0;
    let intent: string | null = null;
    let reply: string | null = null;
    let openTitles: string[] = [];
    const ledger: { opType: string; status: string }[] = [];
    let context = `user message: ${input.text}`;
    while (reply === null) {
      if (rounds >= 5) throw new Error("fake cognitive turn: no final reply within 5 rounds");
      const envelope = JSON.parse((await dispatch(rounds, context)).text) as FakeEnvelope;
      rounds += 1;
      if (rounds === 1) {
        intent =
          (envelope.operations_requested?.length ?? 0) > 0
            ? "directive"
            : (envelope.reads_requested?.length ?? 0) > 0
              ? "question"
              : "chat";
      }
      const roundContext: string[] = [];
      for (const op of envelope.operations_requested ?? []) {
        const status = rounds === 1 ? (op.type === "task_batch" ? "parked" : "applied") : "rejected";
        ledger.push({ opType: op.type, status });
        roundContext.push(`op result {type: ${op.type}, status: ${status}}`);
      }
      for (const read of envelope.reads_requested ?? []) {
        const override = deps.readOverrides?.take(read.tool) ?? null;
        const result = override !== null ? override.result : { tool: read.tool, error: "no override" };
        if (
          typeof result === "object" &&
          result !== null &&
          Array.isArray((result as { open?: unknown }).open)
        ) {
          openTitles = (result as { open: { title: string }[] }).open.map((item) => item.title);
        }
        roundContext.push(`read result ${read.tool}: ${JSON.stringify(result)}`);
      }
      if ((envelope.reads_requested?.length ?? 0) === 0 && typeof envelope.reply === "string") {
        reply = envelope.reply.replace("{{open}}", openTitles.join(", "));
      }
      context = roundContext.join("\n");
    }
    if (ledger.length > 0) {
      // §22.9: one verification call over reply + ledger (script entry).
      await dispatch(rounds, `verify the reply against the ledger: ${JSON.stringify(ledger)}`);
    }
    const notification = await createNotification(
      deps.db,
      {
        kind: "reply",
        title: "Reply",
        payload: { content: reply, recipient: input.handle },
        recipient: input.handle,
        sourceType: "run",
        sourceId: null,
        createdBy: input.principalId,
        surface: "imessage",
        requestingPrincipalId: input.principalId,
        conversationPrincipalId: input.principalId,
      },
      { actor: "system:imessage-gateway", now: () => new Date() },
    );
    return { replied: true, notificationId: notification.id, rounds, intent, ledger };
  };
}
