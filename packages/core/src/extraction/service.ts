/**
 * Extraction service (M5B; plan §13): accepted capture/decision event →
 * extraction prompt → injected ModelProvider (port; egress-gated upstream)
 * → allowlisted parse → memory_candidates rows per the shared contract →
 * `memory.proposed` event per candidate.
 *
 * No promotion logic (M5C's): every row lands status='proposed' with
 * gated_class/gate_result null. No live API calls in tests — providers are
 * injected (fake in tests; the real OpenRouter provider lands with M5A).
 *
 * Retry semantics: candidate ids are deterministic in the source event +
 * proposal content, and each candidate's `memory.proposed` external id is
 * deterministic in the candidate id — so an at-least-once redelivery of the
 * same extraction result is a no-op, not a duplicate candidate.
 */

import { createHash } from "node:crypto";
import type { ModelProvider } from "@jehad/adapters";
import type { EventEnvelope } from "../events/envelope.js";
import { acceptEvent, DomainNotFoundError, type EventStoreExecutor } from "../events/store.js";
import type { MemoryCandidateContract } from "../memory/candidate-contract.js";
import { parseExtractionOutput, ExtractionParseError, type ExtractionProposal } from "./parse.js";
import { buildExtractionPrompt, EXTRACTION_PROMPT_VERSION } from "./prompt.js";
import { proposalToCandidates } from "./proposal.js";

/** Event types extraction consumes (catalog v1). */
export const EXTRACTABLE_EVENT_TYPES = ["capture.recorded", "decision.recorded"] as const;

export class UnsupportedEventError extends Error {
  constructor(readonly eventType: string) {
    super(`extraction does not process event type "${eventType}"`);
    this.name = "UnsupportedEventError";
  }
}

export class MissingCaptureTextError extends Error {
  constructor(readonly eventId: string) {
    super(`event ${eventId} payload has no non-empty "text" string`);
    this.name = "MissingCaptureTextError";
  }
}

export interface ExtractionPipelineResult {
  readonly proposal: ExtractionProposal;
  readonly droppedFields: readonly string[];
  readonly promptVersion: string;
}

/**
 * Prompt → provider → parse. Pure aside from the provider call; shared by
 * the persisting service and the eval runner so both score the exact same
 * pipeline. `provider` must already be egress-gated (ADR-0012).
 */
export async function runExtractionPipeline(
  provider: ModelProvider,
  envelope: EventEnvelope,
  opts: { model: string },
): Promise<ExtractionPipelineResult> {
  if (!(EXTRACTABLE_EVENT_TYPES as readonly string[]).includes(envelope.type)) {
    throw new UnsupportedEventError(envelope.type);
  }
  const text = envelope.payload.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new MissingCaptureTextError(envelope.id);
  }
  const { prompt, promptVersion } = buildExtractionPrompt(envelope);
  const result = await provider.complete({
    domainId: envelope.domainId,
    sensitivity: envelope.sensitivity,
    provider: provider.id,
    model: opts.model,
    prompt,
    runId: envelope.runId ?? undefined,
  });
  const { proposal, droppedFields } = parseExtractionOutput(result.text);
  return { proposal, droppedFields, promptVersion };
}

export interface ExtractFromEventDeps {
  readonly db: EventStoreExecutor;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly now?: () => Date;
}

export interface WrittenCandidate {
  readonly id: string;
  readonly contract: MemoryCandidateContract;
  readonly memoryProposedEventId: string;
}

export interface ExtractionRunResult extends ExtractionPipelineResult {
  readonly candidates: readonly WrittenCandidate[];
}

/**
 * Deterministic candidate id: sha256(source event id + proposed class +
 * assertion kind + payload). Same source event + same extraction output →
 * same id → the INSERT's ON CONFLICT DO NOTHING makes redelivery a no-op.
 */
export function deterministicCandidateId(contract: MemoryCandidateContract): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        contract.provenance.sourceEventId,
        contract.proposedClass,
        contract.assertionKind,
        contract.payload,
      ]),
      "utf-8",
    )
    .digest("hex");
  const hex = hash.slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

const INSERT_CANDIDATE_SQL = `
  INSERT INTO memory_candidates
    (id, domain_id, proposed_class, assertion_kind, payload, provenance, status)
  VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, 'proposed')
  ON CONFLICT (id) DO NOTHING
  RETURNING id
`;

async function resolveDomainId(db: EventStoreExecutor, domainKey: string): Promise<string> {
  const result = await db.query("SELECT id FROM domains WHERE key = $1", [domainKey]);
  const row = result.rows[0];
  if (row === undefined) throw new DomainNotFoundError(domainKey);
  return String(row.id);
}

export async function extractFromEvent(
  deps: ExtractFromEventDeps,
  envelope: EventEnvelope,
): Promise<ExtractionRunResult> {
  const pipeline = await runExtractionPipeline(deps.provider, envelope, { model: deps.model });
  const contracts = proposalToCandidates(pipeline.proposal, envelope, { model: deps.model });

  const domainId = await resolveDomainId(deps.db, envelope.domainId);
  const now = (deps.now ?? (() => new Date()))();
  const candidates: WrittenCandidate[] = [];

  for (const contract of contracts) {
    const id = deterministicCandidateId(contract);
    const insert = await deps.db.query(INSERT_CANDIDATE_SQL, [
      id,
      domainId,
      contract.proposedClass,
      contract.assertionKind,
      JSON.stringify(contract.payload),
      JSON.stringify(contract.provenance),
    ]);
    if (insert.rows[0] === undefined) {
      // Deterministic-id conflict: same extraction already persisted (retry).
      await deps.db.query("SELECT id FROM memory_candidates WHERE id = $1", [id]);
    }

    // memory.proposed per candidate — references only, no bodies. The
    // deterministic external id makes event redelivery idempotent too.
    const accepted = await acceptEvent(deps.db, {
      type: "memory.proposed",
      schemaVersion: 1,
      source: "internal",
      externalId: `memory-candidate:${id}`,
      occurredAt: now.toISOString(),
      domainId: envelope.domainId,
      sensitivity: envelope.sensitivity,
      payload: {
        candidateId: id,
        proposedClass: contract.proposedClass,
        assertionKind: contract.assertionKind,
        kind: contract.payload.kind,
        confidence: contract.confidence,
        sourceEventId: envelope.id,
        model: deps.model,
        promptVersion: EXTRACTION_PROMPT_VERSION,
      },
      runId: envelope.runId,
    });
    candidates.push({
      id,
      contract,
      memoryProposedEventId: accepted.envelope.id,
    });
  }

  return { ...pipeline, candidates };
}

export { ExtractionParseError };
export type { ExtractionProposal };
