// Reminder lifecycle queries (W6-phase-2, w6-phase-2-reminders.md lane R1:
// pure data access over the `reminders` table — migration 021). No schedule
// math, no templates, no model calls: the lifecycle lane (R2) computes
// touches, the sweep lane (R3) drains dueTouches, and this module persists.
//
// Lifecycle: armed → completed | parked | cancelled, with renegotiation
// re-arming in place (escalations FORGIVEN to 0, renegotiations bumped).
// Terminal/pausing transitions null the next-touch fields so an armed row
// can never fire after it stopped being armed. Mutating queries are
// transition-guarded on status = 'armed': touching/completing/parking/
// cancelling/renegotiating a row that is not armed throws
// ReminderNotArmedError (ReminderNotFoundError if the id is unknown) —
// the confirmOccurrence guard precedent.
//
// Timezones: due_date is the obligation date as a principal-local PT civil
// date; an explicit due_time ({hour, minute} wall clock) is pinned to
// America/Los_Angeles on due_date in SQL (Postgres tz database owns DST).

import { UUID_RE } from "../events/envelope.js";
import { toIso, toIsoOrNull, type QueryExecutor } from "../queries/executor.js";
import type { TouchKind } from "./lifecycle.js";

/** The touch vocabulary (schema CHECK, migration 021). */
export const TOUCH_KINDS = ["morning", "probe", "nudge"] as const;

/** Reminder lifecycle statuses (schema CHECK, migration 021). */
export const REMINDER_STATUSES = ["armed", "completed", "parked", "cancelled"] as const;

export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

/** How a reminder reached completed. */
export type ResolutionVia = "user_reply" | "manual";

/** How a reminder reached cancelled. */
export type CancellationVia = "user" | "manual";

/** Principal-local timezone the obligation date/clock time live in. */
export const REMINDER_TIMEZONE = "America/Los_Angeles";

/** Explicit wall-clock time the user gave (e.g. "at 3pm"). */
export interface ReminderTimeInput {
  readonly hour: number;
  readonly minute: number;
}

export interface CreateReminderInput {
  readonly principal: string;
  /** Sanitized by the caller; stored as-is. */
  readonly title: string;
  readonly commitmentId?: string | null;
  /** Obligation date, principal-local PT civil date 'YYYY-MM-DD'. */
  readonly dueDate: string;
  /** Explicit clock time if the user gave one (principal-local PT). */
  readonly dueTime?: ReminderTimeInput | null;
  /** First scheduled touch instant. */
  readonly firstTouchAt: Date;
  readonly firstTouchKind: TouchKind;
  /** Interaction thread the touches/probe ride on. */
  readonly threadId?: string | null;
}

export interface RecordTouchOptions {
  /** Touch instant — also becomes updated_at. */
  readonly at: Date;
  readonly kind: TouchKind;
  /** Pre-scheduled follow-up (null = nothing more scheduled). */
  readonly nextTouchAt: Date | null;
  readonly nextTouchKind: TouchKind | null;
}

export interface RenegotiateReminderOptions {
  readonly dueDate: string;
  readonly dueTime: ReminderTimeInput | null;
  readonly firstTouchAt: Date;
  readonly firstTouchKind: TouchKind;
}

export interface ListRemindersOptions {
  /** Status filter; omit for all statuses. */
  readonly statuses?: readonly string[];
}

export interface ReminderRow {
  readonly id: string;
  readonly principal: string;
  readonly title: string;
  readonly commitmentId: string | null;
  /** Civil date 'YYYY-MM-DD' (principal-local PT obligation date). */
  readonly dueDate: string;
  /** ISO instant of the explicit clock time, or null. */
  readonly dueTime: string | null;
  readonly status: ReminderStatus;
  readonly nextTouchAt: string | null;
  readonly nextTouchKind: TouchKind | null;
  readonly escalations: number;
  readonly renegotiations: number;
  readonly lastTouchAt: string | null;
  readonly threadId: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedVia: string | null;
  readonly parkedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledVia: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ReminderInputError extends Error {
  readonly code = "REMINDER_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ReminderInputError";
  }
}

export class ReminderNotFoundError extends Error {
  readonly code = "REMINDER_NOT_FOUND";
  constructor(readonly reminderId: string) {
    super(`reminder ${reminderId} does not exist`);
    this.name = "ReminderNotFoundError";
  }
}

