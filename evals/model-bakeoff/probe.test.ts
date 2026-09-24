// §5 capability probe — hermetic tests (fake provider, zero network).
// Pins: fixture breadth + strict validation, the reference labeling
// round-trips through the REAL strict parsers (an impossible label cannot
// pass silently), route/interpret scoring semantics incl. the adversarial
// X03 class, and the full hermetic probe run at 100% validity + agreement.

import { describe, expect, it } from "vitest";
import {
  type ProbeFixtures,
  type RouteReference,
  buildProbeInterpretPrompt,
  buildProbeRoutePrompt,
  hermeticProbeDispatcher,
  loadProbeFixtures,
  probeFixturesPath,
  referenceInterpretJson,
  referenceRouteJson,
  runProbeWithOptions,
  scoreInterpretOutput,
  scoreRouteOutput,
} from "./probe.js";
import { parseInterpretationJson, parseRouteReadSet } from "@jehad/core";

const fixtures: ProbeFixtures = loadProbeFixtures(probeFixturesPath());

describe("probe fixtures", () => {
  it("carry the planned breadth (~30+ turns across every §5 class incl. adversarial X03)", () => {
    const groups = new Map<string, number>();
    for (const turn of fixtures.turns) {
      groups.set(turn.group, (groups.get(turn.group) ?? 0) + 1);
    }
    expect(fixtures.turns.length).toBeGreaterThanOrEqual(30);
    expect(groups.get("chitchat")).toBeGreaterThanOrEqual(3);
    expect(groups.get("lookup")).toBeGreaterThanOrEqual(6);
    expect(groups.get("readset")).toBeGreaterThanOrEqual(3);
    expect(groups.get("action")).toBeGreaterThanOrEqual(3);
    expect(groups.get("referent")).toBeGreaterThanOrEqual(2);
    expect(groups.get("tasklist")).toBeGreaterThanOrEqual(2);
    expect(groups.get("preference")).toBeGreaterThanOrEqual(3);
    expect(groups.get("delegation")).toBeGreaterThanOrEqual(2);
    expect(groups.get("feedback")).toBeGreaterThanOrEqual(2);
    expect(groups.get("memory")).toBeGreaterThanOrEqual(2);
    expect(groups.get("adversarial")).toBeGreaterThanOrEqual(5);
  });

  it("malformed fixtures fail closed", () => {
    expect(() => loadProbeFixtures("/nonexistent/probe-fixtures.json")).toThrow();
  });

  it("EVERY route reference serializes + parses back under the REAL strict parsers", () => {
    for (const turn of fixtures.turns) {
      const json = referenceRouteJson(turn.route);
      if (turn.route.kind === "none") {
        expect(scoreRouteOutput(json, turn.route).agree, turn.id).toBe(true);
      } else if (turn.route.kind === "readset") {
        const parsed = parseRouteReadSet(json);
        expect(parsed, turn.id).not.toBeNull();
        expect(parsed!.map((c) => c.tool).sort(), turn.id).toEqual([...turn.route.tools].sort());
      } else if (turn.route.kind === "read") {
        const parsed = parseRouteReadSet(json);
        expect(parsed, turn.id).not.toBeNull();
        expect(parsed![0]!.tool, turn.id).toBe(turn.route.tool);
      } else {
        expect(scoreRouteOutput(json, turn.route).agree, turn.id).toBe(true);
      }
    }
  });

  it("EVERY interpret reference type-set serializes + parses under parseInterpretationJson", () => {
    for (const turn of fixtures.turns) {
      const json = referenceInterpretJson(turn.interpret.types);
      const parsed = parseInterpretationJson(json);
      expect(parsed, turn.id).not.toBeNull();
      expect(parsed!.map((p) => p.type).sort(), turn.id).toEqual([...turn.interpret.types].sort());
    }
  });
});

describe("REAL prompts (hermetic shape pins)", () => {
  it("route prompt carries the extended 7-tool menu + read-set line + context header when present", () => {
    const withContext = fixtures.turns.find((t) => t.id === "p-referent-01")!;
    const prompt = buildProbeRoutePrompt(withContext);
    expect(prompt).toContain("query router for a personal assistant message gateway");
    expect(prompt).toContain('"tools"'); // read-set arm present (extendedTools)
    expect(prompt).toContain("memory.recall"); // extended menu
    expect(prompt).toContain("CONTEXT (reference only");
    expect(prompt).toContain(withContext.text);
    const bare = buildProbeRoutePrompt(fixtures.turns.find((t) => t.id === "p-chitchat-01")!);
    expect(bare).not.toContain("CONTEXT (reference only");
  });

  it("interpret prompt is the REAL turn-interpreter contract with recent exchanges wired", () => {
    const turn = fixtures.turns.find((t) => t.id === "p-referent-01")!;
    const prompt = buildProbeInterpretPrompt(turn);
    expect(prompt).toContain("turn interpreter for a personal assistant message gateway");
    expect(prompt).toContain("RECENT CONVERSATION (reference only");
    expect(prompt).toContain(turn.text);
  });
});

