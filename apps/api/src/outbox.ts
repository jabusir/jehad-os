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
 * Retry (state-verifier defect S2): failed rows are no longer terminal.
 * `requeueFailed` flips failed→pending once a row's backoff window has
 * elapsed; exhausted rows (attempts >= policy.maxAttempts) stay failed
 * permanently and surface via `exhaustedOutboxRows` for alerting.
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

/**
 * Retry policy for failed outbox rows (S2). Backoff before a row with
 * `attempts` failures becomes requeue-eligible is
 * min(backoffCapMs, backoffBaseMs * 2^(attempts - 1)).
 */
export interface OutboxRetryPolicy {
  /** Max claim attempts before a failed row is permanently failed. */
  maxAttempts: number;
  /** Backoff for the first failure (ms). */
  backoffBaseMs: number;
  /** Upper bound on any single backoff window (ms). */
  backoffCapMs: number;
}

/** Defaults: 5 attempts, 30s → 60s → 120s → 240s (cap 15min never binds). */
export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = {
  maxAttempts: 5,
  backoffBaseMs: 30_000,
  backoffCapMs: 15 * 60_000,
};

/** Backoff window (ms) a row must sit failed for before requeue. */
export function outboxBackoffMs(
  attempts: number,
  policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY,
): number {
  const exponent = Math.max(attempts - 1, 0);
  return Math.min(policy.backoffCapMs, policy.backoffBaseMs * 2 ** exponent);
}

export interface RequeueOptions {
  policy?: OutboxRetryPolicy;
  /** Injectable clock (tests); defaults to now. */
  now?: Date;
}

export interface RequeueResult {
  requeued: number;
}

export interface DrainOptions {
  /** Max rows claimed per pass (default 100). */
  limit?: number;
  /** Requeue backoff-eligible failed rows before claiming. */
  requeue?: boolean;
  retryPolicy?: OutboxRetryPolicy;
  now?: Date;
}

export interface DrainResult {
  requeued: number;
  claimed: number;
  dispatched: number;
  failed: number;
}

export interface ExhaustedOutboxRow {
  id: string;
  eventId: string;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}

export interface ExhaustedOptions {
  policy?: OutboxRetryPolicy;
  /** Max rows returned (default 100). */
  limit?: number;
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

/**
 * Failed→pending for backoff-eligible rows, in one atomic statement.
 * Eligible: status='failed' AND attempts < maxAttempts AND
 * updated_at <= now - min(cap, base * 2^(attempts-1)). last_error is
 * deliberately retained (forensics); success clears it (existing behavior).
 */
const REQUEUE_SQL = `
  UPDATE outbox
  SET status = 'pending', updated_at = $4::timestamptz
  WHERE status = 'failed'
    AND attempts < $1::int
    AND updated_at <= $4::timestamptz
        - LEAST($3::double precision, $2::double precision * 2 ^ (attempts - 1))
          * interval '1 millisecond'
  RETURNING id
`;

/** Permanently failed rows (attempts exhausted) for alerting. Oldest first. */
const EXHAUSTED_SQL = `
  SELECT id, event_id, attempts, last_error, updated_at
  FROM outbox
  WHERE status = 'failed' AND attempts >= $1::int
  ORDER BY updated_at, id
  LIMIT $2::int
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
 * Requeues failed rows whose backoff window has elapsed (failed→pending).
 * Never requeues exhausted rows (attempts >= policy.maxAttempts).
 */
export async function requeueFailed(
  db: SqlExecutor,
  opts: RequeueOptions = {},
): Promise<RequeueResult> {
  const policy = opts.policy ?? DEFAULT_OUTBOX_RETRY_POLICY;
  const now = opts.now ?? new Date();
  const result = await db.query(REQUEUE_SQL, [
    policy.maxAttempts,
    policy.backoffBaseMs,
    policy.backoffCapMs,
    now.toISOString(),
  ]);
  return { requeued: result.rows.length };
}

/**
 * Permanently failed rows (attempts >= policy.maxAttempts) — they stay
 * failed forever; this surfaces them for alerting.
 */
export async function exhaustedOutboxRows(
  db: SqlExecutor,
  opts: ExhaustedOptions = {},
): Promise<ExhaustedOutboxRow[]> {
  const policy = opts.policy ?? DEFAULT_OUTBOX_RETRY_POLICY;
  const limit = opts.limit ?? 100;
  const result = await db.query(EXHAUSTED_SQL, [policy.maxAttempts, limit]);
  return result.rows.map((row) => ({
    id: String(row.id),
    eventId: String(row.event_id),
    attempts: Number(row.attempts),
    lastError: row.last_error === null ? null : String(row.last_error),
    updatedAt: new Date(row.updated_at as string | Date),
  }));
}

/**
 * Drains up to `limit` pending outbox rows. Never throws for a handler
 * failure (recorded as status='failed' + last_error); only infrastructure
 * errors (db) propagate. With `requeue: true`, backoff-eligible failed
 * rows are flipped to pending first, then the pass claims everything
 * pending — one combined "process" call.
 */
export async function drainOutbox(
  db: SqlExecutor,
  handler: OutboxHandler,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  let requeued = 0;
  if (opts.requeue === true) {
    ({ requeued } = await requeueFailed(db, { policy: opts.retryPolicy, now: opts.now }));
  }

  const limit = opts.limit ?? 100;
  const claimed = await db.query(CLAIM_SQL, [limit]);
  const rows = claimed.rows.map((row) => ({
    outboxId: String(row.id),
    eventId: String(row.event_id),
  }));
  if (rows.length === 0) {
    return { requeued, claimed: 0, dispatched: 0, failed: 0 };
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
  return { requeued, claimed: rows.length, dispatched, failed };
}