export class ReminderNotArmedError extends Error {
  readonly code = "REMINDER_NOT_ARMED";
  constructor(
    readonly reminderId: string,
    readonly status: ReminderStatus,
  ) {
    super(
      `reminder ${reminderId} is "${status}", not "armed"; the touch/transition ` +
        "path only applies to armed rows",
    );
    this.name = "ReminderNotArmedError";
  }
}

const REMINDER_COLUMNS = `
  SELECT id, principal, title, commitment_id, due_date::text AS due_date,
         due_time, status, next_touch_at, next_touch_kind, escalations,
         renegotiations, last_touch_at, thread_id, resolved_at, resolved_via,
         parked_at, cancelled_at, cancelled_via, created_at, updated_at
`;

const RETURNING = `
  RETURNING id, principal, title, commitment_id, due_date::text AS due_date,
         due_time, status, next_touch_at, next_touch_kind, escalations,
         renegotiations, last_touch_at, thread_id, resolved_at, resolved_via,
         parked_at, cancelled_at, cancelled_via, created_at, updated_at
`;

// Explicit wall-clock time → instant: naive timestamp on the due date, then
// interpreted AS principal-local PT (AT TIME ZONE on a timestamp). DST is
// Postgres' tz database's problem, not ours.
const DUE_TIME_SQL = `(
  CASE
    WHEN $HOUR::int IS NULL OR $MIN::int IS NULL THEN NULL::timestamptz
    ELSE ($DATE::date + make_interval(hours => $HOUR::int, mins => $MIN::int))
           AT TIME ZONE '${REMINDER_TIMEZONE}'
  END
)`;

const INSERT_SQL = `
  INSERT INTO reminders
    (principal, title, commitment_id, due_date, due_time,
     status, next_touch_at, next_touch_kind, thread_id)
  VALUES ($1, $2, $3::uuid, $4::date,
          ${DUE_TIME_SQL.replace(/\$DATE/g, "$4").replace(/\$HOUR/g, "$5").replace(/\$MIN/g, "$6")},
          'armed', $7::timestamptz, $8::text, $9::uuid)
  ${RETURNING}
`;

const DUE_TOUCHES_SQL = `
  ${REMINDER_COLUMNS}
  FROM reminders
  WHERE status = 'armed'
    AND next_touch_at IS NOT NULL
    AND next_touch_at <= $1::timestamptz
  ORDER BY next_touch_at ASC, id ASC
`;

const RECORD_TOUCH_SQL = `
  UPDATE reminders
     SET last_touch_at = $2::timestamptz,
         next_touch_at = $3::timestamptz,
         next_touch_kind = $4::text,
         escalations = escalations + (CASE WHEN $5::text = 'nudge' THEN 1 ELSE 0 END),
         updated_at = $2::timestamptz
   WHERE id = $1::uuid AND status = 'armed'
  ${RETURNING}
`;

const COMPLETE_SQL = `
  UPDATE reminders
     SET status = 'completed',
         resolved_at = now(),
         resolved_via = $2::text,
         next_touch_at = NULL,
         next_touch_kind = NULL,
         updated_at = now()
   WHERE id = $1::uuid AND status = 'armed'
  ${RETURNING}
`;

const RENEGOTIATE_SQL = `
  UPDATE reminders
     SET due_date = $2::date,
         due_time = ${DUE_TIME_SQL.replace(/\$DATE/g, "$2").replace(/\$HOUR/g, "$3").replace(/\$MIN/g, "$4")},
         next_touch_at = $5::timestamptz,
         next_touch_kind = $6::text,
         escalations = 0,
         renegotiations = renegotiations + 1,
         updated_at = now()
   WHERE id = $1::uuid AND status = 'armed'
  ${RETURNING}
`;

const PARK_SQL = `
  UPDATE reminders
     SET status = 'parked',
         parked_at = $2::timestamptz,
         next_touch_at = NULL,
         next_touch_kind = NULL,
         updated_at = $2::timestamptz
   WHERE id = $1::uuid AND status = 'armed'
  ${RETURNING}
`;

const CANCEL_SQL = `
  UPDATE reminders
     SET status = 'cancelled',
         cancelled_at = now(),
         cancelled_via = $2::text,
         next_touch_at = NULL,
         next_touch_kind = NULL,
         updated_at = now()
   WHERE id = $1::uuid AND status = 'armed'
  ${RETURNING}
`;

const GET_SQL = `${REMINDER_COLUMNS} FROM reminders WHERE id = $1::uuid`;

const LIST_SQL = `
  ${REMINDER_COLUMNS}
  FROM reminders
  WHERE principal = $1
    AND ($2::text[] IS NULL OR status = ANY($2::text[]))
  ORDER BY created_at ASC, id ASC
`;

