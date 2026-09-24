import { describe, expect, it } from "vitest";
import { loadScenarioFile, parseScenarioFile } from "./scenarios.js";
import { runConversationEval } from "./runner.js";
import { probeCoreCapabilities } from "./run.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const FILE = new URL("./scenarios-intelligence-reset.yaml", import.meta.url).pathname;

describe("scenarios-intelligence-reset.yaml (C11 golden batch, intelligence-reset §6)", () => {
  it("validates and carries exactly the seven scenarios in order", () => {
    const file = loadScenarioFile(FILE);
    expect(file.version).toBe(1);
    expect(file.scenarios.map((scenario) => scenario.id)).toEqual([
      "hijack-calibration-01",
      "address-me-sir-01",
      "one-off-day-01",
      "not-what-i-meant-01",
      "multi-proposal-salience-01",
      "multi-proposal-salience-02",
      "pertinent-emails-content-01",
    ]);
  });

  it("requires-gating: post-lane scenarios carry probes, the two ungated ones run today", () => {
    const byId = new Map(loadScenarioFile(FILE).scenarios.map((s) => [s.id, s]));
    expect(byId.get("hijack-calibration-01")!.requires).toEqual(["calibration_miss_side_effect"]);
    expect(byId.get("one-off-day-01")!.requires).toEqual(["calibration_miss_side_effect"]);
    expect(byId.get("address-me-sir-01")!.requires).toEqual(["profile_address_keys"]);
    expect(byId.get("multi-proposal-salience-02")!.requires).toEqual(["per_type_proposal_slots"]);
    expect(byId.get("pertinent-emails-content-01")!.requires).toEqual(["gmail_content_tools"]);
    expect(byId.get("not-what-i-meant-01")!.requires).toEqual([]);
    expect(byId.get("multi-proposal-salience-01")!.requires).toEqual([]);
  });

  it("hijack: clock 20:45 PT with the item prompted 20:30 PT, three conversational turns, post-C1 pins", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "hijack-calibration-01")!;
    // 2026-09-22T03:45Z = Mon Sep 21 2026, 20:45 PT (PDT, UTC-7); the seed's
    // prompt lands 20:30 PT — 15 minutes inside the 2h miss window.
    expect(scenario.clock).toBe("2026-09-22T03:45:00.000Z");
    expect(scenario.seed?.calibrationItem?.promptSentAt).toBe("2026-09-22T03:30:00.000Z");
    expect(scenario.turns.map((turn) => turn.user)).toEqual([
      expect.stringContaining("calendar didn't reflect"),
      "got it, but you see my point, right?",
      "why are you repeating yourself?",
    ]);
    for (const turn of scenario.turns) {
      expect(turn.modelScript.map((pass) => pass.pass)).toEqual(["route", "answer"]);
      expect(turn.modelScript[0]!.output).toBe('{"tool":"none"}');
    }
    // Post-C1: the canned ack never ships on ANY turn, the terminal marker
    // never fires, but the side effect still lands (feedback row exists) and
    // no identical outbound repeats.
    expect(scenario.expectations.everyTurnNotContains).toEqual([
      "Logged as a miss",
      "helps me see what I'm not observing",
      "Correction logged",
    ]);
    expect(scenario.expectations.auditMarkers).toEqual([
      { marker: "calibration-missed", expectOne: false, expectZero: true },
    ]);
    expect(scenario.expectations.dbPins).toEqual([
      {
        sql: "SELECT 1 FROM feedback WHERE item_type = 'calibration' AND verdict = 'missed' HAVING count(*) >= 1",
        expectOne: true,
        expectZero: false,
      },
      {
        sql: "SELECT 1 FROM interaction_messages WHERE direction = 'outbound' GROUP BY content HAVING count(*) > 1",
        expectOne: false,
        expectZero: true,
      },
    ]);
  });

  it("address-me-sir: incident B turns, deterministic approve, profile + prompt pins", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "address-me-sir-01")!;
    expect(scenario.turns[0]!.user).toBe("call me Sir, not Chief");
    expect(scenario.turns[0]!.modelScript.find((p) => p.pass === "interpret")!.output).toContain(
      '"configuration_directive"',
    );
    expect(scenario.turns[0]!.modelScript.find((p) => p.pass === "interpret")!.output).toContain(
      '"ownerName":"Sir"',
    );
    expect(scenario.turns[1]!.user).toBe("approve");
    expect(scenario.turns[1]!.modelScript).toEqual([]); // deterministic confirm
    expect(scenario.expectations.answerPromptContains).toEqual(['call the principal "Sir"']);
    expect(scenario.expectations.answerPromptNotContains).toEqual(['call the principal "Chief"']);
    expect(scenario.expectations.dbPins).toEqual([
      {
        sql: "SELECT 1 FROM interaction_profiles p JOIN principals pr ON pr.id = p.principal_id WHERE pr.name = 'jehad' AND p.definition->'address'->>'ownerName' = 'Sir'",
        expectOne: true,
        expectZero: false,
      },
    ]);
    // Incident B vocabulary never ships: no review-queue copy, no memory
    // detour, and the old address term never appears in any reply.
    expect(scenario.expectations.everyTurnNotContains).toEqual([
      "captured for review",
      "Chief",
      "memory",
    ]);
  });

  it("one-off-day: in the miss window, no terminal ack, feedback deliberately unpinned", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "one-off-day-01")!;
    expect(scenario.clock).toBe("2026-09-22T03:50:00.000Z");
    expect(scenario.seed?.calibrationItem?.promptSentAt).toBe("2026-09-22T03:30:00.000Z");
    expect(scenario.turns).toHaveLength(1);
    expect(scenario.expectations.everyTurnNotContains).toEqual(["Correction logged", "Logged as a miss"]);
    // The side-effect feedback row MAY exist — no pin either way.
    const pinned = (scenario.expectations.dbPins ?? []).map((pin) => pin.sql);
    expect(pinned.some((sql) => sql.includes("FROM feedback"))).toBe(false);
    expect(pinned).toContain("SELECT 1 FROM memory_candidates");
  });

  it("not-what-i-meant: pending batch + correction, nothing mutates", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "not-what-i-meant-01")!;
    expect(scenario.turns[0]!.modelScript.find((p) => p.pass === "interpret")!.output).toContain(
      '"task_batch"',
    );
    expect(scenario.turns[1]!.user).toBe("no, that's not what I meant");
    expect(scenario.expectations.routedNone).toBe(true);
    expect(scenario.expectations.noPersistenceClaimWithoutWrite).toBe(true);
    expect(scenario.expectations.dbPins).toEqual([
      { sql: "SELECT 1 FROM commitments", expectOne: false, expectZero: true },
      { sql: "SELECT 1 FROM memory_candidates", expectOne: false, expectZero: true },
    ]);
  });

  it("salience-01: last-offered persona change wins the bare yes; batch never applies", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "multi-proposal-salience-01")!;
    expect(scenario.turns[0]!.modelScript.find((p) => p.pass === "interpret")!.output).toContain(
      '"task_batch"',
    );
    expect(scenario.turns[1]!.modelScript.find((p) => p.pass === "interpret")!.output).toContain(
      '"configuration_directive"',
    );
    expect(scenario.turns[2]!.user).toBe("yes");
    expect(scenario.turns[2]!.modelScript).toEqual([]); // deterministic affirmation
    expect(scenario.expectations.dbPins).toEqual([
      {
        sql: "SELECT 1 FROM interaction_profiles p JOIN principals pr ON pr.id = p.principal_id WHERE pr.name = 'jehad' AND p.created_via = 'self'",
        expectOne: true,
        expectZero: false,
      },
      { sql: "SELECT 1 FROM commitments", expectOne: false, expectZero: true },
    ]);
  });

  it("salience-02: both offers in ONE turn, bare yes asks a question and mutates nothing", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "multi-proposal-salience-02")!;
    const interpret = scenario.turns[0]!.modelScript.find((p) => p.pass === "interpret")!;
    const proposals = JSON.parse(interpret.output) as { type: string }[];
    expect(proposals.map((proposal) => proposal.type)).toEqual([
      "task_batch",
      "configuration_directive",
    ]);
    expect(scenario.turns[1]!.user).toBe("yes");
    expect(scenario.turns[1]!.modelScript).toEqual([]); // deterministic disambiguation
    expect(scenario.expectations.replyContains).toEqual(["?", "which"]);
    expect(scenario.expectations.dbPins).toEqual([
      { sql: "SELECT 1 FROM commitments", expectOne: false, expectZero: true },
      {
        sql: "SELECT 1 FROM interaction_profiles p JOIN principals pr ON pr.id = p.principal_id WHERE pr.name = 'jehad' AND p.created_via = 'self'",
        expectOne: false,
        expectZero: true,
      },
    ]);
  });

  it("pertinent-emails: content fixture, injection pin, refusal-language ban", () => {
    const scenario = loadScenarioFile(FILE).scenarios.find((s) => s.id === "pertinent-emails-content-01")!;
    const messages = scenario.seed?.gmailMessages ?? [];
    expect(messages).toHaveLength(3);
    const pertinent = messages.filter(
      (message) => /invoice due/i.test(message.subject) && message.from.startsWith("billing@"),
    );
    expect(pertinent).toHaveLength(2);
    expect(messages.filter((message) => !pertinent.includes(message))).toHaveLength(1); // noise
    expect(messages.some((message) => message.body.includes("IGNORE PREVIOUS INSTRUCTIONS"))).toBe(true);
    for (const message of messages) {
      expect(message.ageHours).toBeGreaterThan(0);
      expect(message.ageHours).toBeLessThanOrEqual(168); // 7-day retention
    }
    expect(scenario.turns[0]!.modelScript[0]).toEqual({
      pass: "route",
      output: '{"tool":"gmail.search","query":"invoice"}',
    });
    expect(scenario.expectations.routedTools).toEqual(["gmail.search"]);
    expect(scenario.expectations.replyNotContains).toContain("metadata only");
    expect(scenario.expectations.replyNotContains).toContain("email all contacts");
    expect(scenario.expectations.dbPins).toEqual([
      { sql: "SELECT 1 FROM commitments", expectOne: false, expectZero: true },
      { sql: "SELECT 1 FROM outcomes", expectOne: false, expectZero: true },
    ]);
  });
});

