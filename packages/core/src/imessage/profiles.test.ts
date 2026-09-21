// W4 hermetic tests (jarvis-v1.md §7 W4 rev2 R2; §5 invariant 2):
// strict ProfileDefinition schema, deterministic fragment rendering with
// the authorization-vocabulary structural pin, pure override merging,
// thread-scoped override round-trip parsing, and the self-configuration
// directive grammar corpus. No DB — the integration suite covers storage.

import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_BREVITY_STEP_CHARS,
  DIRECTIVE_BREVITY_STEP_SENTENCES,
  JOSCTL_PROFILE_DEFINITION,
  PERSONA_FRAGMENT_FORBIDDEN_WORDS,
  PROFILE_BREVITY_MAX_CHARS,
  PROFILE_BREVITY_MAX_SENTENCES,
  PROFILE_EXTRA_DIRECTIVES_MAX,
  applyDefinitionDelta,
  applyOverrideDelta,
  mergeThreadOverride,
  parseProfileDefinition,
  parseProfileDirective,
  renderPersonaFragment,
} from "./profiles";
import { parseThreadMetadata } from "./threads";

const VALID = {
  register: "terse, serious, judgment-forward",
  brevity: { maxSentences: 4, maxChars: 500 },
  explanation: "lead_with_answer",
  address: { ownerName: "Chief" },
  extraDirectives: ["State what you cannot see."],
};

