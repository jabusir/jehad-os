/**
 * Review queue service (M5C; ADR-0004 consequence: "review queue carries
 * semantic proposals, batched, per the attention guardrail").
 *
 * Lists pending promotions (memory_candidates.status='in_review') together
 * with pending/batched escalations, and completes or discards queued
 * promotions: approve → re-runs gate 5 under review override (completes the
 * canonical write + memory.promoted); reject → discards (status='rejected',
 * nothing canonical is written).
 */

import type { ModelEgressPolicyRegistry } from "../egress/index.js";
import { confidenceFromPayload, promoteCandidate, type PromotionDb, type PromotionOutcome } from "../promotion/pipeline.js";
import type { PromotionGateConfig } from "../promotion/config.js";

export interface ReviewPromotionItem {
  readonly id: string;
  readonly domainKey: string;
  readonly proposedClass: string;
  readonly assertionKind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly gateResult: Readonly<Record<string, unknown>> | null;
  readonly confidence: number;
  readonly createdAt: string;
}

export interface ReviewEscalationItem {
  readonly id: string;
  readonly runId: string;
  readonly reason: string;
  readonly urgency: string | null;
  readonly consequenceOfWaiting: string | null;
  readonly estHumanMinutes: number | null;
  readonly status: string;
  readonly createdAt: string;
}

export interface ReviewQueue {
  /** Pending semantic proposals, oldest first (review the longest-waiting). */
  readonly promotions: readonly ReviewPromotionItem[];
  /** Pending/batched escalations alongside them (one attention pass). */
  readonly escalations: readonly ReviewEscalationItem[];
}

export interface ListReviewQueueOptions {
  readonly promotionLimit?: number;
  readonly escalationLimit?: number;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Lists the review queue: pending promotions + pending/batched escalations. */
export async function listReviewQueue(
  db: PromotionDb,
  opts: ListReviewQueueOptions = {},
): Promise<ReviewQueue> {
  const promotionLimit = opts.promotionLimit ?? 50;
  const escalationLimit = opts.escalationLimit ?? 50;

  const promotions = await db.query(
    `SELECT c.id, d.key AS domain_key, c.proposed_class, c.assertion_kind, c.payload,
            c.provenance, c.gate_result, c.created_at
     FROM memory_candidates c
     JOIN domains d ON d.id = c.domain_id
     WHERE c.status = 'in_review'
     ORDER BY c.created_at ASC
     LIMIT $1`,
    [promotionLimit],
  );
  const escalations = await db.query(
    `SELECT id, run_id, reason, urgency, consequence_of_waiting, est_human_minutes, status, created_at
     FROM escalations
     WHERE status IN ('pending', 'batched')
     ORDER BY created_at ASC
     LIMIT $1`,
    [escalationLimit],
  );

  return {
    promotions: promotions.rows.map((row) => ({
      id: String(row.id),
      domainKey: String(row.domain_key),
      proposedClass: String(row.proposed_class),
      assertionKind: String(row.assertion_kind),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      provenance: (row.provenance ?? {}) as Record<string, unknown>,
      gateResult: (row.gate_result ?? null) as Record<string, unknown> | null,
      confidence: confidenceFromPayload((row.payload ?? {}) as Record<string, unknown>),
      createdAt: toIso(row.created_at),
    })),
    escalations: escalations.rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      reason: String(row.reason),
      urgency: row.urgency === null || row.urgency === undefined ? null : String(row.urgency),
      consequenceOfWaiting:
        row.consequence_of_waiting === null || row.consequence_of_waiting === undefined
          ? null
          : String(row.consequence_of_waiting),
      estHumanMinutes:
        row.est_human_minutes === null || row.est_human_minutes === undefined
          ? null
          : Number(row.est_human_minutes),
      status: String(row.status),
      createdAt: toIso(row.created_at),
    })),
  };
}

export interface ApproveOptions {
  readonly config?: PromotionGateConfig;
  readonly egressRegistry: ModelEgressPolicyRegistry;
  readonly approvedBy: string;
  readonly now?: () => Date;
}

/**
 * Approves one queued promotion: gate 5 completes under review override —
 * the canonical write lands, status becomes promoted, and memory.promoted is
 * emitted with the reviewer recorded. Hard gates (provenance/domain/egress)
 * still apply; if state changed since routing, approval can still reject.
 */
export async function approvePromotion(
  db: PromotionDb,
  candidateId: string,
  opts: ApproveOptions,
): Promise<PromotionOutcome> {
  return promoteCandidate(db, candidateId, {
    config: opts.config,
    egressRegistry: opts.egressRegistry,
    now: opts.now,
    review: { approvedBy: opts.approvedBy },
  });
}

/** Batch approve (attention guardrail: review in batches, not one-by-one). */
export async function approvePromotions(
  db: PromotionDb,
  candidateIds: readonly string[],
  opts: ApproveOptions,
): Promise<readonly PromotionOutcome[]> {
  const outcomes: PromotionOutcome[] = [];
  for (const id of candidateIds) {
    outcomes.push(await approvePromotion(db, id, opts));
  }
  return outcomes;
}

export interface RejectOptions {
  readonly rejectedBy: string;
  readonly note?: string;
  readonly now?: () => Date;
}

export interface RejectionResult {
  readonly candidateId: string;
  readonly status: "rejected";
}

/**
 * Rejects one queued promotion: the proposal is discarded — status becomes
 * rejected, no canonical write ever happens, and the reviewer/note is
 * recorded in gate_result.review for the audit trail.
 */
export async function rejectPromotion(
  db: PromotionDb,
  candidateId: string,
  opts: RejectOptions,
): Promise<RejectionResult> {
  const now = opts.now?.() ?? new Date();
  const loaded = await db.query(
    "SELECT gate_result FROM memory_candidates WHERE id = $1::uuid AND status = 'in_review'",
    [candidateId],
  );
  const row = loaded.rows[0];
  if (row === undefined) {
    throw new Error(`rejectPromotion: candidate ${candidateId} is not in_review`);
  }
  const gateResult = (row.gate_result ?? {}) as Record<string, unknown>;
  gateResult.review = {
    rejectedBy: opts.rejectedBy,
    note: opts.note ?? null,
    at: now.toISOString(),
  };
  const updated = await db.query(
    `UPDATE memory_candidates
     SET status = 'rejected', gate_result = $2::jsonb, updated_at = now()
     WHERE id = $1::uuid AND status = 'in_review'
     RETURNING id`,
    [candidateId, JSON.stringify(gateResult)],
  );
  if (updated.rows.length === 0) {
    throw new Error(`rejectPromotion: candidate ${candidateId} left in_review concurrently`);
  }
  return { candidateId, status: "rejected" };
}
