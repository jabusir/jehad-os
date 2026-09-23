// Gmail message-content persistence (ADR-0016; roadmap §19 GC0).
//
// The Gmail sensor's observation depth extends from metadata-only to
// bounded message content: `gmail_messages` is a SOURCE record — evidence,
// never canonical truth (source_trust_class='untrusted_external'). Bodies
// never enter events / audit_log / model_calls / metrics / logs; those
// carry ids, hashes, and counts only.
//
// Ingestion is deterministic and model-free (ADR-0016 §4): persisting N
// messages costs zero model calls. Model interpretation happens only when
// an active outcome, watch condition, explicit query, or bounded brief
// policy needs it — and then through the egress registry like every other
// context source.
//
// Retention is the primary control (ADR-0016 §5): sweepGmailContentRetention
// deletes unpinned rows older than the policy window. pinned=true is the
// future outcome/verifier artifact-pinning seam (nothing pins yet — the
// window is the only retention until the outcome wave lands).

import { createHash, randomUUID } from "node:crypto";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";

/** One attachment's metadata — bytes are never fetched (ADR-0016 §3). */
export interface GmailAttachmentRecord {
  readonly filename: string;
  readonly mimeType: string | null;
  readonly size: number | null;
  readonly attachmentId: string | null;
}

/** The content side of a normalized message (pairs with gmail/sync.ts). */
export interface NormalizedGmailContent {
  readonly id: string;
  readonly threadId: string;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly subject: string | null;
  readonly snippet: string | null;
  readonly textPlain: string | null;
  /** ISO instant of the message's own date (the envelope's internalDate). */
  readonly internalDate: string | null;
  readonly attachments: readonly GmailAttachmentRecord[];
}

export interface GmailContentPolicy {
  /** `gmail.content` class gate (ADR-0016 §2.1) — default off. */
  readonly enabled: boolean;
  /** Retention window in days (owner default 14 — decision O-9). */
  readonly retentionDays: number;
  /** Hard byte cap on stored bodies (truncate, never reject). */
  readonly maxBodyBytes: number;
}

export const DEFAULT_GMAIL_CONTENT_POLICY: GmailContentPolicy = {
  enabled: false,
  retentionDays: 7,
  maxBodyBytes: 256 * 1024,
};

export type GmailContentPersistOutcome =
  | { readonly status: "stored" | "unchanged"; readonly id: string }
  | { readonly status: "empty" }
  | { readonly status: "failed"; readonly error: string };

// ------------------------------------------------------------------ persist

/**
 * Persists (or refreshes) the source record for one message. Idempotent:
 * identical content (same sha256) leaves the row untouched. A redelivery
 * with DIFFERENT normalized content refreshes the body fields (parse
 * improvements may close earlier gaps) — provenance columns are preserved.
 * Never throws into the sync lane: failures return `failed` so the
 * observation event (the actual sensor contract) stays untouched and the
 * content dim degrades honestly.
 */
