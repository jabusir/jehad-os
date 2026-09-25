// Wave SV1/SV2: the send-time claim audit. Pure behavior — protocol claims
// verify against injected facts, mismatch = strip + action-oriented truthful
// replacement (no retry); waiting-relation content mismatches surface for the
// caller's single revise; safe fallback renders from grounded facts.

import { describe, expect, it } from "vitest";
import {
  auditReplyClaims,
  safeFallbackRendering,
  truthfulReplacement,
  type ClaimAuditFacts,
} from "./claim-audit.js";

const NO_WRITES: ClaimAuditFacts = {
  writes: { commitmentsCreated: 0, remindersCreated: 0 },
  pendingProposal: false,
  pendingProposalLabel: null,
  brief: { sources: { calendar: "read", gmail: "read" } },
  openCounterparties: [{ name: "Tayyab", openCount: 0 }],
};

const WITH_WRITES: ClaimAuditFacts = {
  ...NO_WRITES,
  writes: { commitmentsCreated: 9, remindersCreated: 1 },
};

describe("SV1 protocol claims (deterministic verify → replace, no retry)", () => {
  it("the 00:09 lie: 'I'll capture all 9 items' with zero writes → replaced", () => {
    const r = auditReplyClaims("Understood.\n\nI'll capture all 9 items right away.", NO_WRITES);
    expect(r.text).not.toContain("capture all 9");
    expect(r.text).toContain("I haven't changed anything yet");
    expect(r.protocolFindings[0]?.claim_type).toBe("future_write");
    expect(r.protocolFindings[0]?.remediation).toBe("deterministic_replace");
  });

  it("past-tense persistence lie ('I tracked those') → replaced", () => {
    const r = auditReplyClaims("I tracked those for you.", NO_WRITES);
    expect(r.protocolFindings[0]?.claim_type).toBe("persistence_write");
    expect(r.text).toContain("I haven't changed anything yet");
  });

  it("the 00:10 lie: 'nothing is waiting' with a pending batch → action-oriented pending line", () => {
    const facts: ClaimAuditFacts = {
      ...NO_WRITES,
      pendingProposal: true,
      pendingProposalLabel: "task batch",
    };
    const r = auditReplyClaims("Nothing is waiting for confirmation right now.", facts);
    expect(r.text).toContain("nothing changes until you say yes");
    expect(r.protocolFindings[0]?.claim_type).toBe("negative_pending");
  });

  it("the 00:05 lie: 'can't reach your calendar' while calendar reads → replaced", () => {
    const r = auditReplyClaims("I can't reach your calendar this turn.", NO_WRITES);
    expect(r.protocolFindings[0]?.claim_type).toBe("negative_access");
    expect(r.protocolFindings[0]?.verification_basis).toContain("sources.calendar = read");
  });

  it("true claims pass untouched", () => {
    const t = "Tracked 9 commitments — 3 due Wednesday.";
    const r = auditReplyClaims(t, WITH_WRITES);
    expect(r.text).toBe(t);
    expect(r.protocolFindings).toHaveLength(0);
  });

  it("negative access is NOT flagged when the source really is down", () => {
    const facts: ClaimAuditFacts = {
      ...NO_WRITES,
      brief: { sources: { calendar: "disconnected", gmail: "read" } },
    };
    const r = auditReplyClaims("I can't reach your calendar right now.", facts);
    expect(r.protocolFindings).toHaveLength(0);
  });

  it("questions and ordinary conversation are never hijacked", () => {
    const t = "Did you create that file? I can check tomorrow if you want.";
    expect(auditReplyClaims(t, NO_WRITES).text).toBe(t);
  });

  it("truthfulReplacement prefers the pending offer (action-oriented)", () => {
    const line = truthfulReplacement({ ...NO_WRITES, pendingProposal: true, pendingProposalLabel: "task batch" });
    expect(line).toContain("not done yet");
  });
});

describe("SV2 waiting-relation content claims (one revise, caller-driven)", () => {
  it("surfaces a content mismatch when the entity has zero open commitments", () => {
    const r = auditReplyClaims(
      "The venue decision is your main blocker because Tayyab is waiting on it.",
      NO_WRITES,
    );
    expect(r.contentMismatch).not.toBeNull();
    expect(r.contentMismatch?.entity).toBe("Tayyab");
    expect(r.contentMismatch?.finding.claim_type).toBe("waiting_relation");
    expect(r.text).toContain("Tayyab is waiting on it"); // caller decides revise; text untouched
  });

  it("relation claims about entities WITH open commitments pass", () => {
    const facts: ClaimAuditFacts = {
      ...NO_WRITES,
      openCounterparties: [{ name: "Henna", openCount: 2 }],
    };
    const r = auditReplyClaims("Henna is waiting on the venue call.", facts);
    expect(r.contentMismatch).toBeNull();
  });

  it("safe fallback renders from grounded facts", () => {
    const out = safeFallbackRendering("Tayyab", NO_WRITES);
    expect(out).toContain("no open commitments involving Tayyab");
    expect(out).toContain("won't guess");
    const withData = safeFallbackRendering("Henna", {
      ...NO_WRITES,
      openCounterparties: [{ name: "Henna", openCount: 2 }],
    });
    expect(withData).toContain("Henna: 2 open");
  });
});
