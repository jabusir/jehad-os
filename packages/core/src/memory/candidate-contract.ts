// Shared contract between the extraction lane (M5B — produces candidates)
// and the promotion lane (M5C — gates and lands them). Owned by the
// orchestrator; lanes import read-only (plan §6.2, ADR-0004).

export type AssertionKind =
  | "observed"
  | "user_declared"
  | "externally_sourced"
  | "model_inferred"
  | "computed";

export type ProposedClass =
  | "discard"
  | "working"
  | "episodic"
  | "semantic"
  | "preference"
  | "commitment"
  | "decision"
  | "assumption"
  | "procedural"
  | "policy";

export type CandidateStatus = "proposed" | "gated" | "promoted" | "rejected" | "in_review";

/**
 * Commitment temporal stance (owner directive 2026-09-17): extraction
 * classifies WHEN the obligation stands, because "I told him last Friday I
 * would send it Monday" must not become an open commitment.
 */
export type CommitmentState =
  | "prospective" // depends on a future trigger; not yet standing
  | "active" // a standing open obligation
  | "completed" // discharged ("I already did")
  | "historical" // reported as past ("was supposed to", "had planned")
  | "renegotiated" // latest terms of a changed commitment
  | "cancelled" // negated or withdrawn
  | "hypothetical"; // conditional ("if X, then I'll Y")

/**
 * Temporal provenance (owner directive 2026-09-17): the LLM extracts the
 * temporal EXPRESSION; a deterministic normalizer resolves it. Raw model
 * dates never drive overdue logic. Unknown is better than confidently
 * wrong: ambiguous expressions resolve to null + status, never a guess.
 */
export interface TemporalProvenance {
  /** Verbatim expression from the text, e.g. "next Friday". */
  readonly rawExpression: string | null;
  /** The anchor the normalizer resolved against (event occurredAt). */
  readonly anchorTime: string;
  readonly anchorTimezone: string;
  /** Resolved ISO date (YYYY-MM-DD) or null when ambiguous/unsupported. */
  readonly normalizedTime: string | null;
  readonly resolutionStatus: "resolved" | "ambiguous" | "unsupported" | "none";
  /** Version of the deterministic normalizer (re-normalizable). */
  readonly normalizerVersion: string;
  /** 0-1 confidence OF THE NORMALIZER's rule match, not of the model. */
  readonly resolutionConfidence: number;
  /** Which rule fired: calendar-native passthrough, weekday, in-N-weeks,
   *  month-day, end-of-month, explicit-iso, etc. */
  readonly resolutionMethod: string | null;
}

/** Row shape extraction writes; promotion reads (snake_case at the DB layer). */
export interface MemoryCandidateContract {
  proposedClass: ProposedClass;
  assertionKind: AssertionKind;
  domainId: string;
  payload: Record<string, unknown>;
  provenance: {
    sourceEventId: string;
    runId: string | null;
    model: string | null;
    promptVersion: string | null;
  };
  confidence: number;
}