export async function persistGmailContent(
  db: SqlExecutor,
  content: NormalizedGmailContent,
  opts: {
    readonly policy: GmailContentPolicy;
    readonly observedHistoryId: number | null;
    readonly principalId?: string;
    readonly domainId?: string;
    readonly now: Date;
    readonly actor: string;
  },
): Promise<GmailContentPersistOutcome> {
  if (!opts.policy.enabled) return { status: "empty" };
  try {
    const body =
      content.textPlain === null
        ? null
        : truncateToByteCap(content.textPlain, opts.policy.maxBodyBytes);
    if (body === null || body.length === 0) return { status: "empty" };
    const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
    const id = randomUUID();
    const principalId = opts.principalId ?? "josctl";
    const domainId = opts.domainId ?? "personal";
    const result = await db.query(
      `INSERT INTO gmail_messages (
         id, gmail_message_id, thread_id, observed_history_id,
         principal_id, domain_id,
         from_addr, to_addrs, subject, snippet,
         body_text, body_bytes, body_truncated, content_sha256, attachments,
         internal_date, source_trust_class, pinned, ingested_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8::jsonb, $9, $10,
         $11, $12, $13, $14, $15::jsonb,
         $16, 'untrusted_external', false, $17
       )
       ON CONFLICT (gmail_message_id) DO UPDATE SET
         body_text        = EXCLUDED.body_text,
         body_bytes       = EXCLUDED.body_bytes,
         body_truncated   = EXCLUDED.body_truncated,
         content_sha256   = EXCLUDED.content_sha256,
         snippet          = EXCLUDED.snippet,
         attachments      = EXCLUDED.attachments,
         subject          = EXCLUDED.subject,
         observed_history_id = EXCLUDED.observed_history_id,
         updated_at       = now()
       WHERE gmail_messages.content_sha256 IS DISTINCT FROM EXCLUDED.content_sha256
       RETURNING (xmax = 0) AS inserted, id`,
      [
        id,
        content.id,
        content.threadId,
        opts.observedHistoryId,
        principalId,
        domainId,
        content.from,
        JSON.stringify(content.to.slice(0, 20)),
        content.subject,
        content.snippet,
        body,
        Buffer.byteLength(body, "utf8"),
        Buffer.byteLength(content.textPlain ?? "", "utf8") > opts.policy.maxBodyBytes,
        sha256,
        JSON.stringify(content.attachments.slice(0, 10)),
        content.internalDate,
        opts.now.toISOString(),
      ],
    );
    const row = result.rows[0] as { inserted: boolean; id: string } | undefined;
    // No RETURNING row → the WHERE excluded the update → the sha matched →
    // the row is already current.
    if (row === undefined) return { status: "unchanged", id: "" };
    // A returned row is either a fresh insert or a content refresh — both
    // count as "stored" (the row now reflects this message's content).
    await recordAudit(db, {
      actor: opts.actor,
      action: "gmail.content.persisted",
      reversible: true,
      outputsRef: JSON.stringify({
        messageId: content.id,
        sha256,
        bytes: Buffer.byteLength(body, "utf8"),
        truncated: Buffer.byteLength(content.textPlain ?? "", "utf8") > opts.policy.maxBodyBytes,
        inserted: row.inserted,
      }),
    });
    return { status: "stored", id: row.id };
  } catch (err) {
    // ids/error-name only — never body text (T17 no-leak rule).
    return { status: "failed", error: err instanceof Error ? err.name : "UnknownError" };
  }
}

/** Byte-capped truncation that never splits a UTF-8 code point in half. */
function truncateToByteCap(text: string, cap: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cap) return text;
  const cut = bytes.subarray(0, cap);
  return new TextDecoder("utf-8", { fatal: false }).decode(cut);
}

// ------------------------------------------------------------------ retention

/**
 * Deletes unpinned rows past the retention window. Counts only — the audit
 * line carries no message ids (a deletion list is itself content metadata).
 */
export async function sweepGmailContentRetention(
  db: SqlExecutor,
  opts: { readonly retentionDays: number; readonly now: Date; readonly actor: string },
): Promise<number> {
  const result = await db.query(
    `DELETE FROM gmail_messages
     WHERE pinned = false
       AND ingested_at < $1
     RETURNING gmail_message_id`,
    [new Date(opts.now.getTime() - opts.retentionDays * 86_400_000).toISOString()],
  );
  const deleted = result.rows.length;
  if (deleted > 0) {
    await recordAudit(db, {
      actor: opts.actor,
      action: "gmail.content.swept",
      reversible: false,
      outputsRef: JSON.stringify({ deleted, retentionDays: opts.retentionDays }),
    });
  }
  return deleted;
}

// ------------------------------------------------------------------ reads

/** The read model — content plus its trust label, never authority. */
export interface GmailContentRecord {
  readonly gmailMessageId: string;
  readonly threadId: string;
  readonly fromAddr: string | null;
  readonly subject: string | null;
  readonly snippet: string | null;
  readonly bodyText: string | null;
  readonly bodyTruncated: boolean;
  readonly internalDate: string | null;
  readonly ingestedAt: string;
  readonly sourceTrustClass: string;
}