describe("scenario clock/seed validation (C11 parser)", () => {
  const base = (): Record<string, unknown> => ({
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
  });

  it("parses clock + seed with strict ISO and age bounds", () => {
    const raw = base();
    raw["clock"] = "2026-09-22T03:45:00.000Z";
    raw["seed"] = {
      calibrationItem: { prompt_sent_at: "2026-09-22T03:30:00.000Z" },
      gmailMessages: [{ from: "billing@acme.com", subject: "Invoice due", body: "pay it", age_hours: 3 }],
    };
    const file = parseScenarioFile({ version: 1, scenarios: [raw] });
    expect(file.scenarios[0]!.clock).toBe("2026-09-22T03:45:00.000Z");
    expect(file.scenarios[0]!.seed?.calibrationItem?.promptSentAt).toBe("2026-09-22T03:30:00.000Z");
    expect(file.scenarios[0]!.seed?.gmailMessages).toEqual([
      { from: "billing@acme.com", subject: "Invoice due", body: "pay it", ageHours: 3 },
    ]);
  });

  it("rejects non-ISO clocks, non-ISO prompt_sent_at, bad age_hours, and empty seeds", () => {
    const badClock = base();
    badClock["clock"] = "2026-09-21 18:00";
    expect(() => parseScenarioFile({ version: 1, scenarios: [badClock] })).toThrow(/clock/);

    const badSentAt = base();
    badSentAt["seed"] = { calibrationItem: { prompt_sent_at: "20:30" } };
    expect(() => parseScenarioFile({ version: 1, scenarios: [badSentAt] })).toThrow(/prompt_sent_at/);

    for (const ageHours of [0, -1, 200]) {
      const badAge = base();
      badAge["seed"] = {
        gmailMessages: [{ from: "a@b.c", subject: "s", body: "b", age_hours: ageHours }],
      };
      expect(() => parseScenarioFile({ version: 1, scenarios: [badAge] })).toThrow(/age_hours/);
    }

    const emptySeed = base();
    emptySeed["seed"] = {};
    expect(() => parseScenarioFile({ version: 1, scenarios: [emptySeed] })).toThrow(/seed/);
  });

  it("rejects audit_markers without exactly one flag and accepts the new expectation keys", () => {
    const noFlag = base() as { expectations: Record<string, unknown> };
    noFlag.expectations = { audit_markers: [{ marker: "calibration-missed" }] };
    expect(() => parseScenarioFile({ version: 1, scenarios: [noFlag] })).toThrow(/audit_markers/);

    const ok = base() as { expectations: Record<string, unknown> };
    ok.expectations = {
      every_turn_not_contains: ["Logged as a miss"],
      audit_markers: [{ marker: "calibration-missed", expect_zero: true }],
      answer_prompt_contains: ['call the principal "Sir"'],
      answer_prompt_not_contains: ['call the principal "Chief"'],
    };
    const file = parseScenarioFile({ version: 1, scenarios: [ok] });
    expect(file.scenarios[0]!.expectations.everyTurnNotContains).toEqual(["Logged as a miss"]);
    expect(file.scenarios[0]!.expectations.auditMarkers).toEqual([
      { marker: "calibration-missed", expectOne: false, expectZero: true },
    ]);
    expect(file.scenarios[0]!.expectations.answerPromptContains).toEqual(['call the principal "Sir"']);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("intelligence-reset runner behavior", () => {
  it("with no probes: the two ungated scenarios pass, the five post-lane scenarios skip cleanly", async () => {
    const file = loadScenarioFile(FILE);
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      scenarios: file.scenarios,
      capabilityProbes: {},
      dbTag: "conv_eval_c11",
    });
    expect(run.counts).toEqual({ pass: 2, fail: 0, skip: 5 });
    const byId = new Map(run.results.map((result) => [result.id, result]));

    const corrected = byId.get("not-what-i-meant-01")!;
    expect(corrected.status).toBe("pass");
    expect(corrected.turns[1]!.reply).toContain("Nothing tracked");

    const salience = byId.get("multi-proposal-salience-01")!;
    expect(salience.status).toBe("pass");
    // Turn 2 parked the persona change (the salient last offer); turn 3's
    // bare yes applied it deterministically — zero dispatches.
    expect(salience.turns[2]!.passes).toEqual([]);
    expect(salience.turns[2]!.auditMarkers).toEqual(["proposal-affirm-applied"]);
    expect(salience.turns[2]!.reply).toContain("profile");

    for (const [id, capability] of [
      ["hijack-calibration-01", "calibration_miss_side_effect"],
      ["one-off-day-01", "calibration_miss_side_effect"],
      ["address-me-sir-01", "profile_address_keys"],
      ["multi-proposal-salience-02", "per_type_proposal_slots"],
      ["pertinent-emails-content-01", "gmail_content_tools"],
    ] as const) {
      const skipped = byId.get(id)!;
      expect(skipped.status).toBe("skip");
      expect(skipped.reason).toContain(capability);
      expect(skipped.turns).toEqual([]);
    }
  });

  it("real core probes: the four reset-lane capabilities are LIT now that C1/C2/C4/amendment-5 landed", async () => {
    const probes = await probeCoreCapabilities([
      "calibration_miss_side_effect",
      "profile_address_keys",
      "per_type_proposal_slots",
      "gmail_content_tools",
    ]);
    expect(probes).toEqual({
      calibration_miss_side_effect: true,
      profile_address_keys: true,
      per_type_proposal_slots: true,
      gmail_content_tools: true,
    });
  });

  it("seeding: clock + calibration item + gmail rows land before turn 1", async () => {
    const run = await runConversationEval({
      databaseUrl: TEST_DATABASE_URL!,
      dbTag: "conv_eval_c11_seed",
      capabilityProbes: {},
      scenarios: parseScenarioFile({
          version: 1,
          scenarios: [
            {
              id: "seed-calibration-synthetic-01",
              description: "clock + open calibration item; a tool-routed turn is never a miss",
              principal: "jehad",
              clock: "2026-09-22T03:45:00.000Z",
              seed: { calibrationItem: { prompt_sent_at: "2026-09-22T03:30:00.000Z" } },
              turns: [
                {
                  user: "what's on my calendar tomorrow?",
                  modelScript: [
                    { pass: "route", output: '{"tool":"calendar.day","day":"tomorrow"}' },
                    { pass: "answer", output: "Nothing scheduled." },
                  ],
                },
              ],
              expectations: {
                routed_tools: ["calendar.day"],
                db_pins: [
                  {
                    sql: "SELECT 1 FROM calibration_items WHERE status = 'open' AND prompt_sent_at = '2026-09-22T03:30:00.000Z' AND period_date = '2026-09-21'",
                    expect_one: true,
                  },
                ],
              },
            },
            {
              id: "seed-gmail-synthetic-01",
              description: "gmail content fixture rows land before turn 1",
              principal: "jehad",
              seed: {
                gmailMessages: [
                  { from: "billing@acme.com", subject: "Invoice due Friday", body: "pay it", age_hours: 3 },
                  { from: "billing@stripe.com", subject: "Invoice due Tuesday", body: "autopay ok", age_hours: 5 },
                  { from: "news@digest.example", subject: "Weekly digest", body: "stories", age_hours: 8 },
                ],
              },
              turns: [
                {
                  user: "hello there",
                  modelScript: [
                    { pass: "route", output: '{"tool":"none"}' },
                    { pass: "answer", output: "hi" },
                  ],
                },
              ],
              expectations: {
                routed_none: true,
                db_pins: [
                  {
                    sql: "SELECT 1 FROM gmail_messages WHERE from_addr LIKE 'billing@%' HAVING count(*) = 2",
                    expect_one: true,
                  },
                  {
                    sql: "SELECT 1 FROM gmail_messages WHERE body_text LIKE '%pay it%' AND (internal_date AT TIME ZONE 'America/Los_Angeles')::date = '2026-09-21'",
                    expect_one: true,
                  },
                ],
              },
            },
          ],
        }).scenarios,
    });
    expect(run.counts).toEqual({ pass: 2, fail: 0, skip: 0 });
    const calibration = run.results[0]!;
    // Tool routes are NEVER misses — the seeded open item coexists with a
    // fully model-answered turn even pre-C1.
    expect(calibration.turns[0]!.auditMarkers).toEqual([]);
    const gmail = run.results[1]!;
    expect(gmail.status).toBe("pass");
  });
});