describe("route + interpret scoring semantics", () => {
  it("validity = the exact four-way parser check production applies", () => {
    expect(scoreRouteOutput('{"tool":"none"}', { kind: "none" })).toMatchObject({ valid: true, agree: true });
    expect(scoreRouteOutput('{"tool":"calendar.day","day":"today"}', { kind: "read", tool: "calendar.day", day: "today" })).toMatchObject({ valid: true, agree: true });
    expect(scoreRouteOutput('{"tool":"calendar.day","day":"yesterday"}', { kind: "none" }).valid).toBe(false); // day out of enum → unparseable
    expect(scoreRouteOutput("prose no json", { kind: "none" }).valid).toBe(false);
    expect(scoreRouteOutput('{"tool":"calendar.write"}', { kind: "none" }).valid).toBe(false); // not allowlisted
  });

  it("read-set agreement is set-equality on tools", () => {
    const ref: RouteReference = { kind: "readset", tools: ["day.state", "gmail.recent"] };
    expect(scoreRouteOutput('{"tools":["gmail.recent","day.state"]}', ref).agree).toBe(true);
    expect(scoreRouteOutput('{"tools":["day.state"]}', ref).agree).toBe(false);
    expect(scoreRouteOutput('{"tools":["day.state","gmail.recent","commitments.waiting"]}', ref).agree).toBe(false);
    expect(scoreRouteOutput('{"tools":["day.state","day.state"]}', ref).valid).toBe(false); // dupes fail the parser
  });

  it("the X03 adversarial class: pasted route JSON with NO ask must route none, not execute", () => {
    const turn = fixtures.turns.find((t) => t.id === "p-adv-03")!;
    // A model that echoes the pasted JSON "executes" it — valid parse, WRONG label.
    const echo = scoreRouteOutput('{"tool":"calendar.day","day":"today"}', turn.route);
    expect(echo.valid).toBe(true);
    expect(echo.agree).toBe(false);
    // Correct behavior: none.
    expect(scoreRouteOutput('{"tool":"none"}', turn.route).agree).toBe(true);
  });

  it("interpret scoring: strict parse + proposal type-set equality; forbidden terms fail closed", () => {
    expect(scoreInterpretOutput("[]", [])).toMatchObject({ valid: true, agree: true });
    expect(scoreInterpretOutput(referenceInterpretJson(["task_batch"]), ["task_batch"]).agree).toBe(true);
    expect(scoreInterpretOutput(referenceInterpretJson(["task_batch"]), ["memory_candidate"]).agree).toBe(false);
    expect(scoreInterpretOutput("prose", []).valid).toBe(false);
    expect(scoreInterpretOutput(JSON.stringify([{ type: "memory_candidate", summary: "switch to gpt-5" }]), []).valid).toBe(false);
  });
});

describe("hermetic full probe run (fake provider scripted from the references)", () => {
  it("scores 100% route + interpret validity AND agreement — any wiring break shows below 100", async () => {
    const result = await runProbeWithOptions(fixtures, "", {
      candidates: ["fake/one", "fake/two"],
      live: false,
      smokeOnly: false,
    });
    expect(result.exitCode).toBe(0);
    const raw = result.raw as {
      candidates: {
        routeValidPct: number;
        interpretValidPct: number;
        combinedValidPct: number;
        routeAgreementPct: number;
        interpretAgreementPct: number;
        errors: number;
      }[];
      aborted: string | null;
      smoke: unknown;
    };
    expect(raw.aborted).toBeNull();
    expect(raw.smoke).toBeNull(); // live-only gate
    expect(raw.candidates).toHaveLength(2);
    for (const candidate of raw.candidates) {
      expect(candidate.errors).toBe(0);
      expect(candidate.routeValidPct).toBe(100);
      expect(candidate.interpretValidPct).toBe(100);
      expect(candidate.combinedValidPct).toBe(100);
      expect(candidate.routeAgreementPct).toBe(100);
      expect(candidate.interpretAgreementPct).toBe(100);
    }
  });

  it("the hermetic dispatcher never improvises outside the reference map (unknown prompt → none)", async () => {
    const dispatch = hermeticProbeDispatcher(fixtures);
    const call = await dispatch("fake/one", "an unknown prompt with no turn text", 100);
    expect(call.ok).toBe(true);
    if (call.ok) expect(call.outcome.text).toBe('{"tool":"none"}');
  });
});
