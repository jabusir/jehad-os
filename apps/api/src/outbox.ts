/**
 * Outbox dispatcher — at-least-once delivery of accepted events (plan §8;
 * plan §15 M2 acceptance: "replay of outbox is safe").
 *
 * Cycle: claim pending rows (SELECT ... FOR UPDATE SKIP LOCKED + attempts
 * bump in one statement — no leasing status exists in the v1 vocabulary
 * pending/dispatched/failed) → dispatch each envelope to the handler →
 * mark dispatched (status + dispatched_at + last_error cleared) or failed
 * (last_error, control-stripped and capped at 500 chars — never a payload
 * dump).
 *
 * At-least-once, not exactly-once: a crash between handler success and the
 * mark leaves the row pending and it is dispatched AGAIN on the next drain;
 * concurrent drains may also overlap. Handlers must therefore be idempotent
 * (plan §8) — semantic effects key on envelope.id, never on delivery count.
 * There is deliberately no "claimed" state to expire: re-claiming a pending
 * row is always safe.
 */

import type { SqlExecutor } from "@jehad/db";
import { getEventEnvelopesByIds, type EventEnvelope } from "@jehad/core";

/** Receives one envelope; resolving = success, rejecting = failed attempt. */
export type OutboxHandler = (envelope: EventEnvelope) => Promise<void>;

export interface DrainOptions {
  /** Max rows claimed per pass (default 100). */
  limit?: number;
}

export interface DrainResult {
  claimed: number;
  dispatched: number;
  failed: number;
}

const CLAIM_SQL = `
  WITH picked AS (
    SELECT id FROM outbox
    WHERE status = 'pending'
    ORDER BY created_at, id
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  ), bumped AS (
    UPDATE outbox o
    SET attempts = o.attempts + 1, updated_at = now()
    FROM picked p
    WHERE o.id = p.id
    RETURNING o.id, o.event_id, o.created_at
  )
  SELECT id, event_id, created_at FROM bumped ORDER BY created_at, id
`;

const MARK_DISPATCHED_SQL = `
  UPDATE outbox
  SET status = 'dispatched', dispatched_at = now(), last_error = NULL, updated_at = now()
  WHERE id = $1::uuid
`;

const MARK_FAILED_SQL = `
  UPDATE outbox
  SET status = 'failed', last_error = $2, updated_at = now()
  WHERE id = $1::uuid
`;

/** last_error is operator-facing diagnostics, not a payload dump (T4). */
const MAX_LAST_ERROR_LENGTH = 500;

/**
 * Sanitizes an error for the `last_error` column: strips control characters
 * (a raw err.message can embed payloads/secrets) and caps the length. Never
 * throws — a failure to record a failure must not lose the dispatch result.
 */
export function sanitizeOutboxError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  return stripped.length > MAX_LAST_ERROR_LENGTH
    ? stripped.slice(0, MAX_LAST_ERROR_LENGTH)
    : stripped;
}

export async function markOutboxDispatched(db: SqlExecutor, outboxId: string): Promise<void> {
  await db.query(MARK_DISPATCHED_SQL, [outboxId]);
}

export async function markOutboxFailed(
  db: SqlExecutor,
  outboxId: string,
  error: string,
): Promise<void> {
  await db.query(MARK_FAILED_SQL, [outboxId, sanitizeOutboxError(error)]);
}

/**
 * Drains up to `limit` pending outbox rows. Never throws for a handler
 * failure (recorded as status='failed' + last_error); only infrastructure
 * errors (db) propagate.
 */
export async function drainOutbox(
  db: SqlExecutor,
  handler: OutboxHandler,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const limit = opts.limit ?? 100;
  const claimed = await db.query(CLAIM_SQL, [limit]);
  const rows = claimed.rows.map((row) => ({
    outboxId: String(row.id),
    eventId: String(row.event_id),
  }));
  if (rows.length === 0) {
    return { claimed: 0, dispatched: 0, failed: 0 };
  }

  const envelopes = await getEventEnvelopesByIds(db, rows.map((row) => row.eventId));
  let dispatched = 0;
  let failed = 0;

  for (const { outboxId, eventId } of rows) {
    const envelope = envelopes.get(eventId);
    if (envelope === undefined) {
      await markOutboxFailed(db, outboxId, "event row missing for outbox entry");
      failed += 1;
      continue;
    }
    try {
      await handler(envelope);
      await markOutboxDispatched(db, outboxId);
      dispatched += 1;
    } catch (err) {
      await markOutboxFailed(db, outboxId, err instanceof Error ? err.message : String(err));
      failed += 1;
    }
  }
  return { claimed: rows.length, dispatched, failed };
}
