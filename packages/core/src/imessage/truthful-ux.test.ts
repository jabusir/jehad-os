import { describe, expect, it } from "vitest";
import {
  COVERAGE_LIMIT_FIRST_RULE,
  NO_ACCESS_OVERCLAIM_RULE,
  NO_INVENTED_COMMANDS_RULE,
  PERSISTENCE_TRUTH_RULE,
  SELF_MODEL_RULE,
  TRUTHFUL_UX_RULES,
  isMachinerySentence,
  stripMachineryLines,
} from "./truthful-ux.js";

describe("TRUTHFUL_UX_RULES (W6(c) artifact pin — pure strings, exact)", () => {
  it("carries exactly the three rules in splice order", () => {
    expect(TRUTHFUL_UX_RULES).toEqual([
      PERSISTENCE_TRUTH_RULE,
      COVERAGE_LIMIT_FIRST_RULE,
      SELF_MODEL_RULE,
      NO_INVENTED_COMMANDS_RULE,
      NO_ACCESS_OVERCLAIM_RULE,
    ]);
    expect(TRUTHFUL_UX_RULES).toHaveLength(5);
  });

  it("rule (a) pins the §5-15 persistence invariant, including the no-write wording", () => {
    expect(PERSISTENCE_TRUTH_RULE).toContain("never say you noted, saved, added, updated");
    expect(PERSISTENCE_TRUTH_RULE).toContain("will remember, or are tracking");
    expect(PERSISTENCE_TRUTH_RULE).toContain("durable write succeeded this turn");
    expect(PERSISTENCE_TRUTH_RULE).toContain(
      "\"I see it in our conversation, but I'm not tracking it yet.\"",
    );
  });

  it("rule (b) pins the coverage-limit-first ordering for judgment questions", () => {
    expect(COVERAGE_LIMIT_FIRST_RULE).toContain("pertinent, important, urgent");
    expect(COVERAGE_LIMIT_FIRST_RULE).toContain("metadata/partial");
    expect(COVERAGE_LIMIT_FIRST_RULE).toContain("state that limit FIRST");
    expect(COVERAGE_LIMIT_FIRST_RULE).toContain("then give what patterns do show, then what would be needed");
  });

  it("rule (c) pins self-knowledge to the SELF-BRIEF block only", () => {
    expect(SELF_MODEL_RULE).toContain("Never describe your own capabilities from memory");
    expect(SELF_MODEL_RULE).toContain("only from the SELF-BRIEF block when present");
  });

  it("the artifact is frozen data — no functions, no capability or model names", () => {
    expect(Object.isFrozen(TRUTHFUL_UX_RULES)).toBe(true);
    for (const rule of TRUTHFUL_UX_RULES) {
      expect(typeof rule).toBe("string");
      expect(rule.length).toBeGreaterThan(0);
    }
    const joined = TRUTHFUL_UX_RULES.join("\n").toLowerCase();
    expect(joined).not.toMatch(/\bgpt-|claude|gemini|openrouter\b/);
  });
});

describe("stripMachineryLines (00:09 transcript: the model invented 'confirm')", () => {
  it("strips the exact fabricated line from the transcript", () => {
    expect(
      stripMachineryLines(
        "Understood.\n\nI'll capture all 9 items: 3 due Wednesday, 6 due Thursday.\n\nReply 'confirm' to track them.",
      ),
    ).toBe("Understood.\n\nI'll capture all 9 items: 3 due Wednesday, 6 due Thursday.");
  });
  it("strips respond-with and say-the-word variants", () => {
    expect(stripMachineryLines("Done. Respond with 'approve' to apply.")).toBe("Done.");
    expect(stripMachineryLines("Okay. Say \"track them\" if you want that.")).toBe("Okay.");
    expect(isMachinerySentence("Reply 'confirm' to track them.")).toBe(true);
  });
  it("never touches ordinary conversation", () => {
    const t = "I can call the venue tomorrow to confirm the appointment details.";
    expect(stripMachineryLines(t)).toBe(t);
    const t2 = "What time works for you?";
    expect(stripMachineryLines(t2)).toBe(t2);
  });
  it("long lines that merely quote a word are preserved", () => {
    const long = "You asked me to reply 'confirm' " + "x".repeat(160) + " and that is the full story.";
    expect(stripMachineryLines(long)).toBe(long);
  });
});
