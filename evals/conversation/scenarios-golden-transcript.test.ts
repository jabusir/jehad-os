import { describe, expect, it } from "vitest";
import { loadScenarioFile } from "./scenarios.js";
import { runConversationEval } from "./runner.js";
import { PERSISTENCE_CLAIM_RE } from "./assertions.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const FILE = new URL("./scenarios-golden-transcript.yaml", import.meta.url).pathname;

const TODO_ITEMS = [
  "Wedding seating chart",
  "wedding playlist",
  "wedding appetizers",
  "get prenup signed (wednesday)",
  "finish companions lecture by wednesday",
  "build console table",
  "build bed",
  "Clean apartment and bathrooms by wednesday",
] as const;

describe("scenarios-golden-transcript.yaml (W6(c) golden eval, R12)", () => {
  it("validates and carries exactly the eight transcript scenarios in order", () => {
    const file = loadScenarioFile(FILE);
    expect(file.version).toBe(1);
    expect(file.scenarios.map((scenario) => scenario.id)).toEqual([
      "golden-todo-proposal-01",
      "golden-todo-confirm-01",
      "golden-capability-gap-01",
      "golden-gmail-pertinence-01",
      "golden-yusra-persona-01",
      "golden-persona-selfbrief-01",
      "golden-generalknowledge-01",
      "golden-personalfacts-strict-01",
    ]);
  });

  it("requires-gating: interpreter scenarios on turn_interpreter, self-brief scenario on self_brief, gmail ungated", () => {
    const byId = new Map(loadScenarioFile(FILE).scenarios.map((s) => [s.id, s]));
    expect(byId.get("golden-todo-proposal-01")!.requires).toEqual(["turn_interpreter"]);
    expect(byId.get("golden-todo-confirm-01")!.requires).toEqual(["turn_interpreter"]);
    expect(byId.get("golden-capability-gap-01")!.requires).toEqual(["turn_interpreter"]);
    expect(byId.get("golden-yusra-persona-01")!.requires).toEqual(["turn_interpreter"]);
    expect(byId.get("golden-persona-selfbrief-01")!.requires).toEqual(["self_brief"]);
    expect(byId.get("golden-gmail-pertinence-01")!.requires).toEqual([]);
  });

  it("(a) the to-do message carries the FULL 8-item list verbatim, 3 with wednesday due words", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "golden-todo-proposal-01")!;
    const user = scenario.turns[0]!.user;
    for (const item of TODO_ITEMS) expect(user).toContain(item);
    expect(user.match(/wednesday/gi)).toHaveLength(3);
    const interpret = scenario.turns[0]!.modelScript.find((p) => p.pass === "interpret")!;
    const proposals = JSON.parse(interpret.output) as {
      type: string;
      items: { title: string; due?: string }[];
    }[];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.type).toBe("task_batch");
    // Titles carry the verbatim item text with the due word split into `due`.
    expect(proposals[0]!.items.map((item) => item.title)).toEqual([
      "Wedding seating chart",
      "wedding playlist",
      "wedding appetizers",
      "get prenup signed",
      "finish companions lecture",
      "build console table",
      "build bed",
      "Clean apartment and bathrooms",
    ]);
    expect(proposals[0]!.items.filter((item) => item.due === "wednesday")).toHaveLength(3);
  });

  it("(a) proposal-only: zero commitment writes, no persistence claim, offer verb present", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "golden-todo-proposal-01")!;
    expect(scenario.expectations.replyContains).toEqual(["8", "3", "track them"]);
    expect(scenario.expectations.replyNotContains).toEqual(["noted", "tracking it", "saved", "remember"]);
    expect(scenario.expectations.noPersistenceClaimWithoutWrite).toBe(true);
    expect(scenario.expectations.interpretAudits).toBe(1);
    expect(scenario.expectations.dbPins).toEqual([
      { sql: "SELECT 1 FROM commitments", expectOne: false, expectZero: true },
    ]);
    const answer = scenario.turns[0]!.modelScript.find((p) => p.pass === "answer")!;
    expect(PERSISTENCE_CLAIM_RE.test(answer.output)).toBe(false);
  });

  it("(b) confirm verb: replays the same to-do message, pins 8 commitments and 3 due on Wednesday 2026-09-23", () => {
    const file = loadScenarioFile(FILE);
    const proposalTurn = file.scenarios.find((s) => s.id === "golden-todo-proposal-01")!.turns[0]!;
    const confirm = file.scenarios.find((s) => s.id === "golden-todo-confirm-01")!;
    expect(confirm.turns).toHaveLength(2);
    expect(confirm.turns[0]!.user).toBe(proposalTurn.user);
    expect(confirm.turns[1]!.user).toBe("track them");
    expect(confirm.turns[1]!.modelScript).toEqual([]); // deterministic confirm — zero dispatches
    expect(confirm.expectations.replyContains).toEqual(["8"]);
    // Fixed clock: runner anchors at 2026-09-21T18:00:00.000Z = Mon Sep 21
    // 2026, 11:00 PT → "wednesday" = 2026-09-23 (America/Los_Angeles).
    expect(confirm.expectations.dbPins).toEqual([
      { sql: "SELECT 1 FROM commitments HAVING count(*) = 8", expectOne: true, expectZero: false },
      {
        sql: "SELECT 1 FROM commitments WHERE due_at IS NOT NULL HAVING count(*) = 3",
        expectOne: true,
        expectZero: false,
      },
      {
        sql: "SELECT 1 FROM commitments WHERE due_at IS NOT NULL AND (due_at AT TIME ZONE 'America/Los_Angeles')::date = '2026-09-23' HAVING count(*) = 3",
        expectOne: true,
        expectZero: false,
      },
    ]);
  });

  it("(c) capability gap: system_feedback offered via log it, feedback table stays empty", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "golden-capability-gap-01")!;
    expect(scenario.turns[0]!.user).toContain("gap in your capabilities");
    expect(scenario.turns[0]!.modelScript.find((p) => p.pass === "interpret")!.output).toContain(
      '"system_feedback"',
    );
    expect(scenario.expectations.replyContains).toEqual(["log it"]);
    expect(scenario.expectations.noPersistenceClaimWithoutWrite).toBe(true);
    expect(scenario.expectations.dbPins).toEqual([
      { sql: "SELECT 1 FROM feedback", expectOne: false, expectZero: true },
    ]);
  });

  it("(d) gmail pertinence: coverage-limit-first language, no bare taxonomy", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "golden-gmail-pertinence-01")!;
    expect(scenario.expectations.routedTools).toEqual(["gmail.recent"]);
    expect(scenario.expectations.replyContains).toEqual(["sender", "metadata", "content"]);
    expect(scenario.expectations.replyNotContains).toEqual([
      "here are the pertinent emails",
      "the pertinent ones are",
    ]);
  });

  it("(e) yusra directive: approve-gated staging, zero profile rows for yusra", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "golden-yusra-persona-01")!;
    expect(scenario.turns[0]!.user).toContain("friendly, nice, bubbly");
    expect(scenario.turns[0]!.modelScript.find((p) => p.pass === "interpret")!.output).toContain(
      '"configuration_directive"',
    );
    expect(scenario.expectations.replyContains).toEqual(["approve"]);
    expect(scenario.expectations.dbPins).toEqual([
      {
        sql: "SELECT 1 FROM interaction_profiles p JOIN principals pr ON pr.id = p.principal_id WHERE pr.name = 'yusra'",
        expectOne: false,
        expectZero: true,
      },
    ]);
  });

  it("(f) self-brief: self-modifiability consistent, stale self-model phrasings banned", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "golden-persona-selfbrief-01")!;
    expect(scenario.turns[0]!.user).toContain("configure your persona per user");
    expect(scenario.expectations.replyContains).toEqual(["configure", "adjust"]);
    expect(scenario.expectations.replyNotContains).toEqual([
      "not something I",
      "I only see data when you explicitly ask",
    ]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("golden transcript runner behavior", () => {
  it("interpreter/self-brief scenarios skip until core exports the capabilities; gmail runs and passes", async () => {
    const file = loadScenarioFile(FILE);
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      scenarios: file.scenarios,
      capabilityProbes: {},
      dbTag: "conv_eval_w6c",
    });
    expect(run.counts).toEqual({ pass: 3, fail: 0, skip: 5 });
    const byId = new Map(run.results.map((result) => [result.id, result]));
    for (const id of [
      "golden-todo-proposal-01",
      "golden-todo-confirm-01",
      "golden-capability-gap-01",
      "golden-yusra-persona-01",
    ]) {
      expect(byId.get(id)!.status).toBe("skip");
      expect(byId.get(id)!.reason).toContain("turn_interpreter");
    }
    expect(byId.get("golden-persona-selfbrief-01")!.reason).toContain("self_brief");
    const gmail = byId.get("golden-gmail-pertinence-01")!;
    expect(gmail.status).toBe("pass");
    expect(gmail.turns[0]!.routedTools).toEqual(["gmail.recent"]);
    expect(gmail.turns[0]!.reply).toContain("metadata");
  });
});
