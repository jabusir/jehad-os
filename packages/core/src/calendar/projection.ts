/**
 * Calendar projection persistence (E3) — the calendar_events world-model
 * slice plus the calendar_sync_state cursor. Structural executor subset of
 * pg.Pool / @jehad/db (keeps @jehad/core dependency-free, same convention as
 * the event store).
 *
 * The projection mirrors what Google last sent (honest mirror: a minimal
 * cancelled payload nulls times; the cancelled OBSERVATION payload carries
 * previousStart/previousEnd, so the event log keeps when the meeting was).
 * Every row carries source_event_id provenance — the observation event that
 * last wrote it — so the log reconstructs why the world model believes each
 * row. Google Calendar remains authoritative; nothing here ever writes back.
 *
 * Today's schedule (briefs): v1 is the personal domain, single calendar —
 * every calendar_events row is personal-domain by construction (no domain
 * column until multi-calendar/multi-domain arrives). "Today" is the UTC day
 * of the brief's now; calendar-native times are stored as UTC instants, so
 * the boundary is deterministic and test-pinnable.
 */

import type { QueryExecutor } from "../queries/executor.js";
import type {
  CalendarProjectionSnapshot,
  NormalizedCalendarEvent,
} from "./change-detection.js";

export interface CalendarEventRow extends CalendarProjectionSnapshot {
  readonly id: string;
  readonly googleEventId: string;
  readonly googleCalendarId: string;
  readonly summary: string;
  readonly timezone: string | null;
  readonly attendees: unknown;
  readonly location: string | null;
  readonly metadata: unknown;
  readonly sourceEventId: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TodayScheduleItem {
  readonly googleEventId: string;
  readonly summary: string;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly timezone: string | null;
  readonly location: string | null;
}

export interface CalendarSyncStateRow {
  readonly calendarId: string;
  readonly syncToken: string | null;
  readonly lastSyncedAt: string | null;
  readonly lastPageCount: number;
}

const SELECT_EVENT_SQL = `
  SELECT id, google_event_id, google_calendar_id, status, summary, start_time, end_time,
         timezone, attendees, location, metadata, source_event_id, content_hash,
         created_at, updated_at
  FROM calendar_events
  WHERE google_calendar_id = $1 AND google_event_id = $2
`;

const UPSERT_EVENT_SQL = `
  INSERT INTO calendar_events
    (google_event_id, google_calendar_id, status, summary, start_time, end_time,
     timezone, attendees, location, metadata, source_event_id, content_hash)
  VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8::jsonb, $9, $10::jsonb, $11::uuid, $12)
  ON CONFLICT (google_calendar_id, google_event_id) DO UPDATE SET
    status         = EXCLUDED.status,
    summary        = EXCLUDED.summary,
    start_time     = EXCLUDED.start_time,
    end_time       = EXCLUDED.end_time,
    timezone       = EXCLUDED.timezone,
    attendees      = EXCLUDED.attendees,
    location       = EXCLUDED.location,
    metadata       = EXCLUDED.metadata,
    source_event_id = EXCLUDED.source_event_id,
    content_hash   = EXCLUDED.content_hash,
    updated_at     = now()
`;

const SELECT_SYNC_STATE_SQL = `
  SELECT calendar_id, sync_token, last_synced_at, last_page_count
  FROM calendar_sync_state
  WHERE id = 1
`;

const UPSERT_SYNC_STATE_SQL = `
  INSERT INTO calendar_sync_state (id, calendar_id, sync_token, last_synced_at, last_page_count)
  VALUES (1, $1, $2, $3::timestamptz, $4)
  ON CONFLICT (id) DO UPDATE SET
    calendar_id     = EXCLUDED.calendar_id,
    sync_token      = EXCLUDED.sync_token,
    last_synced_at  = EXCLUDED.last_synced_at,
    last_page_count = EXCLUDED.last_page_count,
    updated_at      = now()
`;

const TODAY_SCHEDULE_SQL = `
  SELECT google_event_id, summary, start_time, end_time, timezone, location
  FROM calendar_events
  WHERE status <> 'cancelled'
    AND start_time >= $1::timestamptz
    AND start_time < $2::timestamptz
  ORDER BY start_time ASC, google_event_id ASC
`;

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function rowToCalendarEvent(row: Record<string, unknown>): CalendarEventRow {
  return {
    id: String(row.id),
    googleEventId: String(row.google_event_id),
    googleCalendarId: String(row.google_calendar_id),
    status: String(row.status),
    summary: typeof row.summary === "string" ? row.summary : "",
    startTime: isoOrNull(row.start_time),
    endTime: isoOrNull(row.end_time),
    timezone: row.timezone === null || row.timezone === undefined ? null : String(row.timezone),
    attendees: row.attendees ?? [],
    location: row.location === null || row.location === undefined ? null : String(row.location),
    metadata: row.metadata ?? {},
    sourceEventId: String(row.source_event_id),
    contentHash: String(row.content_hash),
    createdAt: isoOrNull(row.created_at) ?? "",
    updatedAt: isoOrNull(row.updated_at) ?? "",
  };
}

/** Reads one projection row by source refs; null when unseen. */
export async function getCalendarEvent(
  db: QueryExecutor,
  googleCalendarId: string,
  googleEventId: string,
): Promise<CalendarEventRow | null> {
  const result = await db.query(SELECT_EVENT_SQL, [googleCalendarId, googleEventId]);
  const row = result.rows[0];
  return row === undefined ? null : rowToCalendarEvent(row);
}

/** Upserts the projection row; sourceEventId is the provenance link. */
export async function upsertCalendarEvent(
  db: QueryExecutor,
  googleCalendarId: string,
  event: NormalizedCalendarEvent,
  sourceEventId: string,
): Promise<void> {
  await db.query(UPSERT_EVENT_SQL, [
    event.googleEventId,
    googleCalendarId,
    event.status,
    event.summary,
    event.start,
    event.end,
    event.timezone,
    JSON.stringify(event.attendees),
    event.location,
    JSON.stringify(event.metadata),
    sourceEventId,
    event.contentHash,
  ]);
}

/** The sync cursor singleton (id=1); null before the first sync. */
export async function getCalendarSyncState(db: QueryExecutor): Promise<CalendarSyncStateRow | null> {
  const result = await db.query(SELECT_SYNC_STATE_SQL);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    calendarId: String(row.calendar_id),
    syncToken: row.sync_token === null || row.sync_token === undefined ? null : String(row.sync_token),
    lastSyncedAt: isoOrNull(row.last_synced_at),
    lastPageCount: Number(row.last_page_count ?? 0),
  };
}

