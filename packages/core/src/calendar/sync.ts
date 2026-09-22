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
import { enqueueCalendarChangeNotification } from "../notifications/service.js";
import type { NotificationsConfig } from "../notifications/config.js";

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

/**
 * E4-S noise gate: calendar-change notifications fire only for disruptive
 * changes (start_end_changed | cancelled) whose (new OR previous) start falls
 * within the NEXT 48 hours. Created/updated changes ride the morning brief
 * instead — this window IS the disruption filter.
 */
export const CALENDAR_CHANGE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** True when the ISO instant is strictly after `now` and at most now+48h. */
export function isWithinNext48h(start: string | null, now: Date): boolean {
  if (start === null) return false;
  const instant = Date.parse(start);
  if (Number.isNaN(instant)) return false;
  return instant > now.getTime() && instant <= now.getTime() + CALENDAR_CHANGE_WINDOW_MS;
}

/** Title instant format: `2026-09-18 09:00 UTC` (deterministic, iMessage-friendly). */
function formatInstantForTitle(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** `${summary}: moved to X` | `${summary}: cancelled` — the delivery title. */
export function calendarChangeNotificationTitle(
  summary: string,
  changeClass: "start_end_changed" | "cancelled",
  newStart: string | null,
): string {
  const subject = summary.length > 0 ? summary : "(untitled event)";
  if (changeClass === "cancelled") return `${subject}: cancelled`;
  if (newStart === null) return `${subject}: rescheduled`;
  return `${subject}: moved to ${formatInstantForTitle(newStart)}`;
}

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

export interface CalendarSyncOptions {
  /** Injection point for tests / determinism; defaults to new Date(). */
  readonly now?: () => Date;
  /**
   * E4-S: enqueue kind=calendar-change notifications for disruptive
   * near-term changes (start_end_changed|cancelled within the next 48h).
   * Default false — tests and non-notifying callers stay quiet.
   */
  readonly notify?: boolean;
  /**
   * Test-only override of the notification policy. Production never passes
   * this — enqueueCalendarChangeNotification loads the repo-root policy.yaml
   * itself, so the workflow path is always policy-governed.
   */
  readonly notificationConfig?: NotificationsConfig;
}

/**
 * Runs one sync pass. Reads (and persists) the calendar_sync_state cursor;
 * emits one observation event + one projection upsert per detected change;
 * returns the change report. Safe to re-run: identical input produces zero
 * new events. With opts.notify, disruptive near-term changes additionally
 * enqueue a kind=calendar-change notification (48h filter; see
 * isWithinNext48h) — only for ACCEPTED events, so a redelivered batch
 * (externalId dedupe) never double-notifies.
 */
export async function syncCalendar(
  db: EventStoreExecutor,
  source: CalendarSourcePort,
  opts: CalendarSyncOptions = {},
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

    // E4-S producer: disruptive near-term schedule changes reach the owner
    // without waiting for the morning brief. Noise gate = change class
    // (start_end_changed|cancelled ONLY) + the 48h window below; deduped
    // redeliveries (accepted === false) never re-notify.
    if (
      opts.notify === true &&
      accepted.accepted &&
      (classification.changeClass === "start_end_changed" ||
        classification.changeClass === "cancelled")
    ) {
      const relevantStarts =
        classification.changeClass === "start_end_changed"
          ? [incoming.start, classification.previousStart]
          : [classification.previousStart, incoming.start];
      if (relevantStarts.some((start) => isWithinNext48h(start, now))) {
        // Minimal cancelled payloads strip summary — fall back to the
        // projection's previous summary so titles stay human.
        const summary =
          incoming.summary.length > 0 ? incoming.summary : (existing?.summary ?? "");
        await enqueueCalendarChangeNotification(db, {
          title: calendarChangeNotificationTitle(
            summary,
            classification.changeClass,
            incoming.start,
          ),
          change: {
            changeClass: classification.changeClass,
            summary,
            start: incoming.start,
            end: incoming.end,
            previousStart: classification.previousStart,
            previousEnd: classification.previousEnd,
          },
          provenance: {
            eventId: accepted.envelope.id,
            googleEventId: incoming.googleEventId,
            calendarId: source.calendarId,
          },
          domainKey: CALENDAR_DOMAIN_KEY,
          config: opts.notificationConfig,
          now: () => now,
        });
      }
    }
  }

  await upsertCalendarSyncState(db, {
    calendarId: source.calendarId,
    syncToken: pages.nextSyncToken,
    lastSyncedAt: now,
    lastPageCount: pages.pageCount,
  });

  return { changes, nextSyncToken: pages.nextSyncToken, fullResync };
}