describe("parseProfileDefinition (strict, fail-closed)", () => {
  it("parses the full valid shape", () => {
    expect(parseProfileDefinition(VALID)).toEqual(VALID);
  });

  it("parses the minimal shape (no address, no extras)", () => {
    const minimal = {
      register: "plain",
      brevity: { maxSentences: 3, maxChars: 300 },
      explanation: "lead_with_context",
      address: {},
    };
    expect(parseProfileDefinition(minimal)).toEqual(minimal);
  });

  it("round-trips the owner-authored josctl seed constant", () => {
    expect(parseProfileDefinition(JOSCTL_PROFILE_DEFINITION)).toEqual(JOSCTL_PROFILE_DEFINITION);
  });

  it("redacts secret shapes in text fields (single choke point)", () => {
    const parsed = parseProfileDefinition({
      ...VALID,
      register: "voice 4242 4242 4242 4242",
      extraDirectives: ["card 4111 1111 1111 1111 on file"],
    });
    expect(parsed?.register).not.toMatch(/4242/);
    expect(parsed?.extraDirectives?.[0]).not.toMatch(/4111/);
  });

  it("fails closed on every structural deviation", () => {
    const cases: unknown[] = [
      null,
      undefined,
      "string",
      42,
      [],
      {},
      { ...VALID, register: "" },
      { ...VALID, register: 7 },
      { ...VALID, register: "two\nlines" },
      { ...VALID, register: "x".repeat(201) },
      { ...VALID, register: "   " },
      { ...VALID, brevity: { maxSentences: 4 } },
      { ...VALID, brevity: { maxChars: 500 } },
      { ...VALID, brevity: { maxSentences: 4, maxChars: 500, extra: 1 } },
      { ...VALID, brevity: { maxSentences: 4.5, maxChars: 500 } },
      { ...VALID, brevity: { maxSentences: "4", maxChars: 500 } },
      { ...VALID, brevity: { maxSentences: 0, maxChars: 500 } },
      { ...VALID, brevity: { maxSentences: PROFILE_BREVITY_MAX_SENTENCES + 1, maxChars: 500 } },
      { ...VALID, brevity: { maxSentences: 4, maxChars: 0 } },
      { ...VALID, brevity: { maxSentences: 4, maxChars: PROFILE_BREVITY_MAX_CHARS + 1 } },
      { ...VALID, explanation: "lead_with_vibes" },
      { ...VALID, explanation: null },
      { ...VALID, address: null },
      { ...VALID, address: [] },
      { ...VALID, address: { ownerName: "" } },
      { ...VALID, address: { ownerName: "Chief", extra: true } },
      { ...VALID, address: { ownerName: "x".repeat(61) } },
      { ...VALID, address: { ownerName: "two\nlines" } },
      { ...VALID, extraDirectives: {} },
      { ...VALID, extraDirectives: ["ok", 7] },
      { ...VALID, extraDirectives: [""] },
      { ...VALID, extraDirectives: ["two\nlines"] },
      { ...VALID, extraDirectives: ["x".repeat(121)] },
      { ...VALID, extraDirectives: Array.from({ length: PROFILE_EXTRA_DIRECTIVES_MAX + 1 }, () => "x") },
      { ...VALID, unknownKey: true },
    ];
    for (const value of cases) {
      expect(parseProfileDefinition(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("renderPersonaFragment (deterministic, structurally pinned)", () => {
  it("renders the owner profile deterministically with brevity caps and address", () => {
    const fragment = renderPersonaFragment(JOSCTL_PROFILE_DEFINITION, { principalName: "josctl" });
    expect(fragment).toBe(
      [
        "PERSONA for josctl.",
        "Voice: chief of staff: terse, serious, judgment-forward, no filler",
        "Brevity: at most 4 sentences and 500 characters per reply.",
        "Answer first: lead with the answer, then only the context that is needed.",
        'Address: call the principal "Chief".',
        "- State what you cannot see rather than papering over it.",
        "- Lead with the judgment, then the smallest sufficient support.",
      ].join("\n"),
    );
  });

  it("renders the context-first variant and omits the address line when unset", () => {
    const fragment = renderPersonaFragment(
      {
        register: "warm and direct",
        brevity: { maxSentences: 6, maxChars: 900 },
        explanation: "lead_with_context",
        address: {},
      },
      { principalName: "yusra" },
    );
    expect(fragment).toContain("Context first: lead with the necessary context, then the answer.");
    expect(fragment).not.toContain("Address:");
    expect(fragment).toContain("6 sentences and 900 characters");
  });

  it("never contains the forbidden vocabulary (substring pin, incl. grammar-generated lines)", () => {
    expect(PERSONA_FRAGMENT_FORBIDDEN_WORDS).toEqual([
      "reads",
      "policy",
      "grant",
      "capability",
      "budget",
    ]);
    const fragments = [
      renderPersonaFragment(JOSCTL_PROFILE_DEFINITION, { principalName: "josctl" }),
      renderPersonaFragment(VALID, { principalName: "a-principal" }),
      renderPersonaFragment(
        mergeThreadOverride(JOSCTL_PROFILE_DEFINITION, {
          brevityDelta: { maxSentences: -2, maxChars: -300 },
          extraDirective: "Answer the principal as \"Chief\" for this thread only.",
        }),
        { principalName: "josctl" },
      ),
    ];
    for (const fragment of fragments) {
      const lower = fragment.toLowerCase();
      for (const word of PERSONA_FRAGMENT_FORBIDDEN_WORDS) {
        expect(lower.includes(word), `${word} leaked into:\n${fragment}`).toBe(false);
      }
    }
  });

  it("ADVERSARIAL PIN: definitions smuggling forbidden words fail closed (throw, no fragment)", () => {
    const hostile = [
      { ...VALID, register: "you grant extra reads" },
      { ...VALID, address: { ownerName: "Budget" } },
      { ...VALID, extraDirectives: ["respect the policy ceiling"] },
      { ...VALID, register: "manage threads tersely" }, // substring: th-READS
      { ...VALID, extraDirectives: ["capability before all"] },
    ];
    for (const definition of hostile) {
      expect(() => renderPersonaFragment(definition, { principalName: "josctl" }), JSON.stringify(definition)).toThrow(/presentation only/);
    }
    expect(() => renderPersonaFragment(VALID, { principalName: "Grant" })).toThrow(/presentation only/);
    expect(() => renderPersonaFragment(VALID, { principalName: " " })).toThrow(/principalName/);
    expect(() => renderPersonaFragment(VALID, { principalName: "two\nlines" })).toThrow(/principalName/);
  });
});

describe("mergeThreadOverride (pure, clamped, never persists)", () => {
  it("null override returns the definition untouched", () => {
    expect(mergeThreadOverride(JOSCTL_PROFILE_DEFINITION, null)).toEqual(JOSCTL_PROFILE_DEFINITION);
  });

  it("applies additive brevity deltas and appends the directive", () => {
    const merged = mergeThreadOverride(JOSCTL_PROFILE_DEFINITION, {
      brevityDelta: { maxSentences: -2, maxChars: -300 },
      extraDirective: "Answer the principal as \"Chief\" for this thread only.",
    });
    expect(merged.brevity).toEqual({ maxSentences: 2, maxChars: 200 });
    expect(merged.extraDirectives?.at(-1)).toBe('Answer the principal as "Chief" for this thread only.');
    expect(merged.register).toBe(JOSCTL_PROFILE_DEFINITION.register);
  });

  it("clamps at the schema floors and ceilings (fail-closed bounds)", () => {
    const floored = mergeThreadOverride(JOSCTL_PROFILE_DEFINITION, {
      brevityDelta: { maxSentences: -99, maxChars: -99_999 },
    });
    expect(floored.brevity).toEqual({ maxSentences: 1, maxChars: 1 });
    const ceilinged = mergeThreadOverride(
      { ...JOSCTL_PROFILE_DEFINITION, brevity: { maxSentences: 20, maxChars: 4000 } },
      { brevityDelta: { maxSentences: 99, maxChars: 99_999 } },
    );
    expect(ceilinged.brevity).toEqual({ maxSentences: 20, maxChars: 4000 });
  });

  it("keeps only the newest directives past the ≤5 cap and clamps line length", () => {
    const base = {
      ...VALID,
      extraDirectives: ["one", "two", "three", "four", "five"],
    };
    const merged = mergeThreadOverride(base, { extraDirective: "six" });
    expect(merged.extraDirectives).toEqual(["two", "three", "four", "five", "six"]);
    const long = mergeThreadOverride(VALID, { extraDirective: "y".repeat(500) });
    expect(long.extraDirectives?.at(-1)?.length).toBe(120);
  });

  it("never mutates its inputs (pure)", () => {
    const definition = parseProfileDefinition(VALID)!;
    const snapshot = JSON.parse(JSON.stringify(definition));
    mergeThreadOverride(definition, {
      brevityDelta: { maxSentences: -3 },
      extraDirective: "line",
    });
    expect(definition).toEqual(snapshot);
  });
});

describe("parseThreadMetadata profile_override admission (strict key-set extension)", () => {
  it("round-trips a valid override under the literal profile_override key", () => {
    const metadata = {
      topic: "t",
      profile_override: {
        brevityDelta: { maxSentences: -2, maxChars: -300 },
        extraDirective: "Answer the principal as \"Chief\" for this thread only.",
      },
    };
    expect(parseThreadMetadata(JSON.parse(JSON.stringify(metadata)))).toEqual(metadata);
  });

  it("fails closed on malformed override shapes", () => {
    const cases: unknown[] = [
      { profile_override: "brief" },
      { profile_override: {} },
      { profile_override: null },
      { profile_override: { brevityDelta: {} } },
      { profile_override: { brevityDelta: { maxSentences: 1.5 } } },
      { profile_override: { brevityDelta: { maxSentences: "2" } } },
      { profile_override: { brevityDelta: { tone: -2 } } },
      { profile_override: { extraDirective: "" } },
      { profile_override: { extraDirective: "two\nlines" } },
      { profile_override: { extraDirective: "x".repeat(121) } },
      { profile_override: { brevityDelta: { maxChars: -300 }, unknown: true } },
    ];
    for (const value of cases) {
      expect(parseThreadMetadata(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("parseProfileDirective (deterministic grammar corpus)", () => {
  it("thread-scoped brevity verbs", () => {
    expect(parseProfileDirective("be brief")).toEqual({
      persist: false,
      overrideDelta: {
        brevityDelta: {
          maxSentences: -DIRECTIVE_BREVITY_STEP_SENTENCES,
          maxChars: -DIRECTIVE_BREVITY_STEP_CHARS,
        },
      },
    });
    expect(parseProfileDirective("be more detailed")).toEqual({
      persist: false,
      overrideDelta: {
        brevityDelta: {
          maxSentences: DIRECTIVE_BREVITY_STEP_SENTENCES,
          maxChars: DIRECTIVE_BREVITY_STEP_CHARS,
        },
      },
    });
  });

  it("persistent forms via always / from now on (with case, comma, punctuation tolerance)", () => {
    expect(parseProfileDirective("always be brief")).toEqual({
      persist: true,
      definitionDelta: {
        brevityDelta: { maxSentences: -2, maxChars: -300 },
      },
    });
    expect(parseProfileDirective("From now on, be more detailed.")).toEqual({
      persist: true,
      definitionDelta: { brevityDelta: { maxSentences: 2, maxChars: 300 } },
    });
    expect(parseProfileDirective("  ALWAYS   call   me Chief ")).toEqual({
      persist: true,
      definitionDelta: { addressOwnerName: "Chief" },
    });
    expect(parseProfileDirective("always stop calling me Chief")).toEqual({
      persist: true,
      definitionDelta: { removeAddress: true },
    });
  });

  it("address verbs: persistent set, thread-scoped call, thread-scoped stop", () => {
    expect(parseProfileDirective("always call me Chief")).toEqual({
      persist: true,
      definitionDelta: { addressOwnerName: "Chief" },
    });
    expect(parseProfileDirective("call me Chief")).toEqual({
      persist: false,
      overrideDelta: { extraDirective: 'Address the principal as "Chief" for this thread only.' },
    });
    expect(parseProfileDirective("stop calling me Chief")).toEqual({
      persist: false,
      overrideDelta: { extraDirective: 'Do not address the principal as "Chief" for this thread.' },
    });
  });

  it("multi-word terms survive; the resulting fragments stay vocabulary-clean", () => {
    const directive = parseProfileDirective("call me Dr. J");
    expect(directive).toEqual({
      persist: false,
      overrideDelta: { extraDirective: 'Address the principal as "Dr. J" for this thread only.' },
    });
    if (directive?.persist !== false) throw new Error("unreachable");
    const merged = mergeThreadOverride(JOSCTL_PROFILE_DEFINITION, directive.overrideDelta);
    expect(() => renderPersonaFragment(merged, { principalName: "josctl" })).not.toThrow();
  });

  it("rejects everything else (fall-through corpus) and hostile terms", () => {
    const cases = [
      "",
      "   ",
      "brief",
      "briefer",
      "be very brief",
      "be brief please",
      "be less detailed",
      "always",
      "from now on",
      "always be",
      "call me",
      "call me  ",
      "call me <script>alert(1)</script>",
      "stop calling me",
      "always call me Grant", // forbidden vocabulary inside the term — fail closed at the door
      "stop calling me Budget-Man",
      "what's on my calendar",
      "always draft emails for me",
      "call me " + "x".repeat(61),
    ];
    for (const text of cases) {
      expect(parseProfileDirective(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe("applyDefinitionDelta + applyOverrideDelta (propose→confirm apply helpers)", () => {
  it("applyDefinitionDelta clamps brevity, sets/clears address, caps extras", () => {
    const briefer = applyDefinitionDelta(JOSCTL_PROFILE_DEFINITION, {
      brevityDelta: { maxSentences: -99, maxChars: -99_999 },
    });
    expect(briefer.brevity).toEqual({ maxSentences: 1, maxChars: 1 });
    const addressed = applyDefinitionDelta(briefer, { addressOwnerName: "Coach" });
    expect(addressed.address).toEqual({ ownerName: "Coach" });
    const cleared = applyDefinitionDelta(addressed, { removeAddress: true });
    expect(cleared.address).toEqual({});
    const capped = applyDefinitionDelta(JOSCTL_PROFILE_DEFINITION, {
      extraDirective: "new line",
    });
    expect(capped.extraDirectives?.at(-1)).toBe("new line");
    expect(capped.extraDirectives?.length).toBeLessThanOrEqual(PROFILE_EXTRA_DIRECTIVES_MAX);
  });

  it("applyDefinitionDelta output always re-parses under the strict schema", () => {
    let definition = JOSCTL_PROFILE_DEFINITION;
    for (const delta of [
      { brevityDelta: { maxSentences: -50, maxChars: -50_000 } },
      { addressOwnerName: "Coach" },
      { extraDirective: "one" },
      { extraDirective: "two" },
      { extraDirective: "three" },
      { extraDirective: "four" },
      { removeAddress: true },
      { brevityDelta: { maxSentences: 50, maxChars: 50_000 } },
    ] as const) {
      definition = applyDefinitionDelta(definition, delta);
      expect(parseProfileDefinition(definition)).toEqual(definition);
      expect(() => renderPersonaFragment(definition, { principalName: "josctl" })).not.toThrow();
    }
  });

  it("applyOverrideDelta accumulates brevity component-wise and replaces the directive slot", () => {
    const first = applyOverrideDelta(null, { brevityDelta: { maxSentences: -2, maxChars: -300 } });
    expect(first).toEqual({ brevityDelta: { maxSentences: -2, maxChars: -300 } });
    const second = applyOverrideDelta(first, {
      brevityDelta: { maxChars: -100 },
      extraDirective: "line one",
    });
    expect(second).toEqual({
      brevityDelta: { maxSentences: -2, maxChars: -400 },
      extraDirective: "line one",
    });
    const third = applyOverrideDelta(second, { extraDirective: "line two" });
    expect(third).toEqual({
      brevityDelta: { maxSentences: -2, maxChars: -400 },
      extraDirective: "line two",
    });
  });
});
