// Proposal → candidate mapping (hermetic): commitment vs decision vs
// discard, assertionKind truth semantics by source, provenance, and the
// deterministic temporal block (v3: the normalizer resolves, not the model).

import { describe, expect, it } from "vitest";
import type { ExtractionProposal } from "./parse.js";
import {
  anchorTimezone,
  assertionKindForSource,
  buildTemporalProvenance,
  proposalToCandidates,
} from "./proposal.js";
import { NORMALIZER_VERSION } from "./temporal/normalizer.js";
import { makeEnvelope } from "./test-envelope.js";

const COMMITTED: ExtractionProposal = {
  isCommitment: true,
  isDecision: false,
  direction: "i_owe",
  counterparty: "Jehad",
  temporalExpression: "Friday",
  temporalType: "relative",
  commitmentState: "active",
  confidence: 0.9,
  description: "Send the migration plan",
  question: null,
  chosen: null,
  rationale: "explicit future promise",
};

describe("proposalToCandidates", () => {
  it("maps a commitment proposal to one commitment candidate with the deterministic temporal block", () => {
    // Anchor 2026-09-17 (Thursday) UTC → "Friday" = next occurrence strictly after.
    const [candidate] = proposalToCandidates(COMMITTED, makeEnvelope(), {
      model: "test-model",
      anchorTimezone: "UTC",
    });
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
      temporal: {
        rawExpression: "Friday",
        anchorTime: "2026-09-17T09:00:00.000Z",
        anchorTimezone: "UTC",
        normalizedTime: "2026-09-18",
        resolutionStatus: "resolved",
        normalizerVersion: NORMALIZER_VERSION,
        resolutionConfidence: 1,
        resolutionMethod: "weekday",
      },
      commitmentState: "active",
      confidence: 0.9,
    });
  });

  it("ambiguous expressions keep the commitment open but NEVER fabricate a date", () => {
    const [candidate] = proposalToCandidates(
      { ...COMMITTED, temporalExpression: "sometime next week", temporalType: "vague" },
      makeEnvelope(),
      { anchorTimezone: "UTC" },
    );
    const payload = candidate!.payload as { temporal: { normalizedTime: string | null; resolutionStatus: string } };
    expect(payload.temporal.normalizedTime).toBeNull();
    expect(payload.temporal.resolutionStatus).toBe("ambiguous");
  });

  it("defaults commitmentState to active when the model omitted/degraded it", () => {
    const [candidate] = proposalToCandidates(
      { ...COMMITTED, commitmentState: null },
      makeEnvelope(),
      { anchorTimezone: "UTC" },
    );
    expect((candidate!.payload as { commitmentState: string }).commitmentState).toBe("active");
  });

  it("carries extracted non-active states through to the payload", () => {
    const [candidate] = proposalToCandidates(
      { ...COMMITTED, commitmentState: "historical", temporalExpression: "last week" },
      makeEnvelope(),
      { anchorTimezone: "UTC" },
    );
    const payload = candidate!.payload as { commitmentState: string; temporal: { resolutionStatus: string } };
    expect(payload.commitmentState).toBe("historical");
    expect(payload.temporal.resolutionStatus).toBe("unsupported"); // past phrase: honest, no guess
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
        temporalExpression: null,
        temporalType: null,
        commitmentState: null,
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
        temporalExpression: null,
        temporalType: null,
        commitmentState: null,
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

describe("buildTemporalProvenance / anchorTimezone", () => {
  it("anchorTimezone defaults to UTC without JEHAD_TZ", () => {
    const saved = process.env.JEHAD_TZ;
    delete process.env.JEHAD_TZ;
    try {
      expect(anchorTimezone()).toBe("UTC");
    } finally {
      if (saved !== undefined) process.env.JEHAD_TZ = saved;
    }
  });

  it("anchorTimezone honors JEHAD_TZ", () => {
    const saved = process.env.JEHAD_TZ;
    process.env.JEHAD_TZ = "America/New_York";
    try {
      expect(anchorTimezone()).toBe("America/New_York");
      const provenance = buildTemporalProvenance(
        { temporalExpression: "tomorrow" },
        makeEnvelope(),
      );
      expect(provenance.anchorTimezone).toBe("America/New_York");
    } finally {
      if (saved === undefined) delete process.env.JEHAD_TZ;
      else process.env.JEHAD_TZ = saved;
    }
  });
});
