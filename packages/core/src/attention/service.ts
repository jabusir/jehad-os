// Attention service (product-reset plan §5; ADR-0018) — the durable truth
// for things waiting on the owner. Delivery is a best-effort projection
// owned by the notifications lane: a failed/expired push never mutates or
// resolves an item here (ADR-0018 §1.1).
//
// Rules baked in here:
//  - One open item per condition: the three-branch write (insert / bump /
//    reopen) is a SELECT..FOR UPDATE read-modify-write in ONE transaction;
//    duplicate source occurrences collapse into one row (§1.3).
//  - seen ≠ resolved; snooze is an explicit state (snoozed_until); reopen
//    preserves first_raised_at (contract invariant 2).
//  - Re-delivery on bump only when the producer-supplied change_fingerprint
//    differs or the level rises (§1.4); the salience ladder lives in
//    ./salience.ts and fails open.
//  - Items store {key, args} action refs only — no endpoint strings (§1.6).
//  - Every path is principal-scoped fail-closed: a foreign principal gets
//    null / 0 rows, indistinguishable from nonexistent (ADR-0013).
//  - W1 events are additive and content-free: attention.item.opened
//    (first insert only, ids/kind/level) and attention.item.resolved (any
//    close, resolvedBy + reason); bumps and reopens carry no event.
//  - 'seen' items remain listed as needing action: seen is an
//    acknowledgement, not a completion — only resolve/dismiss leave the
//    owner's action list (ADR-0018 §1.1).

import { randomUUID } from "node:crypto";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { LATEST_PAYLOAD_SCHEMA_VERSION } from "../events/catalog.js";
import { acceptEvent, type EventStoreExecutor } from "../events/store.js";
import { resolveLiveness } from "./resolvers.js";
import { decideDelivery } from "./salience.js";
import {
  ATTENTION_DEFAULT_COOLDOWN_MINUTES,
  ATTENTION_TERMINAL_RETENTION_DAYS,
  type AttentionItemRow,
  type AttentionLevel,
  type AttentionResolvedBy,
  type AttentionSourceType,
  type OpenAttentionInput,
  type OpenAttentionResult,
} from "./types.js";

/**
 * Structural slice of pg.Pool — connect() yields a transaction-capable
 * client. OPTIONAL: a bare transaction client (a caller already inside its
 * own transaction, e.g. transitionOutcome on a client) satisfies AttentionDb
 * too, and the write then rides the CALLER's transaction (strictly stronger
 * atomicity than the Pool path below). Production callers pass Pools; tests
 * and transactional callers pass clients.
 */
export interface AttentionDb extends EventStoreExecutor, SqlExecutor {
  connect?(): Promise<AttentionTx & { release(): void }>;
}

export interface AttentionTx extends EventStoreExecutor, SqlExecutor {}

