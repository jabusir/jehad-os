// W5(c) hermetic unit tests: the verb grammar corpus (positives + pinned
// negatives), the thread-relevance predicate, the PURE resolver matrix
// (sole / none / ambiguous / ref / unknown / collision), and the reply
// goldens. No DB, no clock, no model calls.

import { describe, expect, it } from "vitest";
import {
  commitmentRefCode,
  COMMITMENT_REF_ALPHABET,
  matchesReferentLabels,
  parseCommitmentVerb,
  renderCommitmentVerbReply,
  resolveCommitmentTarget,
  type EligibleCommitment,
} from "./transitions.js";

function item(id: string, description: string, over: Partial<EligibleCommitment> = {}): EligibleCommitment {
  return {
    id,
    direction: "i_owe",
    counterpartyText: "self",
    description,
    dueAt: null,
    confidence: 0.9,
    status: "open",
    domainKey: "personal",
    ...over,
  };
}

describe("parseCommitmentVerb (grammar corpus)", () => {
  it("parses the spec forms", () => {
    expect(parseCommitmentVerb("done")).toEqual({ verb: "done" });
    expect(parseCommitmentVerb("Done.")).toEqual({ verb: "done" });
    expect(parseCommitmentVerb("  missed!  ")).toEqual({ verb: "missed" });
    expect(parseCommitmentVerb("mark that done")).toEqual({ verb: "done" });
    expect(parseCommitmentVerb("Mark it done.")).toEqual({ verb: "done" });
    expect(parseCommitmentVerb("done [7K4]")).toEqual({ verb: "done", ref: "7K4" });
    expect(parseCommitmentVerb("missed [7k4]")).toEqual({ verb: "missed", ref: "7K4" });
    expect(parseCommitmentVerb("renegotiated")).toEqual({ verb: "renegotiated" });
    expect(parseCommitmentVerb("renegotiated: new terms apply")).toEqual({
      verb: "renegotiated",
      note: "new terms apply",
    });
    expect(parseCommitmentVerb("missed [7K4]")).toEqual({ verb: "missed", ref: "7K4" });
    expect(parseCommitmentVerb("done [7K4]: paid yesterday")).toEqual({
      verb: "done",
      ref: "7K4",
      note: "paid yesterday",
    });
    expect(parseCommitmentVerb("renegotiated — monthly instead")).toEqual({
      verb: "renegotiated",
      note: "monthly instead",
    });
    expect(parseCommitmentVerb("missed - forgot entirely")).toEqual({
      verb: "missed",
      note: "forgot entirely",
    });
  });

  it("pins the negatives: idioms and non-verb utterances are NOT verbs", () => {
    // "done deal" is an idiom, not a bare transition verb.
    expect(parseCommitmentVerb("done deal")).toBeNull();
    // "missed you" is prose; a trailing bare word never parses as a ref.
    expect(parseCommitmentVerb("missed you")).toBeNull();
    expect(parseCommitmentVerb("i'm done")).toBeNull();
    expect(parseCommitmentVerb("what's done?")).toBeNull();
    expect(parseCommitmentVerb("undone")).toBeNull();
    expect(parseCommitmentVerb("")).toBeNull();
    // Refs REQUIRE brackets (deliberate deviation from review-commands'
    // optional brackets): a bare trailing 3-letter word is never a ref.
    expect(parseCommitmentVerb("done 7K4")).toBeNull();
    expect(parseCommitmentVerb("can this be renegotiated next week?")).toBeNull();
  });
});

describe("matchesReferentLabels (thread-relevance hint)", () => {
  it("no labels → everything eligible (unfiltered)", () => {
    expect(matchesReferentLabels(item("c1", "Pay October rent"), [])).toBe(true);
    expect(matchesReferentLabels(item("c1", "Pay October rent"), ["  ", ""])).toBe(true);
  });

  it("label ⊂ description+counterparty, case/whitespace-insensitive", () => {
    expect(
      matchesReferentLabels(
        item("c1", "Confirm venue by Friday", { counterpartyText: "Henna" }),
        ["Henna sync proposal — confirm venue"],
      ),
    ).toBe(true);
    expect(
      matchesReferentLabels(item("c1", "Pay October rent", { counterpartyText: "Landlord" }), ["october rent"]),
    ).toBe(true);
  });

  it("description ⊂ label (short commitment named by a longer referent)", () => {
    expect(matchesReferentLabels(item("c1", "Book squash court"), ["the book squash court reminder from Tuesday"])).toBe(true);
  });

  it("unrelated labels exclude", () => {
    expect(matchesReferentLabels(item("c1", "Pay October rent", { counterpartyText: "Landlord" }), ["venue tour"])).toBe(false);
  });
});

