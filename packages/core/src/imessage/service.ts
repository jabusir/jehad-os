// iMessage shadow-sensor ingest service (gateway Phase A, Lane B —
// docs/plans/imessage-gateway.md §7 row A; docs/plans/ig-phase-a-contracts.md).
//
// The sensor (apps/imessage-sensor, Lane D) polls chat.db read-only and
// reports transport METADATA to the control plane; this service is the only
// writer of the shadow tables. PRIVACY RULE: third-party message CONTENT
// never enters the control plane — metadata, lengths, hashes, decoder
// status only. The decoded-text hash is stored ONLY for is_from_me rows
// (loop correlation); a hash arriving on a third-party row is nulled
// before storage (defense in depth behind the schema CHECK).
//
// Idempotency: the sensor is at-least-once; guid is the idempotency key
// (ON CONFLICT DO NOTHING + duplicate counting) so redelivered batches are
// exactly-once. The cursor upsert rides the same transaction as the batch:
// a crash mid-batch leaves cursor and events consistent.
//
// Loop correlation (§5.2 SECONDARY guard): an is_from_me row whose
// normalized_text_sha256 matches a sent_message_fingerprints row whose
// delivered_at sits inside the 10 minutes BEFORE observed_at is correlated
// (fingerprint_id set + fingerprint.imessage_guid backfilled). Recipient
// matching joins later (Phase B pairing); hash + window only for now.
// When MULTIPLE fingerprints match, the NEWEST delivered_at wins (the
// delivery closest to the observation is the most likely cause); exact
// delivered_at ties break on id so the order is TOTAL and the pick is
// deterministic across repeated correlations (see FIND_FINGERPRINT_SQL).

import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { attemptPairingInTx, canonicalizeHandle, principalForHandle } from "./pairing.js";
import type { InboundConversationMessage } from "./conversation.js";

/** Structural slice of pg.Pool — connect() yields a transaction client. */
export interface ImessageDb {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<ImessageTx & { release(): void }>;
}

export interface ImessageTx {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const IMESSAGE_DECODED_STATUSES = [
  "ok", "skipped-malformed", "skipped-unknown", "not-attempted", "own-ok",
] as const;
export type ImessageDecodedStatus = (typeof IMESSAGE_DECODED_STATUSES)[number];

export type ImessageHealthDim = "healthy" | "degraded" | "failed";

export const IMESSAGE_HEALTH_DIMS = [
  "health_process", "health_database", "health_decoder", "health_cursor", "health_shadow",
] as const;

/** delivered_at must sit within this window BEFORE observed_at to correlate. */
export const IMESSAGE_FINGERPRINT_WINDOW_MS = 10 * 60_000;

export const MAX_IMESSAGE_INGEST_BATCH = 1000;

export class ImessageInputError extends Error {
  readonly code = "IMESSAGE_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ImessageInputError";
  }
}

/** One transport observation — the contract wire shape (snake_case). */
export interface ImessageTransportEventInput {
  readonly guid: string;
  readonly rowid: number;
  readonly is_from_me: boolean;
  readonly transport_handle: string;
  readonly service?: string | null;
  readonly has_text?: boolean | null;
  readonly has_attributed_body?: boolean | null;
  readonly decoded_status: ImessageDecodedStatus;
  readonly text_length?: number | null;
  /** Present ONLY for is_from_me rows (privacy rule; nulled otherwise). */
  readonly normalized_text_sha256?: string | null;
  readonly observed_at: string;
  /**
   * Decoded text — present ONLY on rows whose handle is paired (multi-
   * principal Lane P). TRANSIENT: routed to the conversation handler in
   * memory and NEVER persisted — no content column exists anywhere.
   * Mutually exclusive with pairing_attempt_hash.
   */
  readonly content?: string | null;
  /**
   * sha256(canonicalNormalize(content)) on an UNPAIRED handle — the §5.1.1
   * pre-auth pairing probe, EXACT hash match only (no parsing, no LLM).
   */
  readonly pairing_attempt_hash?: string | null;
}

export interface ImessageCursorInput {
  readonly rowid: number;
  readonly db_generation?: string | null;
  readonly schema_fingerprint?: string | null;
}

export interface ImessageFingerprintMatch {
  readonly guid: string;
  readonly fingerprint_id: string;
}

