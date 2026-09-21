/**
 * Calendar occurrence state (W5(b); plan §7 W5(b), §5 invariant 7).
 *
 * Occurrence is a SEPARATE fact from calendar status (Google's belief):
 * planned ≠ scheduled-past-unverified ≠ observed ≠ inferred ≠ corrected.
 * The laws this module enforces:
 *
 * - Time passing is NEVER evidence. `sweepPastUnverified` only labels
 *   past null-occurrence events `scheduled_past_unverified` — the floor.
 *   It is read-then-label, makes no external calls, never sets observed_*,
 *   and is idempotent.
 * - ONLY an explicit principal declaration graduates to
 *   `observed_occurred` / `observed_missed` (`confirmOccurrence`,
 *   kind = 'user_declared`, audited). `observed_missed` is user-declared
 *   only. An already-observed event cannot be silently re-graduated: a
 *   second declaration throws `OccurrenceAlreadyGraduatedError` (the
 *   re-declare path, if ever needed, will be explicit opt-in).
 * - Cross-source signals (e.g., a gmail confirmation email) only ever
 *   PROPOSE: `proposeOccurrenceFromSignal` is a pure builder returning the
 *   proposal payload the W6 wiring will persist (occurrence_confirmed_by
 *   kind = 'cross_source_proposed' + a confirm notification); it never
 *   touches occurrence. `crossSourceProposals` reads proposals awaiting
 *   principal confirmation.
 *
 * Migration 017 pins the graduation law at the database: an observed_*
 * occurrence requires occurrence_confirmed_by.kind = 'user_declared'.
 */

import { UUID_RE } from "../events/envelope.js";
import { recordAudit } from "../actions/audit.js";
import type { QueryExecutor } from "../queries/executor.js";

/** The three occurrence states (schema CHECK vocabulary, migration 017). */
export const OCCURRENCE_STATES = [
  "scheduled_past_unverified",
  "observed_occurred",
  "observed_missed",
] as const;

export type CalendarOccurrence = (typeof OCCURRENCE_STATES)[number];

/**
 * Grace period after end_time before the sweep may label an event: a
 * meeting that "ended" moments ago is in flight, not unverified history.
 */
export const OCCURRENCE_GRACE_MS = 30 * 60_000;

/** Default sweep horizon: only the last 14 days are eligible (bounded churn). */
export const DEFAULT_OCCURRENCE_LOOKBACK_HOURS = 24 * 14;

/** Provenance jsonb shape (calendar_events.occurrence_confirmed_by). */
export interface OccurrenceConfirmedBy {
  readonly kind: "user_declared" | "cross_source_proposed";
  readonly source: string;
  readonly at: string;
}

export class OccurrenceInputError extends Error {
  readonly code = "OCCURRENCE_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "OccurrenceInputError";
  }
}

export class CalendarEventNotFoundError extends Error {
  readonly code = "CALENDAR_EVENT_NOT_FOUND";
  constructor(readonly calendarEventId: string) {
    super(`calendar event ${calendarEventId} does not exist`);
    this.name = "CalendarEventNotFoundError";
  }
}

export class OccurrenceAlreadyGraduatedError extends Error {
  readonly code = "OCCURRENCE_ALREADY_GRADUATED";
  constructor(
    readonly calendarEventId: string,
    readonly occurrence: CalendarOccurrence,
  ) {
    super(
      `calendar event ${calendarEventId} is already "${occurrence}"; an observed state ` +
        "cannot be silently re-graduated (explicit re-declare path required)",
    );
    this.name = "OccurrenceAlreadyGraduatedError";
  }
}

// ------------------------------------------------------------------- sweep

const SWEEP_SQL = `
  UPDATE calendar_events
     SET occurrence = 'scheduled_past_unverified', updated_at = now()
   WHERE occurrence IS NULL
     AND end_time IS NOT NULL
     AND end_time < $1::timestamptz
     AND end_time >= $2::timestamptz
   RETURNING id
`;

export interface OccurrenceSweepOptions {
  /** Sweep clock — injected for determinism. */
  readonly now: Date;
  /** How far back (hours) the sweep looks; defaults to 14 days. */
  readonly lookbackHours?: number;
}

export interface OccurrenceSweepReport {
  /** Rows newly labeled scheduled_past_unverified this pass. */
  readonly marked: number;
}

/**
 * Labels past events with the occurrence floor: every event whose
 * end_time passed the 30-minute grace (and lies inside the lookback
 * window) AND whose occurrence is still NULL becomes
 * `scheduled_past_unverified`. Read-then-label over the projection — no
 * external calls, no observed_* writes (the migration CHECK makes those
 * impossible without user_declared provenance anyway). Idempotent: rows
 * already labeled no longer match.
 */
