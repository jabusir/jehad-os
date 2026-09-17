/**
 * Proposal → memory-candidate mapping (M5B).
 *
 * Produces rows per the shared seam (../memory/candidate-contract.ts —
 * imported read-only; owned by the orchestrator). NO promotion logic here:
 * gates, gated_class, and review routing are M5C's.
 *
 * Mapping rules (deterministic, auditable):
 * - isCommitment → one "commitment" candidate (payload mirrors the columns
 *   M5C will land in `commitments`; the temporal block is built HERE by the
 *   deterministic normalizer anchored at envelope.occurredAt, tz JEHAD_TZ
 *   default "UTC" — the model never resolves dates).
 * - isDecision   → one "decision" candidate (question/chosen).
 * - neither      → one "discard" candidate — extraction ran and found
 *   nothing; the row preserves the run's provenance (every accepted capture
 *   yields ≥1 candidate).
 * A capture may yield both a commitment and a decision candidate.
 *
 * assertionKind (truth semantics, plan §6.2) is derived from the event
 * SOURCE, never from the model: the user's own CLI words are user_declared;
 * channel/adapter content is externally_sourced; anything else (internal)
 * is model_inferred. The model's role is parsing, not attestation.
 */

import type { EventEnvelope } from "../events/envelope.js";
import type {
  AssertionKind,
  CommitmentState,
  MemoryCandidateContract,
  ProposedClass,
  TemporalProvenance,
} from "../memory/candidate-contract.js";
import { EXTRACTION_PROMPT_VERSION } from "./prompt.js";
import type { ExtractionDirection, ExtractionProposal } from "./parse.js";
import {
  DEFAULT_ANCHOR_TIMEZONE,
  normalizeTemporalExpression,
} from "./temporal/normalizer.js";

/** Cap for the description fallback (the captured text itself). */
const DESCRIPTION_MAX = 500;

/**
 * Anchor timezone for temporal normalization. Config via JEHAD_TZ (IANA name,
 * e.g. "America/New_York"); default "UTC". Recorded inside every
 * TemporalProvenance block so re-normalization is fully deterministic.
 */
export function anchorTimezone(): string {
  const tz = process.env.JEHAD_TZ;
  return typeof tz === "string" && tz.trim().length > 0 ? tz.trim() : DEFAULT_ANCHOR_TIMEZONE;
}

/** Deterministic resolution of the extracted expression against the capture time. */
export function buildTemporalProvenance(
  proposal: Pick<ExtractionProposal, "temporalExpression">,
  envelope: EventEnvelope,
  timezone: string = anchorTimezone(),
): TemporalProvenance {
  return normalizeTemporalExpression({
    expression: proposal.temporalExpression,
    anchorTime: envelope.occurredAt,
    anchorTimezone: timezone,
  });
}

export function assertionKindForSource(source: string): AssertionKind {
  if (source === "cli.capture") return "user_declared";
  if (source === "openclaw.channel" || source.startsWith("adapter:")) {
    return "externally_sourced";
  }
  return "model_inferred";
}

export interface CommitmentCandidatePayload {
  readonly kind: "commitment";
  readonly direction: ExtractionDirection | null;
  readonly counterpartyText: string;
  readonly description: string;
  /** Deterministic temporal block (raw expression + normalized resolution). */
  readonly temporal: TemporalProvenance;
  /** Missing/invalid states default to active (a standing obligation). */
  readonly commitmentState: CommitmentState;
  readonly confidence: number;
}

export interface DecisionCandidatePayload {
  readonly kind: "decision";
  readonly question: string;
  readonly chosen: string;
  readonly confidence: number;
}

export interface DiscardCandidatePayload {
  readonly kind: "discard";
  readonly rationale: string;
}

export type ExtractionCandidatePayload =
  | CommitmentCandidatePayload
  | DecisionCandidatePayload
  | DiscardCandidatePayload;

function candidate(
  envelope: EventEnvelope,
  proposedClass: ProposedClass,
  payload: ExtractionCandidatePayload,
  confidence: number,
  model: string | null,
): MemoryCandidateContract {
  return {
    proposedClass,
    assertionKind: assertionKindForSource(envelope.source),
    domainId: envelope.domainId,
    payload: { ...payload },
    provenance: {
      sourceEventId: envelope.id,
      runId: envelope.runId,
      model,
      promptVersion: EXTRACTION_PROMPT_VERSION,
    },
    confidence,
  };
}

export function proposalToCandidates(
  proposal: ExtractionProposal,
  envelope: EventEnvelope,
  opts: { model?: string | null; anchorTimezone?: string } = {},
): MemoryCandidateContract[] {
  const model = opts.model ?? null;
  const candidates: MemoryCandidateContract[] = [];

  if (proposal.isCommitment) {
    const text = typeof envelope.payload.text === "string" ? envelope.payload.text : "";
    candidates.push(
      candidate(
        envelope,
        "commitment",
        {
          kind: "commitment",
          direction: proposal.direction,
          counterpartyText: proposal.counterparty ?? "",
          description: proposal.description ?? text.slice(0, DESCRIPTION_MAX),
          temporal: buildTemporalProvenance(proposal, envelope, opts.anchorTimezone),
          commitmentState: proposal.commitmentState ?? "active",
          confidence: proposal.confidence,
        },
        proposal.confidence,
        model,
      ),
    );
  }

  if (proposal.isDecision) {
    candidates.push(
      candidate(
        envelope,
        "decision",
        {
          kind: "decision",
          question: proposal.question ?? "",
          chosen: proposal.chosen ?? "",
          confidence: proposal.confidence,
        },
        proposal.confidence,
        model,
      ),
    );
  }

  if (candidates.length === 0) {
    candidates.push(
      candidate(
        envelope,
        "discard",
        {
          kind: "discard",
          rationale: proposal.rationale ?? "no commitment or decision found",
        },
        proposal.confidence,
        model,
      ),
    );
  }

  return candidates;
}