export interface ImessageIngestReport {
  readonly accepted: number;
  readonly duplicates: number;
  readonly fingerprint_matches: readonly ImessageFingerprintMatch[];
  /** Adversary 8c: rows rejected at validation but quarantined (never
   *  fatal to the batch); the sensor's cursor still advances. */
  readonly quarantined: readonly { guid: string; reason: string }[];
}

export interface ImessageHealthInput {
  readonly health_process: ImessageHealthDim;
  readonly health_database: ImessageHealthDim;
  readonly health_decoder: ImessageHealthDim;
  readonly health_cursor: ImessageHealthDim;
  readonly health_shadow: ImessageHealthDim;
  /** Free-form context for the audit trail ONLY (never stored in state). */
  readonly details?: Record<string, unknown> | null;
}

export interface ImessageServiceOptions {
  readonly actor?: string;
  readonly now?: () => Date;
  /**
   * Harness capability grant that authorized the call — recorded on the
   * health audit entry (additive, default null; mirrors the ingest route's
   * grant attribution). Only recordHealth reads it today.
   */
  readonly grantId?: string | null;
  /**
   * Conversation sink for paired-handle inbound (multi-principal Lane P):
   * invoked AFTER the ingest transaction commits, once per message that
   * passed routing (paired handle + unexpired imessage:converse grant).
   * Content is transient — it never touches any table; handler failures
   * are audited, never thrown through ingest.
   */
  readonly onInbound?: (message: InboundConversationMessage) => Promise<void>;
}

/** Upper bound on transient inbound content (the sensor's decode cap). */
export const MAX_IMESSAGE_INBOUND_CONTENT = 4000;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function isDecodedStatus(value: unknown): value is ImessageDecodedStatus {
  return (
    typeof value === "string" &&
    (IMESSAGE_DECODED_STATUSES as readonly string[]).includes(value)
  );
}