/** Persists the cursor: calendar_id, latest syncToken, last sync facts. */
export async function upsertCalendarSyncState(
  db: QueryExecutor,
  state: {
    readonly calendarId: string;
    readonly syncToken: string | null;
    readonly lastSyncedAt: Date;
    readonly lastPageCount: number;
  },
): Promise<void> {
  await db.query(UPSERT_SYNC_STATE_SQL, [
    state.calendarId,
    state.syncToken,
    state.lastSyncedAt.toISOString(),
    state.lastPageCount,
  ]);
}

/** UTC day bounds [dayStart, dayEnd) around `now` (deterministic, pinnable). */
export function todayScheduleBounds(now: Date): { dayStart: Date; dayEnd: Date } {
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, dayEnd };
}

/**
 * LOCAL day bounds [dayStart, dayEnd) of `now` in the given IANA timezone
 * (DST-safe). The morning brief's "today" is the owner's today, not UTC's.
 */
export function localDayBounds(now: Date, timeZone: string): { dayStart: Date; dayEnd: Date } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "01";
  // Wall-clock midnight of the local day, expressed as if it were UTC.
  const wallMidnightUtc = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")), 0, 0, 0);
  const offsetMinutesAt = (instant: number): number => {
    const name =
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(new Date(instant))
        .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    if (m === null) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]));
  };
  // Fixed point: utc = wall - offset(utc). Two passes converge for any
  // real timezone (offsets are within ±14h; DST boundaries included).
  let utc = wallMidnightUtc;
  for (let i = 0; i < 4; i++) {
    const next = wallMidnightUtc - offsetMinutesAt(utc) * 60_000;
    if (next === utc) break;
    utc = next;
  }
  return { dayStart: new Date(utc), dayEnd: new Date(utc + 24 * 60 * 60 * 1000) };
}

/** The next upcoming event strictly after the local day (for quiet days). */
export async function getNextUpcomingEvent(
  db: QueryExecutor,
  opts: { readonly dayEnd: Date },
): Promise<TodayScheduleItem | null> {
  const result = await db.query(
    `SELECT google_event_id, summary, start_time, end_time, timezone, location
       FROM calendar_events
      WHERE status <> 'cancelled'
        AND start_time > $1::timestamptz
      ORDER BY start_time ASC, google_event_id ASC
      LIMIT 1`,
    [opts.dayEnd.toISOString()],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    googleEventId: String(row.google_event_id),
    summary: typeof row.summary === "string" ? row.summary : "",
    startTime: isoOrNull(row.start_time) ?? "",
    endTime: isoOrNull(row.end_time),
    timezone: row.timezone === null || row.timezone === undefined ? null : String(row.timezone),
    location: row.location === null || row.location === undefined ? null : String(row.location),
  };
}

/**
 * Today's non-cancelled calendar events for the morning brief, ordered by
 * start. Calendar-native times straight from the projection (trusted tier).
 */
export async function getTodaySchedule(
  db: QueryExecutor,
  opts: { readonly now: Date; readonly timeZone?: string },
): Promise<TodayScheduleItem[]> {
  const { dayStart, dayEnd } = opts.timeZone
    ? localDayBounds(opts.now, opts.timeZone)
    : todayScheduleBounds(opts.now);
  const result = await db.query(TODAY_SCHEDULE_SQL, [dayStart.toISOString(), dayEnd.toISOString()]);
  return result.rows.map((row) => ({
    googleEventId: String(row.google_event_id),
    summary: typeof row.summary === "string" ? row.summary : "",
    startTime: isoOrNull(row.start_time) ?? "",
    endTime: isoOrNull(row.end_time),
    timezone: row.timezone === null || row.timezone === undefined ? null : String(row.timezone),
    location: row.location === null || row.location === undefined ? null : String(row.location),
  }));
}
