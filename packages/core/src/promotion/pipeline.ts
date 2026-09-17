/**
 * Promotion pipeline orchestration — loads candidate facts, runs the pure
 * five-gate evaluation (gates.ts), persists status/gate_result, performs the
 * canonical write, and emits `memory.promoted` (catalog v1) — all in one
 * transaction so a candidate row, its canonical landing, and its event
 * commit or roll back together.
 *
 * The pipeline never calls a model: the only injected policy object is the
 * (pure) ModelEgressPolicyRegistry for gate 3, and every threshold comes
 * from PromotionGateConfig — data, not judgment (ADR-0004).
 */

import type { ModelEgressPolicyRegistry, StorageMode } from "../egress/index.js";
import { acceptEvent } from "../events/store.js";
import type { AssertionKind, ProposedClass } from "../memory/candidate-contract.js";
import { loadEmpiricalPrecision, type EmpiricalPrecision } from "../trust/index.js";
import {
  DEFAULT_PROMOTION_GATE_CONFIG,
  validatePromotionGateConfig,
  type PromotionGateConfig,
} from "./config.js";
import {
  classifySensitivity,
  evaluateGates,
  type ExistingConflictRecord,
  type GateDomain,
  type GateEvaluation,
  type GateNumber,
  type PromotionRejectionReason,
  type PromotionReviewReason,
} from "./gates.js";
import { performCanonicalWrite, type CanonicalWriteResult } from "./writers.js";

/** Structural slice of pg.Pool — connect() yields a transaction-capable client. */
export interface PromotionDb {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<PromotionTx & { release(): void }>;
}

export interface PromotionTx {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class CandidateNotFoundError extends Error {
  constructor(readonly candidateId: string) {
    super(`memory candidate ${candidateId} not found`);
    this.name = "CandidateNotFoundError";
  }
}

export class InvalidCandidateStatusError extends Error {
  constructor(readonly candidateId: string, readonly status: string, readonly needed: string) {
    super(`memory candidate ${candidateId} has status "${status}" (${needed})`);
    this.name = "InvalidCandidateStatusError";
  }
}

export interface PromotionOutcome {
  readonly candidateId: string;
  readonly action: GateEvaluation["action"];
  readonly gate: GateNumber | null;
  readonly reason: PromotionRejectionReason | PromotionReviewReason | null;
  readonly message: string;
  readonly gatedClass: ProposedClass;
  readonly write: Pick<CanonicalWriteResult, "target" | "targetId"> | null;
  /** memory.promoted event id, when this call promoted the candidate. */
  readonly eventId: string | null;
}

export interface PromoteOptions {
  readonly config?: PromotionGateConfig;
  readonly egressRegistry: ModelEgressPolicyRegistry;
  readonly now?: () => Date;
  /** Review-queue approve path: overrides gate-4/5 review routing (never hard gates). */
  readonly review?: { readonly approvedBy: string };
}

interface LoadedCandidate {
  id: string;
  status: string;
  proposedClass: ProposedClass;
  assertionKind: AssertionKind;
  payload: Record<string, unknown>;
  provenance: GateCandidateProvenance;
  confidence: number;
  gateResult: Record<string, unknown> | null;
  domain: GateDomain & { uuid: string };
}

interface GateCandidateProvenance {
  sourceEventId: string | null;
  runId: string | null;
  model: string | null;
  promptVersion: string | null;
}

const CANDIDATE_SELECT = `
  SELECT c.id, c.status, c.proposed_class, c.assertion_kind, c.payload, c.provenance,
         c.gate_result,
         d.id AS domain_uuid, d.key AS domain_key, d.storage_mode,
         d.sensitivity AS domain_sensitivity, d.retention_class
  FROM memory_candidates c
  JOIN domains d ON d.id = c.domain_id
  WHERE c.id = $1::uuid
`;

/**
 * The candidate's confidence lives inside the proposal payload jsonb — the
 * memory_candidates table has no confidence column (schema v1, data-model
 * §5.9); the seam contract's `confidence` serializes as payload.confidence.
 * Missing/malformed confidence fails closed to 0 (gate 4 routes it to
 * low-confidence review — never silently passes).
 */
export function confidenceFromPayload(payload: Readonly<Record<string, unknown>>): number {
  const raw = payload.confidence;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseProvenance(raw: unknown): GateCandidateProvenance {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { sourceEventId: null, runId: null, model: null, promptVersion: null };
  }
  const p = raw as Record<string, unknown>;
  const orNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    sourceEventId: orNull(p.sourceEventId),
    runId: orNull(p.runId),
    model: orNull(p.model),
    promptVersion: orNull(p.promptVersion),
  };
}