function isHealthDim(value: unknown): value is ImessageHealthDim {
  return value === "healthy" || value === "degraded" || value === "failed";
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== "string") throw new ImessageInputError(`${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ImessageInputError(`${field} must be a parseable ISO timestamp`);
  }
  return parsed;
}

interface ValidatedTransportEvent {
  readonly guid: string;
  readonly rowid: number;
  readonly is_from_me: boolean;
  readonly transport_handle: string;
  readonly service: string | null;
  readonly has_text: boolean | null;
  readonly has_attributed_body: boolean | null;
  readonly decoded_status: ImessageDecodedStatus;
  readonly text_length: number | null;
  readonly normalized_text_sha256: string | null;
  readonly observed_at: Date;
  /** Transient paired-handle content; NEVER persisted (own rows: dropped). */
  readonly content: string | null;
  /** §5.1.1 pairing probe hash; stored on the metadata row for audit. */
  readonly pairingAttemptHash: string | null;
}

function validateTransportEvent(
  input: ImessageTransportEventInput,
): ValidatedTransportEvent {
  if (!isBoundedString(input.guid, 255)) {
    throw new ImessageInputError("guid must be a non-empty string of at most 255 chars");
  }
  if (!isSafeInteger(input.rowid)) {
    throw new ImessageInputError("rowid must be a safe integer");
  }
  if (typeof input.is_from_me !== "boolean") {
    throw new ImessageInputError("is_from_me must be a boolean");
  }
  if (!isBoundedString(input.transport_handle, 255)) {
    throw new ImessageInputError("transport_handle must be a non-empty string of at most 255 chars");
  }
  if (input.service !== undefined && input.service !== null && !isBoundedString(input.service, 64)) {
    throw new ImessageInputError("service must be null or a string of at most 64 chars");
  }
  for (const flag of ["has_text", "has_attributed_body"] as const) {
    const value = input[flag];
    if (value !== undefined && value !== null && typeof value !== "boolean") {
      throw new ImessageInputError(`${flag} must be null or a boolean`);
    }
  }
  if (!isDecodedStatus(input.decoded_status)) {
    throw new ImessageInputError(
      `decoded_status must be one of ${IMESSAGE_DECODED_STATUSES.join("|")}`,
    );
  }
  if (input.text_length !== undefined && input.text_length !== null) {
    if (!isSafeInteger(input.text_length) || input.text_length < 0) {
      throw new ImessageInputError("text_length must be null or a non-negative integer");
    }
  }
  let normalizedTextSha256: string | null = null;
  if (input.normalized_text_sha256 !== undefined && input.normalized_text_sha256 !== null) {
    const hash = String(input.normalized_text_sha256).toLowerCase();
    if (!SHA256_HEX_RE.test(hash)) {
      throw new ImessageInputError("normalized_text_sha256 must be a sha256 hex string");
    }
    // PRIVACY RULE: the decoded-text hash is stored ONLY for is_from_me
    // rows; a hash on a third-party row is dropped, never stored.
    normalizedTextSha256 = input.is_from_me ? hash : null;
  }
  const hasContent = input.content !== undefined && input.content !== null;
  const hasAttempt = input.pairing_attempt_hash !== undefined && input.pairing_attempt_hash !== null;
  if (hasContent && hasAttempt) {
    // Sensor contract: content rides PAIRED rows, the pairing probe rides
    // UNPAIRED rows — both at once is malformed; fail closed.
    throw new ImessageInputError("content and pairing_attempt_hash are mutually exclusive");
  }
  let content: string | null = null;
  if (hasContent) {
    if (typeof input.content !== "string" || input.content.length > MAX_IMESSAGE_INBOUND_CONTENT) {
      throw new ImessageInputError(
        `content must be a string of at most ${MAX_IMESSAGE_INBOUND_CONTENT} chars`,
      );
    }
    content = input.content;
  }
  let pairingAttemptHash: string | null = null;
  if (hasAttempt) {
    const hash = String(input.pairing_attempt_hash).toLowerCase();
    if (!SHA256_HEX_RE.test(hash)) {
      throw new ImessageInputError("pairing_attempt_hash must be a sha256 hex string");
    }
    pairingAttemptHash = hash;
  }
  return {
    guid: input.guid,
    rowid: input.rowid,
    is_from_me: input.is_from_me,
    transport_handle: input.transport_handle,
    service: input.service ?? null,
    has_text: input.has_text ?? null,
    has_attributed_body: input.has_attributed_body ?? null,
    decoded_status: input.decoded_status,
    text_length: input.text_length ?? null,
    normalized_text_sha256: normalizedTextSha256,
    observed_at: parseInstant(input.observed_at, "observed_at"),
    // Own rows ride the unchanged Phase-A path; transient fields are dead
    // weight there — dropped at the door.
    content: input.is_from_me ? null : content,
    pairingAttemptHash: input.is_from_me ? null : pairingAttemptHash,
  };
}

function validateCursor(cursor: ImessageCursorInput): void {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new ImessageInputError("cursor must be an object");
  }
  if (!isSafeInteger(cursor.rowid) || cursor.rowid < 0) {
    throw new ImessageInputError("cursor.rowid must be a non-negative safe integer");
  }
  for (const field of ["db_generation", "schema_fingerprint"] as const) {
    const value = cursor[field];
    if (value !== undefined && value !== null && !isBoundedString(value, 255)) {
      throw new ImessageInputError(`cursor.${field} must be null or a string of at most 255 chars`);
    }
  }
}

const INSERT_EVENT_SQL = `
  INSERT INTO imessage_transport_events
    (guid, rowid, is_from_me, transport_handle, service, has_text, has_attributed_body,
     decoded_status, text_length, normalized_text_sha256, observed_at, pairing_attempt_hash)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12)
  ON CONFLICT (guid) DO NOTHING
  RETURNING id
`;

const SELECT_EVENT_ID_SQL = `
  SELECT id, fingerprint_id FROM imessage_transport_events WHERE guid = $1
`;

const FIND_FINGERPRINT_SQL = `
  SELECT id FROM sent_message_fingerprints
  WHERE rendered_text_sha256 = $1
    AND delivered_at <= $2::timestamptz
    AND delivered_at >= $3::timestamptz
  -- SELECTION RULE (pinned): newest delivered_at in the window wins;
  -- exact delivered_at ties break on id so the order is TOTAL — repeated
  -- correlations of the same hash always pick the same row, regardless
  -- of plan/vacuum timing.
  ORDER BY delivered_at DESC, id DESC
  LIMIT 1
