// Proposal → candidate mapping (hermetic): commitment vs decision vs
// discard, assertionKind truth semantics by source, provenance.

import { describe, expect, it } from "vitest";
import type { ExtractionProposal } from "./parse.js";
import { assertionKindForSource, proposalToCandidates } from "./proposal.js";
import { makeEnvelope } from "./test-envelope.js";

const COMMITTED: ExtractionProposal = {
  isCommitment: true,
  isDecision: false,
  direction: "i_owe",
  counterparty: "Jehad",
  dueDate: "2026-09-18",
  confidence: 0.9,
  description: "Send the migration plan",
  question: null,
  chosen: null,
  rationale: "explicit future promise",
};

describe("proposalToCandidates", () => {
  it("maps a commitment proposal to one commitment candidate", () => {
    const [candidate] = proposalToCandidates(COMMITTED, makeEnvelope(), { model: "test-model" });
    expect(candidate).toBeDefined();
    expect(candidate!.proposedClass).toBe("commitment");
    expect(candidate!.assertionKind).toBe("user_declared");
    expect(candidate!.domainId).toBe("personal");
    expect(candidate!.confidence).toBe(0.9);
    expect(candidate!.payload).toEqual({
      kind: "commitment",
      direction: "i_owe",
      counterpartyText: "Jehad",
      description: "Send the migration plan",
      dueAt: "2026-09-18",
      confidence: 0.9,
    });
  });

  it("carries required provenance (sourceEventId, runId, model, promptVersion)", () => {
    const envelope = makeEnvelope({ runId: "018f0000-0000-7000-8000-00000000000f" });
    const [candidate] = proposalToCandidates(COMMITTED, envelope, { model: "or-model" });
    expect(candidate!.provenance.sourceEventId).toBe(envelope.id);
    expect(candidate!.provenance.runId).toBe(envelope.runId);
    expect(candidate!.provenance.model).toBe("or-model");
    expect(candidate!.provenance.promptVersion).toMatch(/^m5b-extraction-v/);
  });

  it("falls back to the captured text as description when the model gave none", () => {
    const [candidate] = proposalToCandidates(
      { ...COMMITTED, description: null },
      makeEnvelope(),
    );
    expect((candidate!.payload as { description: string }).description).toBe(
      "I'll send Jehad the migration plan Friday.",
    );
  });

  it("maps a decision proposal to one decision candidate", () => {
    const [candidate] = proposalToCandidates(
      {
        isCommitment: false,
        isDecision: true,
        direction: null,
        counterparty: null,
        dueDate: null,
        confidence: 0.8,
        description: null,
        question: "Which database?",
        chosen: "Postgres",
        rationale: null,
      },
      makeEnvelope({ type: "decision.recorded" }),
    );
    expect(candidate!.proposedClass).toBe("decision");
    expect(candidate!.payload).toEqual({
      kind: "decision",
      question: "Which database?",
      chosen: "Postgres",
      confidence: 0.8,
    });
  });

  it("maps a mixed proposal to BOTH commitment and decision candidates", () => {
    const candidates = proposalToCandidates(
      { ...COMMITTED, isDecision: true, question: "Ship Friday?", chosen: "yes" },
      makeEnvelope(),
    );
    expect(candidates.map((c) => c.proposedClass)).toEqual(["commitment", "decision"]);
  });

  it("maps a no-find proposal to ONE discard candidate (provenance preserved)", () => {
    const candidates = proposalToCandidates(
      {
        isCommitment: false,
        isDecision: false,
        direction: null,
        counterparty: null,
        dueDate: null,
        confidence: 0.25,
        description: null,
        question: null,
        chosen: null,
        rationale: "statement of fact",
      },
      makeEnvelope(),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.proposedClass).toBe("discard");
    expect(candidates[0]!.provenance.sourceEventId).toBe(makeEnvelope().id);
    expect(candidates[0]!.payload).toEqual({ kind: "discard", rationale: "statement of fact" });
  });

  it("derives assertionKind from the event source, never the model", () => {
    expect(assertionKindForSource("cli.capture")).toBe("user_declared");
    expect(assertionKindForSource("openclaw.channel")).toBe("externally_sourced");
    expect(assertionKindForSource("adapter:smtp")).toBe("externally_sourced");
    expect(assertionKindForSource("internal")).toBe("model_inferred");

    const channel = makeEnvelope({ source: "openclaw.channel" });
    const [candidate] = proposalToCandidates(COMMITTED, channel);
    expect(candidate!.assertionKind).toBe("externally_sourced");
  });
});
