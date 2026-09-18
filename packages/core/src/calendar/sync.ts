/**
 * Calendar sync (E3) — the cursor-driven pipeline:
 * Google Calendar → SourceAdapter (events.list pages via syncToken) →
 * change classification vs the calendar_events projection → one observation
 * event per real-world change (calendar.event.created|updated|cancelled,
 * catalog v1 additive) → projection upsert with source_event_id provenance →
 * cursor persisted. Schedule changes reach whatChanged (attention) through
 * those observation events — no extra wiring.
 *
 * Idempotency (plan §8): externalId =
 * `${googleCalendarId}:${iCalUID ?? googleEventId}:${googleUpdated}` — one
 * real-world occurrence of one Google event = one key. Replaying the same
 * batch dedupes in acceptEvent AND classifies as unchanged once the
 * projection is current; either way, zero duplicate semantic effects.
 *
 * 410 handling: an expired syncToken surfaces as GoogleSyncTokenExpiredError
 * from the adapter; the response is one automatic full resync (token cleared,
 * changes re-derived — identical content classifies unchanged, so a resync
 * produces no duplicate events).
 */

import { GoogleSyncTokenExpiredError, type GoogleCalendarEvent } from "@jehad/adapters";
import { acceptEvent, type EventStoreExecutor } from "../events/store.js";
import { LATEST_PAYLOAD_SCHEMA_VERSION } from "../events/catalog.js";
import {
  classifyCalendarChange,
  normalizeGoogleCalendarEvent,
  type CalendarChangeClass,
} from "./change-detection.js";
import {
  getCalendarEvent,
  getCalendarSyncState,
  upsertCalendarEvent,
  upsertCalendarSyncState,
} from "./projection.js";

/** Structural port: what syncCalendar needs from a calendar SourceAdapter. */
export interface CalendarSourcePort {
  readonly id: string;
  readonly calendarId: string;
  listEvents(opts: {
    readonly syncToken?: string;
    readonly pageToken?: string;
  }): Promise<{
    readonly events: readonly GoogleCalendarEvent[];
    readonly nextPageToken: string | null;
    readonly nextSyncToken: string | null;
  }>;
}

/** Observation types by change class (catalog v1 additive members). */
const EVENT_TYPE_BY_CLASS: Readonly<Record<string, "calendar.event.created" | "calendar.event.updated" | "calendar.event.cancelled">> = {
  created: "calendar.event.created",
  cancelled: "calendar.event.cancelled",
  start_end_changed: "calendar.event.updated",
  attendees_changed: "calendar.event.updated",
  updated: "calendar.event.updated",
};

export interface CalendarSyncChange {
  readonly changeClass: Exclude<CalendarChangeClass, "unchanged">;
  readonly googleEventId: string;
  /** The observation event id minted for this change. */
  readonly eventId: string;
  /** False when this was a redelivery deduped by externalId (acceptEvent no-op). */
  readonly accepted: boolean;
}

export interface CalendarSyncReport {
  readonly changes: readonly CalendarSyncChange[];
  readonly nextSyncToken: string | null;
  /** True when a 410 forced a full resync this run. */
  readonly fullResync: boolean;
}

/** The calendar sensor is v1 personal-domain only (owner spec). */
const CALENDAR_DOMAIN_KEY = "personal";

async function fetchAllPages(
  source: CalendarSourcePort,
  syncToken: string | undefined,
): Promise<{ events: GoogleCalendarEvent[]; nextSyncToken: string | null; pageCount: number }> {
  const events: GoogleCalendarEvent[] = [];
  let nextSyncToken: string | null = null;
  let pageCount = 0;
  let pageToken: string | undefined;
  do {
    const page = await source.listEvents({ syncToken, pageToken });
    pageCount += 1;
    events.push(...page.events);
    if (page.nextSyncToken !== null) nextSyncToken = page.nextSyncToken;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken !== undefined);
  return { events, nextSyncToken, pageCount };
}

/**
 * Runs one sync pass. Reads (and persists) the calendar_sync_state cursor;
 * emits one observation event + one projection upsert per detected change;
 * returns the change report. Safe to re-run: identical input produces zero
 * new events.
 */
export async function syncCalendar(
  db: EventStoreExecutor,
  source: CalendarSourcePort,
  opts: { now?: () => Date } = {},
): Promise<CalendarSyncReport> {
  const now = opts.now?.() ?? new Date();

  const state = await getCalendarSyncState(db);
  // A cursor for a different calendar is not a valid token for this one (v1:
  // one calendar); it degrades to a full sync rather than a wrong delta.
  let syncToken: string | undefined =
    state !== null && state.calendarId === source.calendarId && state.syncToken !== null
      ? state.syncToken
      : undefined;

  let fullResync = false;
  let pages: { events: GoogleCalendarEvent[]; nextSyncToken: string | null; pageCount: number };
  for (let attempt = 0; ; attempt += 1) {
    try {
      pages = await fetchAllPages(source, syncToken);
      break;
    } catch (err) {
      if (err instanceof GoogleSyncTokenExpiredError && syncToken !== undefined && attempt === 0) {
        fullResync = true;
        syncToken = undefined;
        continue;
      }
      throw err;
    }
  }

  const changes: CalendarSyncChange[] = [];
  for (const raw of pages.events) {
    const incoming = normalizeGoogleCalendarEvent(raw);
    const existing = await getCalendarEvent(db, source.calendarId, incoming.googleEventId);
    const classification = classifyCalendarChange(existing, incoming);
    if (classification.changeClass === "unchanged") continue;

    const occurredAt = incoming.googleUpdated ?? now.toISOString();
    const externalId = `${source.calendarId}:${incoming.iCalUid ?? incoming.googleEventId}:${incoming.googleUpdated ?? incoming.contentHash}`;
    const payload: Record<string, unknown> = {
      changeClass: classification.changeClass,
      googleEventId: incoming.googleEventId,
      calendarId: source.calendarId,
      status: incoming.status,
      summary: incoming.summary,
      start: incoming.start,
      end: incoming.end,
      timezone: incoming.timezone,
      attendees: incoming.attendees,
      location: incoming.location,
    };
    if (classification.changeClass === "start_end_changed" || classification.changeClass === "cancelled") {
      payload.previousStart = classification.previousStart;
      payload.previousEnd = classification.previousEnd;
    }

    const accepted = await acceptEvent(db, {
      type: EVENT_TYPE_BY_CLASS[classification.changeClass]!,
      schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
      source: source.id,
      externalId,
      occurredAt,
      domainId: CALENDAR_DOMAIN_KEY,
      sensitivity: "normal",
      payload,
      runId: null,
    }, { now: () => now });

    await upsertCalendarEvent(db, source.calendarId, incoming, accepted.envelope.id);
    changes.push({
      changeClass: classification.changeClass,
      googleEventId: incoming.googleEventId,
      eventId: accepted.envelope.id,
      accepted: accepted.accepted,
    });
  }

  await upsertCalendarSyncState(db, {
    calendarId: source.calendarId,
    syncToken: pages.nextSyncToken,
    lastSyncedAt: now,
    lastPageCount: pages.pageCount,
  });

  return { changes, nextSyncToken: pages.nextSyncToken, fullResync };
}