`;

const CURSOR_UPSERT_SQL = `
  INSERT INTO imessage_sensor_state
    (singleton, cursor_rowid, db_generation, schema_fingerprint, updated_at)
  VALUES (true, $1, $2, $3, $4::timestamptz)
  ON CONFLICT (singleton) DO UPDATE SET
    cursor_rowid      = EXCLUDED.cursor_rowid,
    db_generation     = EXCLUDED.db_generation,
    schema_fingerprint = EXCLUDED.schema_fingerprint,
    updated_at        = EXCLUDED.updated_at
`;

const CONVERSE_GRANT_SQL = `
  SELECT 1 FROM capability_grants
   WHERE principal_id = $1::uuid AND capability = 'imessage:converse' AND resource = 'imessage'
     AND revoked_at IS NULL AND expires_at > $2::timestamptz
   LIMIT 1
`;

/**
 * Ingests one sensor batch + cursor in a single transaction.
 * Dedupe on guid (at-least-once → exactly-once); duplicates counted.
 * Own-message rows (normalized_text_sha256 set) are correlated against
 * sent_message_fingerprints on hash + the 10-minute delivery→observation
 * window; matches set fingerprint_id, backfill the fingerprint's
 * imessage_guid (first correlation wins), and ride the report.
 *
 * Multi-principal routing (Lane P) per NON-own row, inside the same tx:
 *   paired handle + content   → converse-grant check; granted messages are
 *                                queued for the conversation handler (run
 *                                AFTER commit — content stays transient);
 *                                ungranted content is dropped + audited.
 *   unpaired + content        → DISCARD + audit violation (server-side
 *                                enforcement regardless of the sensor).
 *   unpaired + pairing hash   → attemptPairingInTx (§5.1.1 EXACT match
 *                                only — no parsing, no LLM).
 *   unpaired, neither         → drop + audit metadata row.
 */
export async function ingestBatch(
  db: ImessageDb,
  batch: readonly ImessageTransportEventInput[],
  cursor: ImessageCursorInput,
  opts: ImessageServiceOptions = {},
): Promise<ImessageIngestReport> {
  if (!Array.isArray(batch)) {
    throw new ImessageInputError("batch must be an array of transport events");
  }
  if (batch.length > MAX_IMESSAGE_INGEST_BATCH) {
    throw new ImessageInputError(`batch exceeds the ${MAX_IMESSAGE_INGEST_BATCH}-row limit`);
  }
  validateCursor(cursor);
  // Adversary 8c (hardening): per-row validation with QUARANTINE — one
  // bad row (e.g. oversized content from a paired handle) is audited and
  // skipped while the rest of the batch proceeds and the sensor's cursor
  // still advances. Batch-wide throw froze the cursor forever: a single
  // 5000-char text killed the entire ingest pipeline (conversations,
  // pairing, correlation) with no self-healing.
  const valid: ValidatedTransportEvent[] = [];
  const quarantined: { guid: string; reason: string }[] = [];
  for (const row of batch) {
    try {
      valid.push(validateTransportEvent(row));
    } catch (err) {
      quarantined.push({
        guid: typeof row?.guid === "string" ? row.guid.slice(0, 64) : "(unset)",
        reason: err instanceof ImessageInputError ? err.message.slice(0, 120) : "invalid row",
      });
    }
  }
  const rows = valid;
  const now = (opts.now?.() ?? new Date()).toISOString();
  const actor = opts.actor ?? "harness:imessage-sensor";

  const client = await db.connect();
  let accepted = 0;
  const matches: ImessageFingerprintMatch[] = [];
  const inbound: InboundConversationMessage[] = [];
  const routeAudit = (action: string, outputs: Record<string, unknown>): Promise<void> =>
    recordAudit(client, {
      actor,
      action,
      reversible: true,
      outputsRef: JSON.stringify(outputs),
    });
  try {
    await client.query("BEGIN");
    // Quarantined rows are audited inside the tx (atomic with the cursor
    // advance) so a poison row can never wedge the pipeline (8c).
    for (const q of quarantined) {
      await routeAudit("imessage.ingest.quarantined", q);
    }
    for (const row of rows) {
      const canonicalHandle = canonicalizeHandle(row.transport_handle);
      const inserted = await client.query(INSERT_EVENT_SQL, [
        row.guid,
        row.rowid,
        row.is_from_me,
        row.transport_handle,
        row.service,
        row.has_text,
        row.has_attributed_body,
        row.decoded_status,
        row.text_length,
        row.normalized_text_sha256,
        row.observed_at.toISOString(),
        row.pairingAttemptHash,
      ]);
      const eventId =
        inserted.rows[0] !== undefined
          ? String(inserted.rows[0].id)
          : null;
      if (eventId !== null) accepted += 1;
      if (eventId !== null && !row.is_from_me) {
        // Routing runs only on FIRST acceptance (redelivered guids are
        // duplicates — a conversation turn must never dispatch twice, and
        // a consumed pairing code must not be re-attempted).
        await routeRow(client, row, canonicalHandle, now, routeAudit, inbound);
      }
      if (row.normalized_text_sha256 === null) continue;

      // Correlate on hash + window — accepted rows (fingerprint_id NULL by
      // construction) and redelivered rows alike (only when still
      // uncorrelated; recipient matching joins with Phase B pairing).
      const existing =
        eventId !== null
          ? { id: eventId, fingerprint_id: null as string | null }
          : await client.query(SELECT_EVENT_ID_SQL, [row.guid]).then((r) =>
              r.rows[0] === undefined
                ? null
                : {
                    id: String(r.rows[0].id),
                    fingerprint_id:
                      r.rows[0].fingerprint_id === null || r.rows[0].fingerprint_id === undefined
                        ? null
                        : String(r.rows[0].fingerprint_id),
                  },
            );
      if (existing === null || existing.fingerprint_id !== null) continue;

      const windowStart = new Date(row.observed_at.getTime() - IMESSAGE_FINGERPRINT_WINDOW_MS);
      const fingerprint = await client.query(FIND_FINGERPRINT_SQL, [
        row.normalized_text_sha256,
        row.observed_at.toISOString(),
        windowStart.toISOString(),
      ]);
      const fingerprintId = fingerprint.rows[0]?.id;
      if (fingerprintId === undefined) continue;

      await client.query(
        "UPDATE imessage_transport_events SET fingerprint_id = $2::uuid WHERE id = $1::uuid",
        [existing.id, String(fingerprintId)],
      );
      await client.query(
        "UPDATE sent_message_fingerprints SET imessage_guid = $2 WHERE id = $1::uuid AND imessage_guid IS NULL",
        [String(fingerprintId), row.guid],
      );
      matches.push({ guid: row.guid, fingerprint_id: String(fingerprintId) });
    }

    await client.query(CURSOR_UPSERT_SQL, [
      cursor.rowid,
      cursor.db_generation ?? null,
      cursor.schema_fingerprint ?? null,
      now,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Transient conversation dispatch — strictly AFTER commit: content lives
  // in memory only, and a handler failure can never roll ingest back.
  if (opts.onInbound !== undefined) {
    for (const message of inbound) {
      try {
        await opts.onInbound(message);
      } catch (err) {
        await recordAudit(db, {
          actor: "system:imessage-gateway",
          action: "imessage.inbound.handler_error",
          reversible: true,
          outputsRef: JSON.stringify({
            principalId: message.principalId,
            handle: message.handle,
            error: err instanceof Error ? err.name : "unknown",
          }),
        });
      }
    }
  }
  return {
    accepted,
    duplicates: rows.length - accepted,
    fingerprint_matches: matches,
    quarantined,
  };
}

/**
 * The non-own-row routing ladder (runs INSIDE the ingest transaction, so
 * pairing consumption and violation audits are atomic with the metadata
 * row). Queues granted conversation messages for post-commit dispatch.
 */
async function routeRow(
  client: ImessageTx,
  row: { readonly guid: string; readonly content: string | null; readonly pairingAttemptHash: string | null },
  canonicalHandle: string,
  nowIso: string,
  audit: (action: string, outputs: Record<string, unknown>) => Promise<void>,
  inbound: InboundConversationMessage[],
): Promise<void> {
  const principal = await principalForHandle(client, canonicalHandle);
  if (principal !== null) {
    if (row.content === null || row.content.length === 0) {
      return; // paired handle, no content: metadata only
    }
    const grant = await client.query(CONVERSE_GRANT_SQL, [principal.principalId, nowIso]);
    if (grant.rows[0] === undefined) {
      await audit("imessage.inbound.dropped", {
        reason: "no-converse-grant",
        handle: canonicalHandle,
        principalId: principal.principalId,
      });
      return;
    }
    await audit("imessage.inbound.routed", {
      handle: canonicalHandle,
      principalId: principal.principalId,
    });
    // Phase F: the events-row id for this guid rides the message so
    // capture provenance and replay idempotency bind to the exact event.
    const sourceEventId = await client
      .query(SELECT_EVENT_ID_SQL, [row.guid])
      .then((r) => (r.rows[0]?.id === undefined ? null : String(r.rows[0].id)))
      .catch(() => null);
    inbound.push({
      principalId: principal.principalId,
      handle: canonicalHandle,
      text: row.content,
      sourceEventId,
    });
    return;
  }

  // Unpaired handle. Content here is a PRIVACY VIOLATION (the sensor may
  // only send content for paired handles) — discarded, never forwarded.
  if (row.content !== null && row.content.length > 0) {
    await audit("imessage.content_violation", {
      handle: canonicalHandle,
      textLength: row.content.length,
    });
    return;
  }
  if (row.pairingAttemptHash !== null) {
    // §5.1.1 pre-auth exception, whole and entire: EXACT hash match against
    // the active pairing session — attemptPairingInTx audits every branch.
    await attemptPairingInTx(
      client,
      { handle: canonicalHandle, attemptHash: row.pairingAttemptHash },
      { actor: "harness:imessage-sensor" },
    );
    return;
  }
  await audit("imessage.inbound.unpaired", { handle: canonicalHandle });
}

const HEALTH_UPSERT_SQL = `
  INSERT INTO imessage_sensor_state
    (singleton, cursor_rowid, health_process, health_database, health_decoder,
     health_cursor, health_shadow, updated_at)
  VALUES (true, 0, $1, $2, $3, $4, $5, $6::timestamptz)
  ON CONFLICT (singleton) DO UPDATE SET
    health_process  = EXCLUDED.health_process,
    health_database = EXCLUDED.health_database,
    health_decoder  = EXCLUDED.health_decoder,
    health_cursor   = EXCLUDED.health_cursor,
    health_shadow   = EXCLUDED.health_shadow,
    updated_at      = EXCLUDED.updated_at
