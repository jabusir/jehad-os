// Dogfooding feedback service (E3-B). The owner's directive during Calendar
// dogfooding: measure SIGNAL QUALITY, not parsing mechanics. This module is
// the single append-only write path for the owner's verdicts on what the
// system surfaced.
//
// Verdict vocabulary — maps 1:1 to the owner's five measurement targets:
//   useful       → useful surfaced changes
//   noise        → false attention items
//   missed       → missed meaningful changes
//   incorrect    → incorrect commitments/state
//   interruptive → unnecessary interruptions
//
// There is deliberately NO update or delete path: corrections are new rows.
// An exact re-tap (same item_type + item_id + verdict) inside 24h is an
// idempotent no-op that returns the existing row.

export type FeedbackVerdict = "useful" | "noise" | "missed" | "incorrect" | "interruptive";

export const FEEDBACK_VERDICTS = [
  "useful", "noise", "missed", "incorrect", "interruptive",
] as const satisfies readonly FeedbackVerdict[];

export type FeedbackItemType =
  | "notification"
  | "attention_item"
  | "review_item"
  | "brief_section"
  | "event";

export const FEEDBACK_ITEM_TYPES = [
  "notification", "attention_item", "review_item", "brief_section", "event",
] as const satisfies readonly FeedbackItemType[];

