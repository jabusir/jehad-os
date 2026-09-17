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