const COUNT_ARMED_SQL = `
  SELECT count(*)::int AS n
    FROM reminders
   WHERE principal = $1 AND status = 'armed'
`;

const PARKED_SINCE_SQL = `
  ${REMINDER_COLUMNS}
  FROM reminders
  WHERE principal = $1
    AND status = 'parked'
    AND parked_at IS NOT NULL
    AND parked_at >= $2::timestamptz
  ORDER BY parked_at ASC, id ASC
`;

const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toReminderRow(row: Record<string, unknown>): ReminderRow {
  return {
    id: String(row.id),
    principal: String(row.principal),
    title: String(row.title),
    commitmentId:
      row.commitment_id === null || row.commitment_id === undefined
        ? null
        : String(row.commitment_id),
    dueDate: String(row.due_date),
    dueTime: toIsoOrNull(row.due_time, "due_time"),
    status: String(row.status) as ReminderStatus,
    nextTouchAt: toIsoOrNull(row.next_touch_at, "next_touch_at"),
    nextTouchKind:
      row.next_touch_kind === null || row.next_touch_kind === undefined
        ? null
        : (String(row.next_touch_kind) as TouchKind),
    escalations: Number(row.escalations),
    renegotiations: Number(row.renegotiations),
    lastTouchAt: toIsoOrNull(row.last_touch_at, "last_touch_at"),
    threadId:
      row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    resolvedAt: toIsoOrNull(row.resolved_at, "resolved_at"),
    resolvedVia:
      row.resolved_via === null || row.resolved_via === undefined
        ? null
        : String(row.resolved_via),
    parkedAt: toIsoOrNull(row.parked_at, "parked_at"),
    cancelledAt: toIsoOrNull(row.cancelled_at, "cancelled_at"),
    cancelledVia:
      row.cancelled_via === null || row.cancelled_via === undefined
        ? null
        : String(row.cancelled_via),
    createdAt: toIso(row.created_at, "created_at"),
    updatedAt: toIso(row.updated_at, "updated_at"),
  };
}

function validatePrincipal(principal: string): void {
  if (typeof principal !== "string" || principal.trim().length === 0) {
    throw new ReminderInputError("principal must be a non-empty string");
  }
}

function validateTitle(title: string): void {
  if (typeof title !== "string" || title.length === 0) {
    throw new ReminderInputError("title must be a non-empty string (sanitized by the caller)");
  }
}

function validateDueDate(dueDate: string): void {
  if (typeof dueDate !== "string" || !CIVIL_DATE_RE.test(dueDate)) {
    throw new ReminderInputError(`dueDate must be a civil date 'YYYY-MM-DD', got ${String(dueDate)}`);
  }
  const [y, m, d] = dueDate.split("-").map(Number);
  const parsed = new Date(`${dueDate}T00:00:00Z`);
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() + 1 !== m ||
    parsed.getUTCDate() !== d
  ) {
    throw new ReminderInputError(`dueDate must be a real civil date, got ${dueDate}`);
  }
}

function validateDueTime(dueTime: ReminderTimeInput | null | undefined): void {
  if (dueTime === null || dueTime === undefined) return;
  const { hour, minute } = dueTime;
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new ReminderInputError(
      `dueTime must be {hour: 0..23, minute: 0..59}, got ${JSON.stringify(dueTime)}`,
    );
  }
}

function validateInstant(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ReminderInputError(`${field} must be a valid Date`);
  }
}

function validateUuidOrNull(value: string | null | undefined, field: string): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ReminderInputError(`${field} must be a UUID or null`);
  }
}

function validateKind(kind: TouchKind, field: string): void {
  if (typeof kind !== "string" || !TOUCH_KINDS.includes(kind)) {
    throw new ReminderInputError(`${field} must be one of ${TOUCH_KINDS.join(", ")}`);
  }
}

/**
 * Applies an armed-guarded UPDATE and maps the row back; a no-row result
 * means either an unknown id (ReminderNotFoundError) or a row that already
 * left 'armed' (ReminderNotArmedError) — never a silent no-op.
 */
async function armedUpdate(
  db: QueryExecutor,
  sql: string,
  params: readonly unknown[],
  id: string,
): Promise<ReminderRow> {
  const result = await db.query(sql, params);
  const row = result.rows[0];
  if (row !== undefined) return toReminderRow(row);
  const existing = await db.query("SELECT status FROM reminders WHERE id = $1::uuid", [id]);
  const current = existing.rows[0];
  if (current === undefined) throw new ReminderNotFoundError(id);
  throw new ReminderNotArmedError(id, String(current.status) as ReminderStatus);
}

