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

import { recordAudit, type SqlExecutor } from "../actions/audit.js";

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
}

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
     decoded_status, text_length, normalized_text_sha256, observed_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
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
  ORDER BY delivered_at DESC
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

/**
 * Ingests one shadow-sensor batch + cursor in a single transaction.
 * Dedupe on guid (at-least-once → exactly-once); duplicates counted.
 * Own-message rows (normalized_text_sha256 set) are correlated against
 * sent_message_fingerprints on hash + the 10-minute delivery→observation
 * window; matches set fingerprint_id, backfill the fingerprint's
 * imessage_guid (first correlation wins), and ride the report.
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
  const rows = batch.map(validateTransportEvent);
  const now = (opts.now?.() ?? new Date()).toISOString();

  const client = await db.connect();
  let accepted = 0;
  const matches: ImessageFingerprintMatch[] = [];
  try {
    await client.query("BEGIN");
    for (const row of rows) {
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
      ]);
      const eventId =
        inserted.rows[0] !== undefined
          ? String(inserted.rows[0].id)
          : null;
      if (eventId !== null) accepted += 1;
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
  return {
    accepted,
    duplicates: rows.length - accepted,
    fingerprint_matches: matches,
  };
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
 * just the five dims.
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