const RECORD_COLUMNS = `
  gmail_message_id, thread_id, from_addr, subject, snippet,
  body_text, body_truncated, internal_date, ingested_at, source_trust_class`;

type RecordRow = {
  gmail_message_id: string;
  thread_id: string;
  from_addr: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_truncated: boolean;
  internal_date: string | Date | null;
  ingested_at: string | Date;
  source_trust_class: string;
};

function toRecord(row: RecordRow): GmailContentRecord {
  return {
    gmailMessageId: row.gmail_message_id,
    threadId: row.thread_id,
    fromAddr: row.from_addr,
    subject: row.subject,
    snippet: row.snippet,
    bodyText: row.body_text,
    bodyTruncated: row.body_truncated,
    internalDate: isoOrNull(row.internal_date),
    ingestedAt: isoOrNull(row.ingested_at) ?? "",
    sourceTrustClass: row.source_trust_class,
  };
}

function isoOrNull(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function isoOrNow(value: string | Date): string {
  return isoOrNull(value) ?? new Date(0).toISOString();
}

/**
 * One message's content, principal-scoped. A foreign/unknown id returns
 * null — never another principal's row (directive §15; deny/empty, fail
 * closed).
 */
export async function getGmailMessageContent(
  db: SqlExecutor,
  principalId: string,
  gmailMessageId: string,
): Promise<GmailContentRecord | null> {
  const result = await db.query(
    `SELECT ${RECORD_COLUMNS} FROM gmail_messages
     WHERE principal_id = $1 AND gmail_message_id = $2
     LIMIT 1`,
    [principalId, gmailMessageId],
  );
  const row = result.rows[0] as RecordRow | undefined;
  return row === undefined ? null : toRecord(row);
}

/** A thread's content, principal-scoped, newest-first, bounded. */
export async function listGmailThreadContent(
  db: SqlExecutor,
  principalId: string,
  threadId: string,
  limit = 20,
): Promise<readonly GmailContentRecord[]> {
  const result = await db.query(
    `SELECT ${RECORD_COLUMNS} FROM gmail_messages
     WHERE principal_id = $1 AND thread_id = $2
     ORDER BY internal_date DESC NULLS LAST
     LIMIT $3`,
    [principalId, threadId, Math.min(Math.max(limit, 1), 100)],
  );
  return (result.rows as RecordRow[]).map(toRecord).sort((a, b) =>
    (a.internalDate ?? "").localeCompare(b.internalDate ?? ""),
  );
}

export interface GmailContentSearch {
  /** Lowercase substring match over From address (exact sender semantics
   *  stay an outcome-wave concern; v1 is a bounded chief-of-staff read). */
  readonly fromContains?: string;
  /** ISO instant lower bound over internal_date. */
  readonly since?: string;
  readonly limit?: number;
}

/** Bounded recent-content read, principal-scoped, oldest-first. */
export async function searchGmailContent(
  db: SqlExecutor,
  principalId: string,
  query: GmailContentSearch,
): Promise<readonly GmailContentRecord[]> {
  const conditions = ["principal_id = $1"];
  const params: unknown[] = [principalId];
  if (query.fromContains !== undefined && query.fromContains.length > 0) {
    params.push(`%${query.fromContains.toLowerCase()}%`);
    conditions.push(`from_addr LIKE $${params.length}`);
  }
  if (query.since !== undefined) {
    params.push(query.since);
    conditions.push(`internal_date >= $${params.length}::timestamptz`);
  }
  params.push(Math.min(Math.max(query.limit ?? 20, 1), 100));
  const result = await db.query(
    `SELECT ${RECORD_COLUMNS} FROM gmail_messages
     WHERE ${conditions.join(" AND ")}
     ORDER BY internal_date DESC NULLS LAST
     LIMIT $${params.length}`,
    params,
  );
  return (result.rows as RecordRow[])
    .map(toRecord)
    .sort((a, b) => isoOrNow(a.internalDate ?? a.ingestedAt).localeCompare(isoOrNow(b.internalDate ?? b.ingestedAt)));
}