/**
 * Creates an armed reminder. The title is stored as-is (the capture lane
 * sanitizes); the explicit dueTime wall clock is pinned to principal-local
 * PT on dueDate.
 */
export async function createReminder(
  db: QueryExecutor,
  input: CreateReminderInput,
): Promise<ReminderRow> {
  validatePrincipal(input.principal);
  validateTitle(input.title);
  validateUuidOrNull(input.commitmentId, "commitmentId");
  validateDueDate(input.dueDate);
  validateDueTime(input.dueTime);
  validateInstant(input.firstTouchAt, "firstTouchAt");
  validateKind(input.firstTouchKind, "firstTouchKind");
  validateUuidOrNull(input.threadId, "threadId");
  const result = await db.query(INSERT_SQL, [
    input.principal,
    input.title,
    input.commitmentId ?? null,
    input.dueDate,
    input.dueTime?.hour ?? null,
    input.dueTime?.minute ?? null,
    input.firstTouchAt.toISOString(),
    input.firstTouchKind,
    input.threadId ?? null,
  ]);
  return toReminderRow(result.rows[0]!);
}

/**
 * The sweep feed (R3 lane): every armed reminder whose next touch is due at
 * or before `now`, oldest first — cross-principal by design (the sweep
 * delivers per principal downstream).
 */
export async function dueTouches(db: QueryExecutor, now: Date): Promise<ReminderRow[]> {
  validateInstant(now, "now");
  const result = await db.query(DUE_TOUCHES_SQL, [now.toISOString()]);
  return result.rows.map(toReminderRow);
}

/**
 * Records a fired touch: last_touch_at/updated_at move to `at`, the
 * next-touch fields take the caller's pre-schedule, and a nudge increments
 * escalations (morning/probe never do — only the escalation path counts).
 */
export async function recordTouch(
  db: QueryExecutor,
  id: string,
  opts: RecordTouchOptions,
): Promise<ReminderRow> {
  validateUuidOrNull(id, "id");
  validateInstant(opts.at, "at");
  validateKind(opts.kind, "kind");
  if (opts.nextTouchAt !== null) validateInstant(opts.nextTouchAt, "nextTouchAt");
  if (opts.nextTouchKind !== null) validateKind(opts.nextTouchKind, "nextTouchKind");
  return armedUpdate(
    db,
    RECORD_TOUCH_SQL,
    [
      id,
      opts.at.toISOString(),
      opts.nextTouchAt === null ? null : opts.nextTouchAt.toISOString(),
      opts.nextTouchKind,
      opts.kind,
    ],
    id,
  );
}

/**
 * Verifier D6: atomic claim-before-send. The sweep claims the touch (CAS on
 * status + expected next_touch_at) BEFORE enqueuing, so an overlapping tick
 * or a replayed step can never double-send, and a delivered touch is always
 * the one this claim produced. Returns null when the claim is lost (row
 * resolved/advanced elsewhere) — the caller sends nothing. Nudge increments
 * ride the claim (same semantics as recordTouch).
 */
export async function claimDueTouch(
  db: QueryExecutor,
  opts: {
    readonly id: string;
    readonly expectedNextTouchAt: Date;
    readonly at: Date;
    readonly kind: TouchKind;
    readonly nextTouchAt: Date | null;
    readonly nextTouchKind: TouchKind | null;
  },
): Promise<ReminderRow | null> {
  validateUuidOrNull(opts.id, "id");
  validateInstant(opts.expectedNextTouchAt, "expectedNextTouchAt");
  validateInstant(opts.at, "at");
  validateKind(opts.kind, "kind");
  if (opts.nextTouchAt !== null) validateInstant(opts.nextTouchAt, "nextTouchAt");
  if (opts.nextTouchKind !== null) validateKind(opts.nextTouchKind, "nextTouchKind");
  const row = await db.query(
    `UPDATE reminders SET
       last_touch_at = $2::timestamptz,
       next_touch_at = $3::timestamptz,
       next_touch_kind = $4,
       escalations = escalations + (CASE WHEN $5 = 'nudge' THEN 1 ELSE 0 END),
       updated_at = now()
     WHERE id = $1::uuid AND status = 'armed' AND next_touch_at = $6::timestamptz
     ${RETURNING}`,
    [
      opts.id,
      opts.at.toISOString(),
      opts.nextTouchAt === null ? null : opts.nextTouchAt.toISOString(),
      opts.nextTouchKind,
      opts.kind,
      opts.expectedNextTouchAt.toISOString(),
    ],
  );
  const first = row.rows[0];
  return first === undefined ? null : toReminderRow(first);
}

