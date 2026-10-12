// Attention delivery projection (W1; ADR-0018 §1.1 — the item is the durable
// truth, delivery is best-effort). This module owns the notification enqueue
// seam around kind='attention' rows (enqueueAttentionNotification in
// notifications/service.ts), the delivery-attempt/delivered stamps, and the
// liveness-driven retry of never-delivered items.
//
// Invariants baked in here:
//  - A failed/expired push never mutates or resolves the item: attempt
//    stamping happens after a successful ENQUEUE (queue + record — the edge
//    still owns its transport), and `last_delivered_at` moves forward only on
//    a channel accept reported by the delivered-callback route.
//  - Re-delivery policy is salience's decision (decideDelivery), never this
//    module's judgment; every salience gate fails open toward delivering.
//  - Counts/ids only in logs — item titles/summaries travel in payload rows,
//    never in tick logs.

import type { SqlExecutor } from "../actions/audit.js";
import { toAttentionItem } from "./service.js";
import {
  enqueueAttentionNotification,
  type NotificationRow,
} from "../notifications/service.js";
import type { NotificationsConfig } from "../notifications/config.js";
import { decideDelivery } from "./salience.js";
import {
  ATTENTION_DEFAULT_COOLDOWN_MINUTES,
  type AttentionItemRow,
  type AttentionLevel,
  type AttentionSafetyClass,
  type AttentionState,
} from "./types.js";

/** Retry loop cap (chunked passes; the next tick picks up the remainder). */
const RETRY_CAP = 500;

// Contract home for the enqueue seam is the delivery surface; the
// implementation lives beside the notifications queue (single write path)
// and is re-exported here so producers/liveness/tests have ONE import site.
export {
  enqueueAttentionNotification,
  type AttentionNotificationInput,
} from "../notifications/service.js";

/** Policy knobs for the attention delivery seam (policy.yaml `attention:`). */
export interface AttentionDeliveryConfig {
  /** Per-item re-delivery cooldown minutes; default = the types.ts constant. */
  readonly cooldownMinutes?: number;
  /** Notification policy override (tests); default = repo policy.yaml. */
  readonly notifications?: NotificationsConfig;
}

function resolveConfig(config?: AttentionDeliveryConfig): Required<Pick<AttentionDeliveryConfig, "cooldownMinutes">> & Pick<AttentionDeliveryConfig, "notifications"> {
  return {
    cooldownMinutes: config?.cooldownMinutes ?? ATTENTION_DEFAULT_COOLDOWN_MINUTES,
    notifications: config?.notifications,
  };
}

/**
 * Records one delivery ATTEMPT for the item (delivery_attempts++,
 * last_delivery_attempt_at). Projection stamp only — never touches the
 * item's state or updated_at (ADR-0018 §1.1: delivery never mutates the
 * item). Unknown item id is a no-op (fail-closed callers check their own
 * rows; this writer must not resurrect or verify identity).
 */