async function loadCandidate(db: PromotionDb, candidateId: string): Promise<LoadedCandidate> {
  const result = await db.query(CANDIDATE_SELECT, [candidateId]);
  const row = result.rows[0];
  if (row === undefined) throw new CandidateNotFoundError(candidateId);
  const storageMode = String(row.storage_mode);
  if (storageMode !== "local" && storageMode !== "remote" && storageMode !== "federated" && storageMode !== "opaque") {
    throw new Error(`domain "${String(row.domain_key)}" has invalid storage_mode ${JSON.stringify(storageMode)}`);
  }
  return {
    id: String(row.id),
    status: String(row.status),
    proposedClass: String(row.proposed_class) as ProposedClass,
    assertionKind: String(row.assertion_kind) as AssertionKind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    provenance: parseProvenance(row.provenance),
    confidence: confidenceFromPayload((row.payload ?? {}) as Record<string, unknown>),
    gateResult: (row.gate_result ?? null) as Record<string, unknown> | null,
    domain: {
      uuid: String(row.domain_uuid),
      key: String(row.domain_key),
      storageMode,
      sensitivity: String(row.domain_sensitivity),
      retentionClass: String(row.retention_class),
    },
  };
}

/** Gate 4 probe: newest canonical claim for the same class+key in the domain. */
async function probeConflict(
  db: PromotionDb,
  candidate: LoadedCandidate,
  config: PromotionGateConfig,
): Promise<ExistingConflictRecord | null> {
  const { payloadKeyField, payloadValueField } = config.gate4Confidence.conflict;
  const key = candidate.payload[payloadKeyField];
  const value = candidate.payload[payloadValueField];
  if (typeof key !== "string" || key.length === 0 || typeof value !== "string") return null;
  const result = await db.query(
    `SELECT id, metadata->>'value' AS value, metadata->>'candidateId' AS candidate_id
     FROM evidence
     WHERE domain_id = $1::uuid AND metadata->>'class' = $2 AND metadata->>'conflictKey' = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [candidate.domain.uuid, candidate.proposedClass, key],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    recordId: String(row.id),
    value: typeof row.value === "string" ? row.value : "",
    candidateId:
      row.candidate_id === null || row.candidate_id === undefined
        ? null
        : String(row.candidate_id),
  };
}

function gateResultJson(
  evaluation: GateEvaluation,
  config: PromotionGateConfig,
  now: Date,
  write: CanonicalWriteResult | null,
  review: PromoteOptions["review"],
): string {
  return JSON.stringify({
    version: 1,
    configVersion: config.version,
    evaluatedAt: now.toISOString(),
    action: evaluation.action,
    gate: evaluation.gate,
    reason: evaluation.reason,
    message: evaluation.message,
    sensitivity: evaluation.sensitivity,
    retentionClass: evaluation.retentionClass,
    egressRuleId: evaluation.egressRuleId ?? null,
    conflict: evaluation.conflict,
    note: evaluation.note,
    confidencePolicy: evaluation.confidencePolicy,
    write: write === null ? null : { target: write.target, targetId: write.targetId },
    review: review === undefined ? null : { approvedBy: review.approvedBy, at: now.toISOString() },
  });
}

async function persistAndWrite(
  tx: PromotionTx,
  candidate: LoadedCandidate,
  evaluation: GateEvaluation,
  config: PromotionGateConfig,
  opts: PromoteOptions,
  now: Date,
): Promise<{ write: CanonicalWriteResult | null; eventId: string | null }> {
  let write: CanonicalWriteResult | null = null;
  let eventId: string | null = null;

  if (evaluation.action === "promoted" && evaluation.canonicalWrite) {
    write = await performCanonicalWrite(tx, {
      candidateId: candidate.id,
      domainUuid: candidate.domain.uuid,
      sourceEventId: candidate.provenance.sourceEventId!,
      assertionKind: candidate.assertionKind,
      payload: candidate.payload,
      confidence: candidate.confidence,
      evaluation,
      config,
      now,
    });
  }

  if (evaluation.action === "promoted") {
    // memory.promoted (catalog v1) — idempotent on candidate id.
    const accepted = await acceptEvent(tx, {
      type: "memory.promoted",
      schemaVersion: 1,
      source: "internal",
      externalId: `memory.promoted:${candidate.id}`,
      occurredAt: now.toISOString(),
      domainId: candidate.domain.key,
      sensitivity: evaluation.sensitivity,
      payload: {
        candidateId: candidate.id,
        proposedClass: candidate.proposedClass,
        gatedClass: evaluation.gatedClass,
        assertionKind: candidate.assertionKind,
        target: write?.target ?? "none",
        targetId: write?.targetId ?? null,
        ...(opts.review === undefined ? {} : { review: { approvedBy: opts.review.approvedBy } }),
      },
      runId: candidate.provenance.runId,
    });
    eventId = accepted.envelope.id;
  }

  await tx.query(
    `UPDATE memory_candidates
     SET gated_class = $2, gate_result = $3::jsonb, status = $4, updated_at = now()
     WHERE id = $1::uuid`,
    [
      candidate.id,
      evaluation.gatedClass,
      gateResultJson(evaluation, config, now, write, opts.review),
      evaluation.action,
    ],
  );

  return { write, eventId };
}

async function withTransaction<T>(db: PromotionDb, fn: (tx: PromotionTx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Loads the gate-4 empirical precision source when the config names one.
 * Missing file → null (gate 4 fails action decisions closed at 0.5);
 * malformed file → throws (fail closed — never silently trust the model's
 * raw number). IO lives here, never in the gates.
 */
async function loadGate4Empirical(
  config: PromotionGateConfig,
): Promise<EmpiricalPrecision | null | undefined> {
  if (config.gate4Confidence.empiricalPrecisionPath === null) return undefined;
  return loadEmpiricalPrecision(config.gate4Confidence.empiricalPrecisionPath);
}

/**
 * Runs the five-gate pipeline for one candidate and persists the outcome.
 * Callable on status proposed/gated; on in_review only via the review-queue
 * approve path (opts.review.approvedBy) — never silently.
 */
export async function promoteCandidate(
  db: PromotionDb,
  candidateId: string,
  opts: PromoteOptions,
): Promise<PromotionOutcome> {
  const config = opts.config ?? DEFAULT_PROMOTION_GATE_CONFIG;
  validatePromotionGateConfig(config);
  const now = opts.now?.() ?? new Date();

  const candidate = await loadCandidate(db, candidateId);
  if (opts.review === undefined) {
    if (candidate.status !== "proposed" && candidate.status !== "gated") {
      throw new InvalidCandidateStatusError(candidateId, candidate.status, "expected proposed or gated; in_review candidates go through the review queue");
    }
  } else {
    if (candidate.status !== "in_review") {
      throw new InvalidCandidateStatusError(candidateId, candidate.status, "review approve requires in_review");
    }
  }

  // Gather gate facts (outside the write tx; read-only).
  let sourceEventExists = false;
  if (candidate.provenance.sourceEventId !== null) {
    const found = await db.query("SELECT 1 AS ok FROM events WHERE id = $1::uuid", [
      candidate.provenance.sourceEventId,
    ]);
    sourceEventExists = found.rows.length > 0;
  }
  const existingConflict = await probeConflict(db, candidate, config);
  const empirical = await loadGate4Empirical(config);

  // Gate 3 context: the classified sensitivity is the same value gate_result records.
  const sensitivity = classifySensitivity(candidate.payload, candidate.domain, config);
  const egress = opts.egressRegistry.check({
    domainId: candidate.domain.key,
    sensitivity,
    provider: config.gate3Egress.provider,
    model: config.gate3Egress.model,
    storageMode: candidate.domain.storageMode as StorageMode,
  });

  const evaluation = evaluateGates(
    {
      candidate: {
        id: candidate.id,
        proposedClass: candidate.proposedClass,
        assertionKind: candidate.assertionKind,
        payload: candidate.payload,
        provenance: candidate.provenance,
        confidence: candidate.confidence,
      },
      domain: candidate.domain,
      sourceEventExists,
      egress,
      existingConflict,
      empirical,
    },
    config,
    { overrideReview: opts.review !== undefined },
  );

  const { write, eventId } = await withTransaction(db, (tx) =>
    persistAndWrite(tx, candidate, evaluation, config, opts, now),
  );

  return {
    candidateId: candidate.id,
    action: evaluation.action,
    gate: evaluation.gate,
    reason: evaluation.reason,
    message: evaluation.message,
    gatedClass: evaluation.gatedClass,
    write: write === null ? null : { target: write.target, targetId: write.targetId },
    eventId,
  };
}