describe("resolveCommitmentTarget (pure resolver matrix)", () => {
  const sole = [item("c-1", "Pay October rent")];
  const many = [
    item("c-1", "Confirm venue by Friday", { counterpartyText: "Henna" }),
    item("c-2", "Book squash court", { counterpartyText: "Gym" }),
  ];

  it("sole eligible → apply", () => {
    expect(resolveCommitmentTarget(sole)).toEqual({
      kind: "sole",
      id: "c-1",
      description: "Pay October rent",
    });
  });

  it("zero eligible → honest none", () => {
    expect(resolveCommitmentTarget([])).toEqual({ kind: "none" });
  });

  it("multiple eligible → ambiguous with derived codes", () => {
    const resolution = resolveCommitmentTarget(many);
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.candidates).toHaveLength(2);
      for (const c of resolution.candidates) {
        expect(c.ref).toMatch(new RegExp(`^[${COMMITMENT_REF_ALPHABET}]{3}$`));
        expect(c.ref).toBe(commitmentRefCode(c.id));
      }
    }
  });

  it("ref → the one eligible item whose derived code matches", () => {
    const ref = commitmentRefCode("c-2");
    expect(resolveCommitmentTarget(many, ref)).toEqual({
      kind: "ref",
      id: "c-2",
      description: "Book squash court",
      ref,
    });
    // case-insensitive normalization
    expect(resolveCommitmentTarget(many, ref.toLowerCase())).toMatchObject({ kind: "ref", id: "c-2" });
  });

  it("shape-valid but unmatched or off-alphabet refs are unknown — never a guess", () => {
    expect(resolveCommitmentTarget(many, "AAA")).toMatchObject({ kind: "unknown_ref", ref: "AAA" });
    // O and U are outside the Crockford alphabet (013 confusable rule).
    expect(resolveCommitmentTarget(many, "YOU")).toMatchObject({ kind: "unknown_ref", ref: "YOU" });
    expect(resolveCommitmentTarget([], "7K4")).toMatchObject({ kind: "unknown_ref", ref: "7K4" });
  });

  it("a code collision inside the eligible set stays ambiguous, never arbitrary", () => {
    // Brute-force two ids whose derived codes collide (32³ space — a
    // birthday collision surfaces within a few hundred draws).
    const seen = new Map<string, string>();
    let first = "";
    let second = "";
    for (let i = 0; first === ""; i++) {
      const id = `collision-probe-${i}`;
      const code = commitmentRefCode(id);
      const prior = seen.get(code);
      if (prior !== undefined) {
        first = prior;
        second = id;
      } else {
        seen.set(code, id);
      }
    }
    const resolution = resolveCommitmentTarget(
      [item(first, "First"), item(second, "Second")],
      commitmentRefCode(first),
    );
    expect(resolution.kind).toBe("ambiguous");
  });
});

describe("renderCommitmentVerbReply (goldens)", () => {
  it("sole + done confirms exactly what changed", () => {
    expect(
      renderCommitmentVerbReply({ kind: "sole", id: "c-1", description: "Pay October rent" }, "done"),
    ).toBe("Marked: Pay October rent — done.");
  });

  it("ref confirms; renegotiated/missed carry their verb", () => {
    expect(
      renderCommitmentVerbReply(
        { kind: "ref", id: "c-2", description: "Book squash court", ref: "7K4" },
        "renegotiated",
      ),
    ).toBe("Marked: Book squash court — renegotiated.");
    expect(
      renderCommitmentVerbReply({ kind: "sole", id: "c-1", description: "Pay October rent" }, "missed"),
    ).toBe("Marked: Pay October rent — missed.");
  });

  it("none is the honest zero", () => {
    expect(renderCommitmentVerbReply({ kind: "none" }, "done")).toBe("Nothing open matches that.");
  });

  it("unknown ref never guesses", () => {
    expect(renderCommitmentVerbReply({ kind: "unknown_ref", ref: "AAA" }, "done")).toBe(
      "Unknown ref — nothing changed. Reply with a ref from the list I sent.",
    );
  });

  it("ambiguous clarifies with derived codes, one candidate per line", () => {
    const reply = renderCommitmentVerbReply(
      {
        kind: "ambiguous",
        candidates: [
          { id: "c-1", description: "Confirm venue by Friday", direction: "i_owe", counterpartyText: "Henna", ref: "7K4" },
          { id: "c-2", description: "Book squash court", direction: "i_owe", counterpartyText: "Gym", ref: "A2M" },
        ],
      },
      "done",
    );
    expect(reply).toBe(
      "Which one? Reply with its ref:\n- [7K4] Confirm venue by Friday (i_owe Henna)\n- [A2M] Book squash court (i_owe Gym)",
    );
  });

  it("caps the clarification list at 5 candidates", () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      id: `c-${i}`,
      description: `Item ${i}`,
      direction: "i_owe" as const,
      counterpartyText: "self",
      ref: commitmentRefCode(`c-${i}`),
    }));
    const reply = renderCommitmentVerbReply({ kind: "ambiguous", candidates }, "done");
    const lines = reply.split("\n");
    expect(lines).toHaveLength(7); // header + 5 candidates + overflow
    expect(lines.at(-1)).toBe("- …and 3 more");
  });
});