export async function markDeliveryAttempted(
  db: SqlExecutor,
  itemId: string,
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE attention_items
     SET delivery_attempts = delivery_attempts + 1, last_delivery_attempt_at = $2::timestamptz
     WHERE id = $1::uuid`,
    [itemId, now.toISOString()],
  );
}

/**
 * Stamps last_delivered_at — SUCCESS ONLY, called from the delivered-callback
 * route (integrator wire-up). Monotonic: a late/out-of-order report can never
 * move the stamp backward; re-reporting the same delivery is idempotent.
 */
export async function stampAttentionDelivered(
  db: SqlExecutor,
  itemId: string,
  now: Date,
): Promise<boolean> {
  const stamped = await db.query(
    `UPDATE attention_items
     SET last_delivered_at = $2::timestamptz
     WHERE id = $1::uuid AND (last_delivered_at IS NULL OR last_delivered_at < $2::timestamptz)
     RETURNING id`,
    [itemId, now.toISOString()],
  );
  return stamped.rows.length > 0;
}

/**
 * The ONE enqueue+attempt seam for attention delivery: persists the
 * kind='attention' notification (policy-driven approval inside) and, only
 * after that enqueue succeeds, records the attempt. Producers and the retry
 * loop both go through this so a queue row can never exist without its
 * attempt stamp.
 */
export async function notifyAttentionItem(

  db: SqlExecutor,
  item: AttentionItemRow,
  opts: { now: Date; config?: AttentionDeliveryConfig },
): Promise<NotificationRow> {
  const notification = await enqueueAttentionNotification(db, {
    item,
    now: opts.now,
    config: opts.config?.notifications,
  });
  await markDeliveryAttempted(db, item.id, opts.now);
  return notification;
}

/**
 * The liveness-driven retry (workflow `attention-liveness` step 3): enqueue
 * one delivery for every open/seen, non-snoozed, inbox|interrupt item that
 * has NEVER been delivered, has no in-flight notification row (pending or
 * approved and unexpired), and passes salience. Returns the count enqueued.
 */
export async function retryEligibleUndelivered(
  db: SqlExecutor,
  opts: { now: Date; config?: AttentionDeliveryConfig },
): Promise<number> {
  const { cooldownMinutes, notifications } = resolveConfig(opts.config);
  const nowIso = opts.now.toISOString();
  const due = await db.query(
    `SELECT id, state, level, safety_class, snoozed_until, last_delivered_at, change_fingerprint
     FROM attention_items
     WHERE state IN ('open', 'seen')
       AND (snoozed_until IS NULL OR snoozed_until <= $1::timestamptz)
       AND level IN ('inbox', 'interrupt')
       AND last_delivered_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.kind = 'attention' AND n.source_id = attention_items.id::text
           AND n.status IN ('pending', 'approved') AND n.expires_at > $1::timestamptz
       )
     ORDER BY first_raised_at ASC
     LIMIT $2`,
    [nowIso, RETRY_CAP],
  );
  let enqueued = 0;
  for (const row of due.rows as {
    id: string;
    state: string;
    level: string;
    safety_class: string;
    snoozed_until: string | Date | null;
    last_delivered_at: string | Date | null;
    change_fingerprint: string | null;
  }[]) {
    // Fresh re-read guard (reminder-sweep pattern): the row may have been
    // resolved/snoozed/delivered between the SELECT and this send.
    const fresh = await db.query(
      `SELECT id, principal_id, source_type, source_object_id, fingerprint, kind, state, level,
              safety_class, title, summary, why_it_matters, evidence_refs, actions, occurrences,
              change_fingerprint, first_raised_at, updated_at, seen_at, snoozed_until, snooze_count,
              resolved_at, resolved_by, resolution_reason, last_delivered_at, delivery_attempts,
              last_delivery_attempt_at
       FROM attention_items WHERE id = $1::uuid`,
      [row.id],
    );
    const item = fresh.rows.length > 0 ? toAttentionItem(fresh.rows[0] as never) : undefined;
    if (item === undefined) continue;
    if (item.state !== "open" && item.state !== "seen") continue;
    const decision = decideDelivery({
      level: item.level as AttentionLevel,
      safetyClass: item.safetyClass as AttentionSafetyClass,
      state: item.state as AttentionState,
      snoozedUntil: item.snoozedUntil === null ? null : new Date(item.snoozedUntil),
      lastDeliveredAt: item.lastDeliveredAt === null ? null : new Date(item.lastDeliveredAt),
      newChangeFingerprint: item.changeFingerprint,
      storedChangeFingerprint: null, // never delivered ⇒ nothing stored to compare (gate fails open)
      cooldownMinutes,
      now: opts.now,
    });
    if (!decision.deliver) continue;
    await notifyAttentionItem(db, item, { now: opts.now, config: { cooldownMinutes, notifications } });
    enqueued += 1;
  }
  return enqueued;
}
