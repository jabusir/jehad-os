/**
 * Event store — accept/query paths for the events/outbox tables.
 *
 * THE single mapping point between the camelCase envelope (wire/verbatim
 * form) and the snake_case `events` columns (relational projection) —
 * docs/event-model.md §9.1 / docs/data-model.md §9.4. Every event write in
 * the system goes through acceptEvent (there is deliberately no UPDATE path:
 * events are immutable once accepted, plan §8), and every envelope-shaped
 * read goes through rowToEventEnvelope.
 *
 * Executor is a structural subset of pg.Pool / @jehad/db SqlExecutor, keeping
 * @jehad/core free of runtime dependencies.
 */

import { isCatalogV1EventTypeName } from "./catalog.js";
import {
  idempotencyKeyFor,
  mintEventId,
  UUID_RE,
  type EventEnvelope,
  type EventIngestInput,
  type Sensitivity,
  SENSITIVITY_V1,
} from "./envelope.js";

export interface EventStoreExecutor {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Thrown by acceptEvent when the envelope's domain key has no domains row. */
export class DomainNotFoundError extends Error {
  readonly validationCode = "DOMAIN_NOT_FOUND";
  constructor(readonly domainKey: string) {
    super(`domain "${domainKey}" does not exist`);
    this.name = "DomainNotFoundError";
  }
}

export interface AcceptedEvent {
  /** True when this call created the row; false when a duplicate delivery was a no-op. */
  readonly accepted: boolean;
  readonly envelope: EventEnvelope;
}

/** Canonical envelope read shape: events columns + the domain key. */
const ENVELOPE_SELECT = `
  ev.id, ev.type, ev.source, ev.occurred_at, ev.recorded_at,
  ev.idempotency_key, ev.payload, ev.sensitivity, ev.run_id, ev.schema_version,
  d.key AS domain_key
`;

const ACCEPT_SQL = `
  WITH ins AS (
    INSERT INTO events
      (id, type, source, occurred_at, recorded_at, idempotency_key,
       domain_id, payload, sensitivity, run_id, schema_version)
    VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::uuid,
            $8::jsonb, $9, $10::uuid, $11)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id, type, source, occurred_at, recorded_at, idempotency_key,
              domain_id, payload, sensitivity, run_id, schema_version
  ), outbox_row AS (
    INSERT INTO outbox (event_id) SELECT id FROM ins
  )
  SELECT i.id, i.type, i.source, i.occurred_at, i.recorded_at,
         i.idempotency_key, i.payload, i.sensitivity, i.run_id, i.schema_version,
         d.key AS domain_key, TRUE AS inserted
  FROM ins i
  JOIN domains d ON d.id = i.domain_id
  UNION ALL
  SELECT e.id, e.type, e.source, e.occurred_at, e.recorded_at,
         e.idempotency_key, e.payload, e.sensitivity, e.run_id, e.schema_version,
         d.key AS domain_key, FALSE AS inserted
  FROM events e
  JOIN domains d ON d.id = e.domain_id
  WHERE e.idempotency_key = $6 AND NOT EXISTS (SELECT 1 FROM ins)
`;

const GET_BY_IDEMPOTENCY_KEY_SQL = `
  SELECT ${ENVELOPE_SELECT}
  FROM events ev JOIN domains d ON d.id = ev.domain_id
  WHERE ev.idempotency_key = $1
`;

function toIso(value: unknown, column: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  throw new Error(`event row has unparseable ${column}: ${String(value)}`);
}

/**
 * The envelope↔column mapping (camelCase envelope ↔ snake_case columns).
 * `row` must carry the ENVELOPE_SELECT shape (domain key as domain_key).
 */
export function rowToEventEnvelope(row: Record<string, unknown>): EventEnvelope {
  const type = String(row.type);
  if (!isCatalogV1EventTypeName(type)) {
    throw new Error(`event row has non-catalog-v1 type "${type}"`);
  }
  const sensitivity = String(row.sensitivity);
  if (!(SENSITIVITY_V1 as readonly string[]).includes(sensitivity)) {
    throw new Error(`event row has unknown sensitivity "${sensitivity}"`);
  }
  const payload = row.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("event row has non-object payload");
  }
  return {
    id: String(row.id),
    type,
    schemaVersion: Number(row.schema_version),
    source: String(row.source),
    occurredAt: toIso(row.occurred_at, "occurred_at"),
    recordedAt: toIso(row.recorded_at, "recorded_at"),
    domainId: String(row.domain_key),
    idempotencyKey: String(row.idempotency_key),
    sensitivity: sensitivity as Sensitivity,
    payload: payload as Record<string, unknown>,
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
  };
}

/**
 * Accepts one validated occurrence: mints id (uuid v7), idempotency key
 * (sha256(source + externalId)), and recordedAt; inserts the events row and
 * its pending outbox row atomically. A duplicate idempotency_key is a no-op
 * returning the existing envelope with accepted=false (200-noop, plan §15 M2)
 * — the accepted row is never modified (immutability).
 */
export async function acceptEvent(
  db: EventStoreExecutor,
  input: EventIngestInput,
  opts: { now?: () => Date } = {},
): Promise<AcceptedEvent> {
  const domain = await db.query("SELECT id FROM domains WHERE key = $1", [
    input.domainId,
  ]);
  const domainRow = domain.rows[0];
  if (domainRow === undefined) {
    throw new DomainNotFoundError(input.domainId);
  }
  const now = opts.now?.() ?? new Date();
  const idempotencyKey = idempotencyKeyFor(input.source, input.externalId);
  const result = await db.query(ACCEPT_SQL, [
    mintEventId(now),
    input.type,
    input.source,
    input.occurredAt,
    now.toISOString(),
    idempotencyKey,
    String(domainRow.id),
    JSON.stringify(input.payload),
    input.sensitivity,
    input.runId,
    input.schemaVersion,
  ]);
  let row = result.rows[0];
  if (row === undefined) {
    // Snapshot race under READ COMMITTED: a concurrent statement won the
    // unique key and committed mid-statement, so the conflict branch above
    // could not see its row yet. Re-read in a fresh statement.
    const existing = await db.query(GET_BY_IDEMPOTENCY_KEY_SQL, [idempotencyKey]);
    row = existing.rows[0];
  }
  if (row === undefined) {
    throw new Error("acceptEvent: query returned no row");
  }
  return { accepted: row.inserted === true, envelope: rowToEventEnvelope(row) };
}

/** Fetches one envelope by event id (uuid); null when absent. */
export async function getEventById(
  db: EventStoreExecutor,
  id: string,
): Promise<EventEnvelope | null> {
  if (!UUID_RE.test(id)) return null;
  const result = await db.query(
    `SELECT ${ENVELOPE_SELECT}
     FROM events ev JOIN domains d ON d.id = ev.domain_id
     WHERE ev.id = $1::uuid`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : rowToEventEnvelope(row);
}

/** Fetches envelopes for a batch of event ids, keyed by id (empty map if none). */
export async function getEventEnvelopesByIds(
  db: EventStoreExecutor,
  ids: readonly string[],
): Promise<Map<string, EventEnvelope>> {
  const envelopes = new Map<string, EventEnvelope>();
  if (ids.length === 0) return envelopes;
  const result = await db.query(
    `SELECT ${ENVELOPE_SELECT}
     FROM events ev JOIN domains d ON d.id = ev.domain_id
     WHERE ev.id = ANY($1::uuid[])`,
    [ids],
  );
  for (const row of result.rows) {
    const envelope = rowToEventEnvelope(row);
    envelopes.set(envelope.id, envelope);
  }
  return envelopes;
}