async function withTransaction<T>(db: AttentionDb, fn: (tx: AttentionTx) => Promise<T>): Promise<T> {
  // Client path: the caller owns BEGIN/COMMIT — never open a second
  // connection (that would break same-transaction atomicity with the
  // caller's transition).
  if (typeof db.connect !== "function") return fn(db as AttentionTx);
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

function audit(db: SqlExecutor, action: string, outputs: Record<string, unknown>, actor: string): Promise<void> {
  // ids/refs/counts only — item text lives on the rows (outcomes precedent).
  return recordAudit(db, { actor, action, reversible: true, outputsRef: JSON.stringify(outputs) });
}

const ATTENTION_COLUMNS = `
  id, principal_id, source_type, source_object_id, fingerprint, kind, state,
  level, safety_class, title, summary, why_it_matters, evidence_refs,
  actions, occurrences, change_fingerprint, first_raised_at, updated_at,
  seen_at, snoozed_until, snooze_count, resolved_at, resolved_by,
  resolution_reason, last_delivered_at, delivery_attempts,
  last_delivery_attempt_at`;

interface AttentionSqlRow {
  id: string;
  principal_id: string;
  source_type: AttentionSourceType;
  source_object_id: string;
  fingerprint: string;
  kind: AttentionItemRow["kind"];
  state: AttentionItemRow["state"];
  level: AttentionLevel;
  safety_class: AttentionItemRow["safetyClass"];
  title: string;
  summary: string;
  why_it_matters: string | null;
  evidence_refs: unknown;
  actions: unknown;
  occurrences: number;
  change_fingerprint: string | null;
  first_raised_at: string | Date;
  updated_at: string | Date;
  seen_at: string | Date | null;
  snoozed_until: string | Date | null;
  snooze_count: number;
  resolved_at: string | Date | null;
  resolved_by: AttentionItemRow["resolvedBy"];
  resolution_reason: string | null;
  last_delivered_at: string | Date | null;
  delivery_attempts: number;
  last_delivery_attempt_at: string | Date | null;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: string | Date | null): Date | null {
  return value === null ? null : toDate(value);
}

function jsonbArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function toAttentionItem(row: AttentionSqlRow): AttentionItemRow {
  return {
    id: row.id,
    principalId: row.principal_id,
    sourceType: row.source_type,
    sourceObjectId: row.source_object_id,
    fingerprint: row.fingerprint,
    kind: row.kind,
    state: row.state,
    level: row.level,
    safetyClass: row.safety_class,
    title: row.title,
    summary: row.summary,
    whyItMatters: row.why_it_matters,
    evidenceRefs: jsonbArray(row.evidence_refs) as AttentionItemRow["evidenceRefs"],
    actions: jsonbArray(row.actions) as AttentionItemRow["actions"],
    occurrences: Number(row.occurrences),
    changeFingerprint: row.change_fingerprint,
    firstRaisedAt: toDate(row.first_raised_at),
    updatedAt: toDate(row.updated_at),
    seenAt: toNullableDate(row.seen_at),
    snoozedUntil: toNullableDate(row.snoozed_until),
    snoozeCount: Number(row.snooze_count),
    resolvedAt: toNullableDate(row.resolved_at),
    resolvedBy: row.resolved_by,
    resolutionReason: row.resolution_reason,
    lastDeliveredAt: toNullableDate(row.last_delivered_at),
    deliveryAttempts: Number(row.delivery_attempts),
    lastDeliveryAttemptAt: toNullableDate(row.last_delivery_attempt_at),
  };
}

// Bump applies to the live states; ONLY resolved/dismissed are "closed" and
// take the reopen branch (snooze/seen are owner states a producer never overrides).
const LIVE_STATES = `('open','seen','snoozed')`;

/** interrupt > inbox > digest — items only get more salient until owner action. */
const LEVEL_RANK: Record<AttentionLevel, number> = { digest: 1, inbox: 2, interrupt: 3 };
const LEVEL_BY_RANK: readonly AttentionLevel[] = ["digest", "inbox", "interrupt"];

async function emitResolvedEvent(
  db: SqlExecutor,
  item: AttentionItemRow,
  opts: { now: Date; by: AttentionResolvedBy; reason: string | null },
): Promise<void> {
  await acceptEvent(db, {
    type: "attention.item.resolved",
    schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
    source: "internal",
    externalId: `attention-resolved:${item.id}:${opts.now.toISOString()}`,
    occurredAt: opts.now.toISOString(),
    domainId: "personal",
    sensitivity: "normal",
    payload: {
      itemId: item.id,
      principalId: item.principalId,
      sourceType: item.sourceType,
      sourceObjectId: item.sourceObjectId,
      resolvedBy: opts.by,
      reason: opts.reason,
    },
    runId: null,
  }, { now: () => opts.now });
}

async function getItemRow(db: SqlExecutor, principalId: string, itemId: string): Promise<AttentionItemRow | null> {
  const result = await db.query(
    `SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE id = $1::uuid AND principal_id = $2::uuid LIMIT 1`,
    [itemId, principalId],
  );
  const row = result.rows[0] as unknown as AttentionSqlRow | undefined;
  return row === undefined ? null : toAttentionItem(row);
}

// ----------------------------------------------------------------- 3-branch write

/**
 * The only writer of new occurrences (ADR-0018 §1.3). One transaction:
 * lock the (principal, source_type, source_object_id, fingerprint) row,
 * then branch on pre-write state — no-row → INSERT + deliver;
 * open/seen/snoozed → bump (occurrences++, refresh text, re-run salience);
 * resolved/dismissed → reopen (first_raised_at preserved, deliver). The
 * reopen branch counts its occurrence too: a recurrence is an occurrence,
 * and occurrences is the collapse counter of §1.3.
 */
export async function openOrBumpOrReopen(
  db: AttentionDb,
  input: OpenAttentionInput,
  opts: { now: Date; actor: string },
): Promise<OpenAttentionResult> {
  return withTransaction(db, async (tx) => {
    const locked = await tx.query(
      `SELECT ${ATTENTION_COLUMNS} FROM attention_items
        WHERE principal_id = $1::uuid AND source_type = $2
          AND source_object_id = $3 AND fingerprint = $4
        FOR UPDATE`,
      [input.principalId, input.sourceType, input.sourceObjectId, input.fingerprint],
    );
    const prior = locked.rows[0] as unknown as AttentionSqlRow | undefined;

    if (prior === undefined) {
      const id = randomUUID();
      const inserted = await tx.query(
        `INSERT INTO attention_items (
           id, principal_id, source_type, source_object_id, fingerprint, kind,
           level, safety_class, title, summary, why_it_matters, evidence_refs,
           actions, change_fingerprint, first_raised_at, updated_at
         )
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12::jsonb, $13::jsonb, $14, $15::timestamptz, $15::timestamptz)
         RETURNING ${ATTENTION_COLUMNS}`,
        [
          id, input.principalId, input.sourceType, input.sourceObjectId, input.fingerprint,
          input.kind, input.level, input.safetyClass ?? "none", input.title, input.summary,
          input.whyItMatters ?? null, JSON.stringify(input.evidenceRefs ?? []),
          JSON.stringify(input.actions ?? []), input.changeFingerprint ?? null, opts.now.toISOString(),
        ],
      );
      const item = toAttentionItem(inserted.rows[0] as unknown as AttentionSqlRow);
      // Content-free payload contract: ids/kind/level only — never title/summary.
      await acceptEvent(tx, {
        type: "attention.item.opened",
        schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
        source: "internal",
        externalId: `attention-opened:${item.id}`,
        occurredAt: opts.now.toISOString(),
        domainId: "personal",
        sensitivity: "normal",
        payload: {
          itemId: item.id,
          principalId: item.principalId,
          sourceType: item.sourceType,
          sourceObjectId: item.sourceObjectId,
          fingerprint: item.fingerprint,
          kind: item.kind,
          level: item.level,
        },
        runId: null,
      }, { now: () => opts.now });
      await audit(tx, "attention.opened", { itemId: item.id, occurrences: 1, branch: "opened" }, opts.actor);
      return { action: "opened", item, deliverNow: true, deferReason: null };
    }

    const priorItem = toAttentionItem(prior);
    const newLevelRank = Math.max(LEVEL_RANK[input.level], LEVEL_RANK[priorItem.level]);
    const effectiveLevel = LEVEL_BY_RANK[newLevelRank - 1]!;

    if (priorItem.state === "resolved" || priorItem.state === "dismissed") {
      const reopened = await tx.query(
        `UPDATE attention_items SET
           state = 'open',
           occurrences = attention_items.occurrences + 1,
           level = $2,
           title = $3, summary = $4, why_it_matters = $5,
           change_fingerprint = $6,
           updated_at = $7::timestamptz,
           snoozed_until = NULL,
           resolved_at = NULL, resolved_by = NULL, resolution_reason = NULL
         WHERE id = $1::uuid
         RETURNING ${ATTENTION_COLUMNS}`,
        [
          priorItem.id, effectiveLevel, input.title, input.summary,
          input.whyItMatters ?? null, input.changeFingerprint ?? null, opts.now.toISOString(),
        ],
      );
      const item = toAttentionItem(reopened.rows[0] as unknown as AttentionSqlRow);
      await audit(tx, "attention.reopened", { itemId: item.id, occurrences: item.occurrences, priorState: priorItem.state }, opts.actor);
      // Contract: a closed condition recurring is news — reopen delivers.
      return { action: "reopened", item, deliverNow: true, deferReason: null };
    }

    // Bump. Level-rise re-delivery is compared here (the salience input
    // carries one level) and OR-ed with the ladder decision (§1.4).
    const levelRisen = LEVEL_RANK[input.level] > LEVEL_RANK[priorItem.level];
    const decision = decideDelivery({
      level: effectiveLevel,
      safetyClass: priorItem.safetyClass,
      state: priorItem.state,
      snoozedUntil: priorItem.snoozedUntil,
      lastDeliveredAt: priorItem.lastDeliveredAt,
      newChangeFingerprint: input.changeFingerprint ?? null,
      storedChangeFingerprint: priorItem.changeFingerprint,
      cooldownMinutes: ATTENTION_DEFAULT_COOLDOWN_MINUTES,
      now: opts.now,
    });
    const bumped = await tx.query(
      `UPDATE attention_items SET
         occurrences = attention_items.occurrences + 1,
         level = $2,
         title = $3, summary = $4, why_it_matters = $5,
         change_fingerprint = $6,
         updated_at = $7::timestamptz
       WHERE id = $1::uuid
       RETURNING ${ATTENTION_COLUMNS}`,
      [
        priorItem.id, effectiveLevel, input.title, input.summary,
        input.whyItMatters ?? null, input.changeFingerprint ?? null, opts.now.toISOString(),
      ],
    );
    const item = toAttentionItem(bumped.rows[0] as unknown as AttentionSqlRow);
    await audit(tx, "attention.bumped", { itemId: item.id, occurrences: item.occurrences, state: item.state, deliverNow: decision.deliver || levelRisen }, opts.actor);
    return {
      action: "bumped",
      item,
      deliverNow: decision.deliver || levelRisen,
      deferReason: decision.deliver || levelRisen ? null : decision.deferReason,
    };
  });
}

// ----------------------------------------------------------------- owner actions

/**
 * CAS close: open/seen → resolved, snoozed may be resolved too (contract).
 * An already-terminal item returns unchanged (an honest no-op — a retry is
 * not a denial); unknown/foreign item → null (fail-closed).
 */
export async function resolveAttention(
  db: AttentionDb,
  principalId: string,
  itemId: string,
  opts: { now: Date; actor: string; by: AttentionResolvedBy; reason?: string },
): Promise<AttentionItemRow | null> {
  const flipped = await db.query(
    `UPDATE attention_items SET
       state = 'resolved', resolved_at = $3::timestamptz, resolved_by = $4,
       resolution_reason = $5, updated_at = $3::timestamptz
     WHERE id = $1::uuid AND principal_id = $2::uuid AND state IN ${LIVE_STATES}
     RETURNING ${ATTENTION_COLUMNS}`,
    [itemId, principalId, opts.now.toISOString(), opts.by, opts.reason ?? null],
  );
  if (flipped.rows.length > 0) {
    const item = toAttentionItem(flipped.rows[0] as unknown as AttentionSqlRow);
    await emitResolvedEvent(db, item, { now: opts.now, by: opts.by, reason: opts.reason ?? null });
    await audit(db, "attention.resolved", { itemId: item.id, by: opts.by, reason: opts.reason ?? null }, opts.actor);
    return item;
  }
  return getItemRow(db, principalId, itemId);
}

/** Owner-dismisses: terminal, resolved_by 'owner', reason 'dismissed'. */
export async function dismissAttention(
  db: AttentionDb,
  principalId: string,
  itemId: string,
  opts: { now: Date; actor: string },
): Promise<AttentionItemRow | null> {
  const flipped = await db.query(
    `UPDATE attention_items SET
       state = 'dismissed', resolved_at = $3::timestamptz, resolved_by = 'owner',
       resolution_reason = 'dismissed', updated_at = $3::timestamptz
     WHERE id = $1::uuid AND principal_id = $2::uuid AND state IN ${LIVE_STATES}
     RETURNING ${ATTENTION_COLUMNS}`,
    [itemId, principalId, opts.now.toISOString()],
  );
  if (flipped.rows.length > 0) {
    const item = toAttentionItem(flipped.rows[0] as unknown as AttentionSqlRow);
    await emitResolvedEvent(db, item, { now: opts.now, by: "owner", reason: "dismissed" });
    await audit(db, "attention.dismissed", { itemId: item.id }, opts.actor);
    return item;
  }
  return getItemRow(db, principalId, itemId);
}

/** seen ≠ resolved: an acknowledgement that keeps the item on the action list. */
export async function markSeen(
  db: AttentionDb,
  principalId: string,
  itemId: string,
  opts: { now: Date; actor: string },
): Promise<AttentionItemRow | null> {
  const flipped = await db.query(
    `UPDATE attention_items SET
       state = 'seen', seen_at = $3::timestamptz, updated_at = $3::timestamptz
     WHERE id = $1::uuid AND principal_id = $2::uuid AND state = 'open'
     RETURNING ${ATTENTION_COLUMNS}`,
    [itemId, principalId, opts.now.toISOString()],
  );
  if (flipped.rows.length > 0) {
    const item = toAttentionItem(flipped.rows[0] as unknown as AttentionSqlRow);
    await audit(db, "attention.seen", { itemId: item.id }, opts.actor);
    return item;
  }
  return getItemRow(db, principalId, itemId);
}

/** Explicit snoozed state: snoozed_until = now + minutes, snooze_count++. */
export async function snoozeAttention(
  db: AttentionDb,
  principalId: string,
  itemId: string,
  minutes: number,
  opts: { now: Date; actor: string },
): Promise<AttentionItemRow | null> {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new TypeError("attention: snooze minutes must be a positive number");
  }
  const snoozedUntil = new Date(opts.now.getTime() + minutes * 60_000);
  const flipped = await db.query(
    `UPDATE attention_items SET
       state = 'snoozed', snoozed_until = $3::timestamptz,
       snooze_count = attention_items.snooze_count + 1, updated_at = $3::timestamptz
     WHERE id = $1::uuid AND principal_id = $2::uuid AND state IN ${LIVE_STATES}
     RETURNING ${ATTENTION_COLUMNS}`,
    [itemId, principalId, snoozedUntil.toISOString()],
  );
  if (flipped.rows.length > 0) {
    const item = toAttentionItem(flipped.rows[0] as unknown as AttentionSqlRow);
    await audit(db, "attention.snoozed", { itemId: item.id, minutes, snoozeCount: item.snoozeCount }, opts.actor);
    return item;
  }
  return getItemRow(db, principalId, itemId);
}

