/**
 * Review batching (M6C; plan §13: "review queue: escalations +
 * semantic-promotion approvals, batched" — the attention-conservation rule:
 * one review session covers a bounded, ordered batch, not a stream).
 *
 * batchPendingReview marks up to maxBatch pending escalations 'batched'
 * (escalations status vocabulary; in_review candidates have no 'batched'
 * status — they are simply included in the batch listing). Ordering is
 * urgency desc, then est_human_minutes asc (quick wins first), then age —
 * the most attention-worthy items surface at the top of one session.
 * listBatch returns the current batch: in_review candidates via the M5C
 * review-queue module (composed, not modified) + batched escalations.
 */

import type { PromotionDb } from "../promotion/pipeline.js";
import {
  listReviewQueue,
  type ReviewEscalationItem,
  type ReviewPromotionItem,
} from "./review-queue.js";

/**
 * urgency is unconstrained text in v1 (plan §7); this is the ranking the
 * batch ordering understands. Unknown/null urgency ranks lowest — an
 * unquantified urgency never jumps a named one.
 */
export const URGENCY_RANK: Readonly<Record<string, number>> = {
  blocker: 5,
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Attention-conservation default: a session reviews at most this many items. */
export const DEFAULT_MAX_BATCH = 25;

/** urgency desc, est_human_minutes asc (nulls last), then oldest first. */
const BATCH_ORDER_SQL = `
  CASE urgency
    WHEN 'blocker' THEN 5 WHEN 'critical' THEN 4 WHEN 'high' THEN 3
    WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0
  END DESC,
  est_human_minutes ASC NULLS LAST,
  created_at ASC,
  id ASC
`;

const ESCALATION_SELECT = `
  SELECT id, run_id, reason, urgency, consequence_of_waiting, est_human_minutes,
         blocked_run_ids, status, created_at
  FROM escalations
`;

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toEscalationItem(row: Record<string, unknown>): ReviewEscalationItem {
  return {
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
  };
}

/** One review session: in_review candidates + batched escalations. */
export interface ReviewBatch {
  readonly candidates: readonly ReviewPromotionItem[];
  readonly escalations: readonly ReviewEscalationItem[];
}

export interface BatchPendingReviewOptions {
  /** Max escalations pulled into the batch (default 25). */
  readonly maxBatch?: number;
}

export interface BatchPendingReviewResult extends ReviewBatch {
  /** Escalations newly marked 'batched' by this call, in batch order. */
  readonly escalations: readonly ReviewEscalationItem[];
  /** in_review candidates included in the session (bounded by maxBatch). */
  readonly candidates: readonly ReviewPromotionItem[];
}

/**
 * Forms the next review session: marks up to maxBatch pending escalations
 * 'batched' (urgency desc, est_human_minutes asc) and returns the batch —
 * those escalations plus the current in_review candidates.
 */
export async function batchPendingReview(
  db: PromotionDb,
  opts: BatchPendingReviewOptions = {},
): Promise<BatchPendingReviewResult> {
  const maxBatch = Math.max(1, opts.maxBatch ?? DEFAULT_MAX_BATCH);

  const marked = await db.query(
    `WITH picked AS (
       SELECT id FROM escalations
       WHERE status = 'pending'
       ORDER BY ${BATCH_ORDER_SQL}
       LIMIT $1
     ), marked AS (
       UPDATE escalations e
       SET status = 'batched', updated_at = now()
       FROM picked p
       WHERE e.id = p.id
       RETURNING e.id
     )
     SELECT e.id, e.run_id, e.reason, e.urgency, e.consequence_of_waiting,
            e.est_human_minutes, e.blocked_run_ids, e.status, e.created_at
     FROM escalations e
     JOIN marked m ON m.id = e.id
     ORDER BY ${BATCH_ORDER_SQL}`,
    [maxBatch],
  );

  const queue = await listReviewQueue(db, { promotionLimit: maxBatch });

  return {
    escalations: marked.rows.map(toEscalationItem),
    candidates: queue.promotions,
  };
}

/** Lists the current batch: batched escalations (ordered) + in_review candidates. */
export async function listBatch(
  db: PromotionDb,
  opts: BatchPendingReviewOptions = {},
): Promise<ReviewBatch> {
  const limit = Math.max(1, opts.maxBatch ?? DEFAULT_MAX_BATCH);
  const escalations = await db.query(
    `${ESCALATION_SELECT}
     WHERE status = 'batched'
     ORDER BY ${BATCH_ORDER_SQL}
     LIMIT $1`,
    [limit],
  );
  const queue = await listReviewQueue(db, { promotionLimit: limit });
  return {
    escalations: escalations.rows.map(toEscalationItem),
    candidates: queue.promotions,
  };
}