`;

/**
 * Records the sensor's five-dimension health report: column-scoped upsert
 * (the cursor fields are never touched — 0 is the not-yet-cursoring
 * sentinel on a health-first insert) + one audit entry per report with the
 * dims and any details. Details live ONLY in the audit trail; state keeps
 * just the five dims. The audit row carries the harness grant id when the
 * caller passes one (opts.grantId, as the health route does).
 */
export async function recordHealth(
  db: SqlExecutor,
  health: ImessageHealthInput,
  opts: ImessageServiceOptions = {},
): Promise<void> {
  for (const dim of IMESSAGE_HEALTH_DIMS) {
    if (!isHealthDim(health[dim])) {
      throw new ImessageInputError(`${dim} must be one of healthy|degraded|failed`);
    }
  }
  if (
    health.details !== undefined &&
    health.details !== null &&
    (typeof health.details !== "object" || Array.isArray(health.details))
  ) {
    throw new ImessageInputError("details must be null or a plain object");
  }
  await db.query(HEALTH_UPSERT_SQL, [
    health.health_process,
    health.health_database,
    health.health_decoder,
    health.health_cursor,
    health.health_shadow,
    (opts.now?.() ?? new Date()).toISOString(),
  ]);
  await recordAudit(db, {
    actor: opts.actor ?? "harness:imessage-sensor",
    action: "imessage.sensor.health",
    reversible: true,
    grantId: opts.grantId ?? null,
    outputsRef: JSON.stringify({
      health_process: health.health_process,
      health_database: health.health_database,
      health_decoder: health.health_decoder,
      health_cursor: health.health_cursor,
      health_shadow: health.health_shadow,
      details: health.details ?? null,
    }),
  });
}

/** Reads the singleton state row (null before the first ingest/health). */
export async function getImessageSensorState(
  db: SqlExecutor,
): Promise<Record<string, unknown> | null> {
  const result = await db.query("SELECT * FROM imessage_sensor_state WHERE singleton = true");
  return result.rows[0] ?? null;
}