/**
 * Producer/backstop close by source identity (leaving waiting_user, watch
 * cancelled, liveness gone). Closes every live item of the source object —
 * W1 producers mint one fingerprint per object, so 0 or 1 rows in practice.
 */
export async function resolveAttentionBySource(
  db: AttentionDb,
  principalId: string,
  sourceType: AttentionSourceType,
  sourceObjectId: string,
  opts: { now: Date; actor: string; by: AttentionResolvedBy; reason: string;
          /** Narrow the close to one fingerprint (e.g. one held state of an outcome). */
          fingerprint?: string },
): Promise<number> {
  const flipped = await db.query(
    `UPDATE attention_items SET
       state = 'resolved', resolved_at = $4::timestamptz, resolved_by = $5,
       resolution_reason = $6, updated_at = $4::timestamptz
     WHERE principal_id = $1::uuid AND source_type = $2 AND source_object_id = $3
       AND ($7::text IS NULL OR fingerprint = $7::text)
       AND state IN ${LIVE_STATES}
     RETURNING ${ATTENTION_COLUMNS}`,
    [principalId, sourceType, sourceObjectId, opts.now.toISOString(), opts.by, opts.reason, opts.fingerprint ?? null],
  );
  for (const row of flipped.rows as unknown as AttentionSqlRow[]) {
    const item = toAttentionItem(row);
    await emitResolvedEvent(db, item, { now: opts.now, by: opts.by, reason: opts.reason });
  }
  if (flipped.rows.length > 0) {
    await audit(db, "attention.resolved_by_source", { sourceType, sourceObjectId, count: flipped.rows.length, by: opts.by, reason: opts.reason }, opts.actor);
  }
  return flipped.rows.length;
}