/**
 * Marks the obligation met (probe reply or manual): completed with
 * resolution provenance; the touch path closes (next-touch fields null).
 */
export async function completeReminder(
  db: QueryExecutor,
  id: string,
  via: ResolutionVia,
): Promise<ReminderRow> {
  validateUuidOrNull(id, "id");
  if (via !== "user_reply" && via !== "manual") {
    throw new ReminderInputError(`via must be 'user_reply' or 'manual', got ${String(via)}`);
  }
  return armedUpdate(db, COMPLETE_SQL, [id, via], id);
}

/**
 * Abide move ("gonna do it tomorrow"): due date/time and next touch are
 * rescheduled per the caller's normalization, escalations are FORGIVEN
 * (reset to 0), renegotiations bump, and the row stays armed.
 */
export async function renegotiateReminder(
  db: QueryExecutor,
  id: string,
  opts: RenegotiateReminderOptions,
): Promise<ReminderRow> {
  validateUuidOrNull(id, "id");
  validateDueDate(opts.dueDate);
  validateDueTime(opts.dueTime);
  validateInstant(opts.firstTouchAt, "firstTouchAt");
  validateKind(opts.firstTouchKind, "firstTouchKind");
  return armedUpdate(
    db,
    RENEGOTIATE_SQL,
    [
      id,
      opts.dueDate,
      opts.dueTime?.hour ?? null,
      opts.dueTime?.minute ?? null,
      opts.firstTouchAt.toISOString(),
      opts.firstTouchKind,
    ],
    id,
  );
}

/**
 * Nudge cap reached (or owner-directed pause): parked — no more texts;
 * the evening brief is the only surface (see listParkedSince).
 */
export async function parkReminder(db: QueryExecutor, id: string, at: Date): Promise<ReminderRow> {
  validateUuidOrNull(id, "id");
  validateInstant(at, "at");
  return armedUpdate(db, PARK_SQL, [id, at.toISOString()], id);
}

/**
 * "Stop reminding me" (or manual cleanup): cancelled with provenance; the
 * touch path closes.
 */
export async function cancelReminder(
  db: QueryExecutor,
  id: string,
  via: CancellationVia,
): Promise<ReminderRow> {
  validateUuidOrNull(id, "id");
  if (via !== "user" && via !== "manual") {
    throw new ReminderInputError(`via must be 'user' or 'manual', got ${String(via)}`);
  }
  return armedUpdate(db, CANCEL_SQL, [id, via], id);
}

/** One reminder by id, or null. */
export async function getReminder(db: QueryExecutor, id: string): Promise<ReminderRow | null> {
  validateUuidOrNull(id, "id");
  const result = await db.query(GET_SQL, [id]);
  const row = result.rows[0];
  return row === undefined ? null : toReminderRow(row);
}

/**
 * A principal's reminders, newest-created first, optionally filtered by
 * status. Principal-scoped: no other principal's rows can appear.
 */
export async function listReminders(
  db: QueryExecutor,
  principal: string,
  opts: ListRemindersOptions = {},
): Promise<ReminderRow[]> {
  validatePrincipal(principal);
  const statuses = opts.statuses ?? null;
  if (statuses !== null) {
    for (const status of statuses) {
      if (!REMINDER_STATUSES.includes(status as ReminderStatus)) {
        throw new ReminderInputError(
          `statuses must be a subset of ${REMINDER_STATUSES.join(", ")}, got ${String(status)}`,
        );
      }
    }
  }
  const result = await db.query(LIST_SQL, [principal, statuses]);
  return result.rows.map(toReminderRow);
}

/**
 * The day.state armed-reminder count (R5 lane): armed rows for one
 * principal only.
 */
export async function countArmedReminders(db: QueryExecutor, principal: string): Promise<number> {
  validatePrincipal(principal);
  const result = await db.query(COUNT_ARMED_SQL, [principal]);
  return Number(result.rows[0]!.n);
}

/**
 * Parked reminders to surface in the evening brief: parked at or after
 `since`, for one principal only.
 */
export async function listParkedSince(
  db: QueryExecutor,
  principal: string,
  since: Date,
): Promise<ReminderRow[]> {
  validatePrincipal(principal);
  validateInstant(since, "since");
  const result = await db.query(PARKED_SINCE_SQL, [principal, since.toISOString()]);
  return result.rows.map(toReminderRow);
}