/** Structural read/write slice of pg.Pool — everything this service needs. */
export interface FeedbackDb {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface FeedbackRow {
  readonly id: string;
  readonly itemType: FeedbackItemType;
  readonly itemId: string;
  readonly verdict: FeedbackVerdict;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export class FeedbackInputError extends Error {
  readonly code = "FEEDBACK_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "FeedbackInputError";
  }
}

export function isFeedbackVerdict(value: unknown): value is FeedbackVerdict {
  return typeof value === "string" && (FEEDBACK_VERDICTS as readonly string[]).includes(value);
}

export function isFeedbackItemType(value: unknown): value is FeedbackItemType {
  return typeof value === "string" && (FEEDBACK_ITEM_TYPES as readonly string[]).includes(value);
}

export const DEFAULT_FEEDBACK_CREATED_BY = "josctl-manual";

/** Re-taps inside this window collapse onto the original row. */
export const FEEDBACK_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RecordFeedbackInput {
  readonly itemType: FeedbackItemType;
  readonly itemId: string;
  readonly verdict: FeedbackVerdict;
  readonly note?: string | null;
  /** Principal id or a manual marker like 'josctl-manual' (the default). */
  readonly createdBy?: string;
}

export interface RecordFeedbackResult {
  readonly feedback: FeedbackRow;
  /** True when an identical (itemType, itemId, verdict) tap inside 24h was swallowed. */
  readonly deduped: boolean;
}

export interface RecordFeedbackOptions {
  readonly now?: () => Date;
}

const FEEDBACK_COLUMNS = "id, item_type, item_id, verdict, note, created_by, created_at";

function rowToFeedback(row: Record<string, unknown>): FeedbackRow {
  return {
    id: String(row.id),
    itemType: String(row.item_type) as FeedbackItemType,
    itemId: String(row.item_id),
    verdict: String(row.verdict) as FeedbackVerdict,
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdBy: String(row.created_by),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  };
}

/**
 * Records one verdict. INSERT-only: the dedupe check is a SELECT inside the
 * window, never a mutation — the table has no mutable surface at all.
 */
export async function recordFeedback(
  db: FeedbackDb,
  input: RecordFeedbackInput,
  opts: RecordFeedbackOptions = {},
): Promise<RecordFeedbackResult> {
  if (!isFeedbackItemType(input.itemType)) {
    throw new FeedbackInputError(
      `itemType must be one of ${FEEDBACK_ITEM_TYPES.join("|")}`,
    );
  }
  if (!isFeedbackVerdict(input.verdict)) {
    throw new FeedbackInputError(`verdict must be one of ${FEEDBACK_VERDICTS.join("|")}`);
  }
  if (typeof input.itemId !== "string" || input.itemId.trim().length === 0 || input.itemId.length > 280) {
    throw new FeedbackInputError("itemId must be a non-empty string of at most 280 chars");
  }
  const note = input.note ?? null;
  if (note !== null && (typeof note !== "string" || note.length > 2000)) {
    throw new FeedbackInputError("note must be a string of at most 2000 chars");
  }
  const createdBy = input.createdBy ?? DEFAULT_FEEDBACK_CREATED_BY;
  if (typeof createdBy !== "string" || createdBy.trim().length === 0 || createdBy.length > 200) {
    throw new FeedbackInputError("createdBy must be a non-empty string of at most 200 chars");
  }
  const now = opts.now?.() ?? new Date();

  const existing = await db.query(
    `SELECT ${FEEDBACK_COLUMNS} FROM feedback
     WHERE item_type = $1 AND item_id = $2 AND verdict = $3
       AND created_at >= $4::timestamptz
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.itemType, input.itemId, input.verdict, new Date(now.getTime() - FEEDBACK_DEDUPE_WINDOW_MS).toISOString()],
  );
  const prior = existing.rows[0];
  if (prior !== undefined) {
    return { feedback: rowToFeedback(prior), deduped: true };
  }

  const inserted = await db.query(
    `INSERT INTO feedback (item_type, item_id, verdict, note, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
     RETURNING ${FEEDBACK_COLUMNS}`,
    [input.itemType, input.itemId, input.verdict, note, createdBy, now.toISOString()],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("recordFeedback: insert returned no row");
  return { feedback: rowToFeedback(row), deduped: false };
}

export interface ListFeedbackFilters {
  /** Inclusive lower bound on created_at; omit for all time. */
  readonly since?: Date | string;
  readonly limit?: number;
}

/** Newest-first listing (josctl feedback --recent is limit 20). */
export async function listFeedback(
  db: FeedbackDb,
  filters: ListFeedbackFilters = {},
): Promise<readonly FeedbackRow[]> {
  const limit = filters.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new FeedbackInputError("limit must be an integer in [1, 500]");
  }
  const values: unknown[] = [];
  let where = "";
  if (filters.since !== undefined) {
    const since = filters.since instanceof Date ? filters.since : new Date(filters.since);
    if (Number.isNaN(since.getTime())) {
      throw new FeedbackInputError(`listFeedback: invalid since timestamp: ${String(filters.since)}`);
    }
    values.push(since.toISOString());
    where = `WHERE created_at >= $1::timestamptz`;
  }
  values.push(limit);
  const result = await db.query(
    `SELECT ${FEEDBACK_COLUMNS} FROM feedback
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows.map(rowToFeedback);
}

// ------------------------------------------------------ correlation helpers

export interface CorrelatedEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
}

export interface FeedbackWithEvent {
  readonly feedback: FeedbackRow;
  /** Null when the item_id does not resolve to an event row (orphan verdict). */
  readonly event: CorrelatedEvent | null;
}

function windowClause(filters: ListFeedbackFilters): { where: string; values: unknown[] } {
  const values: unknown[] = [];
  let where = "";
  if (filters.since !== undefined) {
    const since = filters.since instanceof Date ? filters.since : new Date(filters.since);
    if (Number.isNaN(since.getTime())) {
      throw new FeedbackInputError(`invalid since timestamp: ${String(filters.since)}`);
    }
    values.push(since.toISOString());
    where = `AND f.created_at >= $${values.length}::timestamptz`;
  }
  return { where, values };
}

function boundLimit(filters: ListFeedbackFilters): number {
  const limit = filters.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new FeedbackInputError("limit must be an integer in [1, 500]");
  }
  return limit;
}

const CORRELATED_FEEDBACK_COLUMNS =
  "f.id, f.item_type, f.item_id, f.verdict, f.note, f.created_by, f.created_at";

/** item_type='event' verdicts LEFT JOINed to events by id — metrics input. */
export async function listFeedbackForEvents(
  db: FeedbackDb,
  filters: ListFeedbackFilters = {},
): Promise<readonly FeedbackWithEvent[]> {
  const limit = boundLimit(filters);
  const { where, values } = windowClause(filters);
  const result = await db.query(
    `SELECT ${CORRELATED_FEEDBACK_COLUMNS}, e.id::text AS joined_id, e.type AS joined_type,
            e.occurred_at AS joined_occurred_at
     FROM feedback f
     LEFT JOIN events e ON e.id::text = f.item_id
     WHERE f.item_type = 'event' ${where}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT $${values.length + 1}`,
    [...values, limit],
  );
  return result.rows.map((row) => ({
    feedback: rowToFeedback(row),
    event:
      row.joined_id === null || row.joined_id === undefined
        ? null
        : {
            id: String(row.joined_id),
            type: String(row.joined_type),
            occurredAt:
              row.joined_occurred_at instanceof Date
                ? (row.joined_occurred_at as Date).toISOString()
                : String(row.joined_occurred_at),
          },
  }));
}

export interface CorrelatedNotification {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
}

export interface FeedbackWithNotification {
  readonly feedback: FeedbackRow;
  /** Null when the item_id does not resolve to a notification row. */
  readonly notification: CorrelatedNotification | null;
}

/** item_type='notification' verdicts LEFT JOINed to notifications by id. */
export async function listFeedbackForNotifications(
  db: FeedbackDb,
  filters: ListFeedbackFilters = {},
): Promise<readonly FeedbackWithNotification[]> {
  const limit = boundLimit(filters);
  const { where, values } = windowClause(filters);
  const result = await db.query(
    `SELECT ${CORRELATED_FEEDBACK_COLUMNS}, n.id::text AS joined_id, n.kind AS joined_kind,
            n.title AS joined_title, n.status AS joined_status
     FROM feedback f
     LEFT JOIN notifications n ON n.id::text = f.item_id
     WHERE f.item_type = 'notification' ${where}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT $${values.length + 1}`,
    [...values, limit],
  );
  return result.rows.map((row) => ({
    feedback: rowToFeedback(row),
    notification:
      row.joined_id === null || row.joined_id === undefined
        ? null
        : {
            id: String(row.joined_id),
            kind: String(row.joined_kind),
            title: String(row.joined_title),
            status: String(row.joined_status),
          },
  }));
}