// ----------------------------------------------------------------- reads

/**
 * The owner's action list: open AND seen (seen still needs action — the
 * documented W1 choice), snoozed only when asked. Contract sort: safety
 * first, then level rank, then has-actions, then oldest raised.
 */
export async function listOpenAttention(
  db: AttentionDb,
  principalId: string,
  opts: { now: Date; includeSnoozed?: boolean; limit?: number },
): Promise<AttentionItemRow[]> {
  const states = opts.includeSnoozed === true ? `('open','seen','snoozed')` : `('open','seen')`;
  const limitSql = opts.limit === undefined ? "" : ` LIMIT ${Math.floor(opts.limit)}`;
  const result = await db.query(
    `SELECT ${ATTENTION_COLUMNS} FROM attention_items
      WHERE principal_id = $1::uuid AND state IN ${states}
      ORDER BY
        (safety_class <> 'none') DESC,
        CASE level WHEN 'interrupt' THEN 3 WHEN 'inbox' THEN 2 ELSE 1 END DESC,
        (jsonb_array_length(actions) > 0) DESC,
        first_raised_at ASC${limitSql}`,
    [principalId],
  );
  return (result.rows as unknown as AttentionSqlRow[]).map(toAttentionItem);
}

// ----------------------------------------------------------------- liveness sweep + GC