export async function sweepPastUnverified(
  db: QueryExecutor,
  opts: OccurrenceSweepOptions,
): Promise<OccurrenceSweepReport> {
  const cutoff = new Date(opts.now.getTime() - OCCURRENCE_GRACE_MS);
  const lookbackHours = opts.lookbackHours ?? DEFAULT_OCCURRENCE_LOOKBACK_HOURS;
  if (!Number.isFinite(lookbackHours) || lookbackHours < 0) {
    throw new OccurrenceInputError("lookbackHours must be a non-negative number");
  }
  const floor = new Date(cutoff.getTime() - lookbackHours * 3_600_000);
  const result = await db.query(SWEEP_SQL, [cutoff.toISOString(), floor.toISOString()]);
  return { marked: result.rows.length };
}

// ----------------------------------------------------------------- confirm

const CONFIRM_SQL = `
  UPDATE calendar_events
     SET occurrence = $2::text,
         occurrence_confirmed_by = $3::jsonb,
         updated_at = now()
   WHERE id = $1::uuid
     AND (occurrence IS NULL OR occurrence = 'scheduled_past_unverified')
   RETURNING id, google_event_id, occurrence, occurrence_confirmed_by
`;

export interface ConfirmOccurrenceInput {
  /** calendar_events.id (the projection row uuid, not the Google event id). */
  readonly calendarEventId: string;
  /** The principal's explicit declaration of what happened. */
  readonly happened: boolean;
  /** Declaring principal — becomes the user_declared provenance source. */
  readonly principalId: string;
  /** Declaration instant — injected for determinism. */
  readonly now: Date;
}

export interface ConfirmedOccurrence {
  readonly calendarEventId: string;
  readonly googleEventId: string;
  readonly occurrence: Exclude<CalendarOccurrence, "scheduled_past_unverified">;
  readonly confirmedBy: OccurrenceConfirmedBy;
}

/**
 * User-declared graduation (plan §18-5: explicit principal statements
 * auto-apply): `happened` → `observed_occurred`, otherwise
 * `observed_missed`, with occurrence_confirmed_by = {kind:
 * 'user_declared', source: principal, at}. The transition guard is in the
 * UPDATE's WHERE clause — only NULL / scheduled_past_unverified rows are
 * eligible, so an already-observed event is never silently re-graduated
 * (a second declaration throws OccurrenceAlreadyGraduatedError, even
 * with the same verdict). Audited via the existing recordAudit
 * conventions (principal actor, metadata only).
 */
export async function confirmOccurrence(
  db: QueryExecutor,
  input: ConfirmOccurrenceInput,
): Promise<ConfirmedOccurrence> {
  if (!UUID_RE.test(input.calendarEventId)) {
    throw new CalendarEventNotFoundError(input.calendarEventId);
  }
  if (!UUID_RE.test(input.principalId)) {
    throw new OccurrenceInputError("principalId must be a UUID");
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new OccurrenceInputError("now must be a valid Date");
  }

  const occurrence: ConfirmedOccurrence["occurrence"] = input.happened
    ? "observed_occurred"
    : "observed_missed";
  const confirmedBy: OccurrenceConfirmedBy = {
    kind: "user_declared",
    source: `principal:${input.principalId}`,
    at: input.now.toISOString(),
  };

  const updated = await db.query(CONFIRM_SQL, [
    input.calendarEventId,
    occurrence,
    JSON.stringify(confirmedBy),
  ]);
  const row = updated.rows[0];
  if (row === undefined) {
    const existing = await db.query(
      "SELECT occurrence FROM calendar_events WHERE id = $1::uuid",
      [input.calendarEventId],
    );
    const current = existing.rows[0];
    if (current === undefined) throw new CalendarEventNotFoundError(input.calendarEventId);
    throw new OccurrenceAlreadyGraduatedError(
      input.calendarEventId,
      String(current.occurrence) as CalendarOccurrence,
    );
  }

  await recordAudit(db, {
    actor: confirmedBy.source,
    action:
      occurrence === "observed_occurred"
        ? "calendar.occurrence.confirmed_occurred"
        : "calendar.occurrence.confirmed_missed",
    reversible: true,
    outputsRef: JSON.stringify({
      calendarEventId: input.calendarEventId,
      googleEventId: String(row.google_event_id),
      occurrence,
      at: confirmedBy.at,
    }),
  });

  return {
    calendarEventId: String(row.id),
    googleEventId: String(row.google_event_id),
    occurrence,
    confirmedBy,
  };
}

// ------------------------------------------------------- cross-source proposals

export interface OccurrenceProposalInput {
  /** calendar_events.id the signal speaks about. */
  readonly calendarEventId: string;
  /** Signal source identity, e.g. "adapter:gmail". */
  readonly signalSource: string;
  /** Content-free evidence summary (never raw message content). */
  readonly evidenceSummary: string;
  /** Proposal instant — injected for determinism; defaults to now. */
  readonly now?: Date;
}

export interface OccurrenceProposal {
  readonly calendarEventId: string;
  /** What principal confirmation would graduate the event to. */
  readonly targetOccurrence: "observed_occurred";
  /** The jsonb the W6 writer will persist (kind = 'cross_source_proposed'). */
  readonly proposedBy: OccurrenceConfirmedBy;
  readonly evidenceSummary: string;
  /** The confirm-proposal question surfaced to the principal. */
  readonly question: string;
}