/**
 * The resolver backstop (ADR-0018 §4): open/seen items oldest-first under a
 * cap; a resolver 'gone' closes via resolveAttentionBySource(by 'liveness'),
 * 'unknown' never closes; then terminal rows past the retention window are
 * purged in bounded chunks. Open rows are never age-deleted.
 */
export async function livenessSweep(
  db: AttentionDb,
  opts: { now: Date; cap?: number },
): Promise<{ checked: number; resolved: number }> {
  const cap = opts.cap ?? 500;
  const stale = await db.query(
    `SELECT ${ATTENTION_COLUMNS} FROM attention_items
      WHERE state IN ('open','seen')
      ORDER BY first_raised_at ASC
      LIMIT $1`,
    [cap],
  );
  let resolved = 0;
  for (const row of stale.rows as unknown as AttentionSqlRow[]) {
    const item = toAttentionItem(row);
    const verdict = await resolveLiveness(db, item, opts.now);
    if (verdict !== "gone") continue;
    resolved += await resolveAttentionBySource(db, item.principalId, item.sourceType, item.sourceObjectId, {
      now: opts.now,
      actor: "system/attention-liveness",
      by: "liveness",
      reason: "liveness_gone",
    });
  }

  const cutoff = new Date(opts.now.getTime() - ATTENTION_TERMINAL_RETENTION_DAYS * 86_400_000);
  let gcDeleted = 0;
  for (;;) {
    const chunk = await db.query(
      `DELETE FROM attention_items
        WHERE id IN (
          SELECT id FROM attention_items
          WHERE state IN ('resolved','dismissed')
            AND resolved_at IS NOT NULL AND resolved_at < $1::timestamptz
          LIMIT 500
        )
        RETURNING id`,
      [cutoff.toISOString()],
    );
    gcDeleted += chunk.rows.length;
    if (chunk.rows.length < 500) break;
  }
  if (gcDeleted > 0) {
    await audit(db, "attention.gc", { deleted: gcDeleted, retentionDays: ATTENTION_TERMINAL_RETENTION_DAYS }, "system/attention-liveness");
  }
  return { checked: stale.rows.length, resolved };
}