/**
 * PURE builder for cross-source occurrence proposals (W5(b); the gmail
 * wiring itself is W6). Produces the proposal payload — the
 * occurrence_confirmed_by marker plus the confirm question — that the
 * future writer will persist as a review-queue-adjacent suggestion. It
 * performs NO database access and NEVER touches occurrence: a signal can
 * at most propose; only confirmOccurrence graduates.
 */
export function proposeOccurrenceFromSignal(input: OccurrenceProposalInput): OccurrenceProposal {
  if (!UUID_RE.test(input.calendarEventId)) {
    throw new OccurrenceInputError("calendarEventId must be a UUID");
  }
  if (typeof input.signalSource !== "string" || input.signalSource.trim().length === 0) {
    throw new OccurrenceInputError("signalSource must be a non-empty string");
  }
  if (typeof input.evidenceSummary !== "string" || input.evidenceSummary.trim().length === 0) {
    throw new OccurrenceInputError("evidenceSummary must be a non-empty string");
  }
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new OccurrenceInputError("now must be a valid Date");
  }
  return {
    calendarEventId: input.calendarEventId,
    targetOccurrence: "observed_occurred",
    proposedBy: {
      kind: "cross_source_proposed",
      source: input.signalSource,
      at: now.toISOString(),
    },
    evidenceSummary: input.evidenceSummary,
    question:
      `Cross-source signal (${input.signalSource}): ${input.evidenceSummary}. ` +
      "Did this event happen?",
  };
}

export interface CrossSourceProposalRow {
  readonly calendarEventId: string;
  readonly googleEventId: string;
  readonly summary: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly occurrence: CalendarOccurrence | null;
  readonly proposedBy: OccurrenceConfirmedBy;
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

/**
 * Reads cross-source proposals awaiting principal confirmation: rows
 * whose occurrence_confirmed_by is a cross_source_proposed marker and
 * whose occurrence has not graduated (NULL or scheduled_past_unverified).
 * Once the principal declares (confirmOccurrence overwrites the marker
 * with user_declared provenance), the row leaves this queue.
 */
export async function crossSourceProposals(
  db: QueryExecutor,
): Promise<readonly CrossSourceProposalRow[]> {
  const result = await db.query(
    `SELECT id, google_event_id, summary, start_time, end_time, occurrence, occurrence_confirmed_by
       FROM calendar_events
      WHERE occurrence_confirmed_by->>'kind' = 'cross_source_proposed'
        AND (occurrence IS NULL OR occurrence = 'scheduled_past_unverified')
      ORDER BY end_time ASC NULLS LAST, id ASC`,
  );
  return result.rows.map((row) => ({
    calendarEventId: String(row.id),
    googleEventId: String(row.google_event_id),
    summary: typeof row.summary === "string" ? row.summary : "",
    startTime: toIsoOrNull(row.start_time),
    endTime: toIsoOrNull(row.end_time),
    occurrence:
      row.occurrence === null || row.occurrence === undefined
        ? null
        : (String(row.occurrence) as CalendarOccurrence),
    proposedBy: {
      kind: "cross_source_proposed",
      source: String((row.occurrence_confirmed_by as Record<string, unknown>).source),
      at: String((row.occurrence_confirmed_by as Record<string, unknown>).at),
    },
  }));
}

// ------------------------------------------------------------------- render

export interface OccurrenceRenderInput {
  readonly occurrence: CalendarOccurrence | null;
  /** End instant — needed to distinguish upcoming from sweep-lag past. */
  readonly endTime?: string | null;
}

/** The unverified-floor label (sweep-lagged nulls render the same honesty). */
export const OCCURRENCE_UNVERIFIED_LABEL = "(unverified — I can't confirm it happened)";
/** User-declared graduation labels. */
export const OCCURRENCE_CONFIRMED_LABEL = "(confirmed)";
export const OCCURRENCE_MISSED_LABEL = "(didn't happen, per you)";

/**
 * Honest occurrence labels for renders (§5 invariant 7: distinct labels
 * end-to-end; a scheduled-past-unverified event is NEVER presented as
 * happened). observed_* render their declarations;
 * scheduled_past_unverified renders the unverified caveat; a null
 * occurrence renders '' while upcoming — and the same unverified caveat
 * once its end_time is past the grace, so sweep lag (or the lookback
 * boundary) can never yield an implicit "happened".
 */
export function renderOccurrenceHonest(
  events: readonly OccurrenceRenderInput[],
  now: Date = new Date(),
): string[] {
  const graceCutoff = now.getTime() - OCCURRENCE_GRACE_MS;
  return events.map((event) => {
    if (event.occurrence === "observed_occurred") return OCCURRENCE_CONFIRMED_LABEL;
    if (event.occurrence === "observed_missed") return OCCURRENCE_MISSED_LABEL;
    if (event.occurrence === "scheduled_past_unverified") return OCCURRENCE_UNVERIFIED_LABEL;
    const endedAt = event.endTime === null || event.endTime === undefined ? null : Date.parse(event.endTime);
    if (endedAt !== null && Number.isFinite(endedAt) && endedAt <= graceCutoff) {
      return OCCURRENCE_UNVERIFIED_LABEL;
    }
    return "";
  });
}
