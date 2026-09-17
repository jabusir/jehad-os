/**
 * Calendar change detection (E3) — pure normalization + classification of
 * Google Calendar events against the calendar_events projection. No DB, no
 * clock: everything here is a deterministic function of (existing row,
 * incoming Google event), so tests pin the full change matrix.
 *
 * Change classes (owner spec): created (no row) | cancelled (status flip to
 * cancelled) | start_end_changed | attendees_changed (attendee set/name
 * diff) | updated (any other projected field) | unchanged (content_hash
 * equal — skip). Class priority follows that order; a start move dominates
 * a summary edit.
 *
 * Content hash: sha256 over a canonical (key-sorted, attendee-sorted) JSON
 * projection of exactly the stored fields — status, summary, start/end ISO
 * instants, timezone, attendees (emails+names only), location, metadata.
 * Google's `updated` timestamp is deliberately NOT hashed (it lives in the
 * observation externalId) so Google-side touches of fields we strip (e.g.
 * attendee responseStatus) classify as unchanged, never as noise events.
 *
 * Time semantics: calendar-native structured time is the trusted tier
 * (date-trust policy: resolutionMethod calendar-native). dateTime values
 * normalize to UTC ISO instants; all-day events (date only, no dateTime)
 * land as UTC midnight of that date — the calendar-native instant Google
 * gives us, stored as-is.
 */

import { createHash } from "node:crypto";
import type { GoogleCalendarEvent } from "@jehad/adapters";

export type CalendarChangeClass =
  | "created"
  | "cancelled"
  | "start_end_changed"
  | "attendees_changed"
  | "updated"
  | "unchanged";

export type CalendarStatus = "confirmed" | "tentative" | "cancelled";

export interface CalendarAttendee {
  /** Emails+names ONLY — response metadata is never stored (owner spec). */
  readonly email: string;
  readonly name: string | null;
}

/** Sparse meeting facts retained for provenance; no bodies, no blobs. */
export interface CalendarEventMetadata {
  readonly recurring: boolean;
  readonly hangoutLink: string | null;
  readonly iCalUid: string | null;
}

/** A Google event normalized into exactly the projection's vocabulary. */
export interface NormalizedCalendarEvent {
  readonly googleEventId: string;
  readonly iCalUid: string | null;
  readonly status: CalendarStatus;
  readonly summary: string;
  /** UTC ISO instant; all-day events are UTC midnight; null when Google omits it (minimal cancelled payloads). */
  readonly start: string | null;
  readonly end: string | null;
  readonly timezone: string | null;
  readonly attendees: readonly CalendarAttendee[];
  readonly location: string | null;
  readonly metadata: CalendarEventMetadata;
  /** RFC 3339 `updated` — feeds observation occurredAt/externalId; not hashed. */
  readonly googleUpdated: string | null;
  readonly contentHash: string;
}

/** The comparable slice of a stored calendar_events row. */
export interface CalendarProjectionSnapshot {
  readonly status: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly attendees: unknown;
  readonly contentHash: string;
}

export interface CalendarChangeClassification {
  readonly changeClass: CalendarChangeClass;
  readonly previousStart: string | null;
  readonly previousEnd: string | null;
}

/** Deterministic JSON: object keys sorted, undefined dropped, arrays order-preserved. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toIsoInstant(dateTime: string | undefined, date: string | undefined): string | null {
  const raw = dateTime ?? (date !== undefined ? `${date}T00:00:00.000Z` : undefined);
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeStatus(status: string | undefined): CalendarStatus {
  return status === "cancelled" || status === "tentative" || status === "confirmed"
    ? status
    : "confirmed";
}

function normalizeAttendees(
  attendees: readonly { readonly email?: string; readonly displayName?: string }[] | undefined,
): CalendarAttendee[] {
  if (!Array.isArray(attendees)) return [];
  const normalized: CalendarAttendee[] = [];
  for (const attendee of attendees) {
    if (typeof attendee?.email !== "string" || attendee.email.length === 0) continue;
    normalized.push({
      email: attendee.email,
      name: typeof attendee.displayName === "string" && attendee.displayName.length > 0
        ? attendee.displayName
        : null,
    });
  }
  normalized.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : (a.name ?? "") < (b.name ?? "") ? -1 : 1));
  return normalized;
}

/** sha256 over the canonical projected content — change detection anchor. */
export function calendarContentHash(content: {
  readonly status: CalendarStatus;
  readonly summary: string;
  readonly start: string | null;
  readonly end: string | null;
  readonly timezone: string | null;
  readonly attendees: readonly CalendarAttendee[];
  readonly location: string | null;
  readonly metadata: CalendarEventMetadata;
}): string {
  const canonical = stableStringify({
    status: content.status,
    summary: content.summary,
    start: content.start,
    end: content.end,
    timezone: content.timezone,
    attendees: content.attendees,
    location: content.location,
    metadata: content.metadata,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Normalizes one raw Google Calendar API event resource. Malformed items
 * (missing id) are the adapter's job to drop; this throws TypeError on a
 * missing id as a last-resort guard.
 */
export function normalizeGoogleCalendarEvent(raw: GoogleCalendarEvent): NormalizedCalendarEvent {
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new TypeError("calendar: google event resource must carry a non-empty id");
  }
  const status = normalizeStatus(raw.status);
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  const start = toIsoInstant(raw.start?.dateTime, raw.start?.date);
  const end = toIsoInstant(raw.end?.dateTime, raw.end?.date);
  const timezone = raw.timeZone ?? raw.start?.timeZone ?? null;
  const attendees = normalizeAttendees(raw.attendees);
  const location = typeof raw.location === "string" && raw.location.length > 0 ? raw.location : null;
  const metadata: CalendarEventMetadata = {
    recurring: Array.isArray(raw.recurrence) && raw.recurrence.length > 0,
    hangoutLink: typeof raw.hangoutLink === "string" && raw.hangoutLink.length > 0 ? raw.hangoutLink : null,
    iCalUid: typeof raw.iCalUID === "string" && raw.iCalUID.length > 0 ? raw.iCalUID : null,
  };
  const googleUpdated = toIsoInstant(raw.updated, undefined);
  return {
    googleEventId: raw.id,
    iCalUid: metadata.iCalUid,
    status,
    summary,
    start,
    end,
    timezone,
    attendees,
    location,
    metadata,
    googleUpdated,
    contentHash: calendarContentHash({ status, summary, start, end, timezone, attendees, location, metadata }),
  };
}

/**
 * Classifies one incoming event against the stored projection. Pure; the
 * sync layer turns non-unchanged classes into observation events + upserts.
 */
export function classifyCalendarChange(
  existing: CalendarProjectionSnapshot | null,
  incoming: NormalizedCalendarEvent,
): CalendarChangeClassification {
  if (existing === null) {
    return { changeClass: "created", previousStart: null, previousEnd: null };
  }
  const previousStart = existing.startTime;
  const previousEnd = existing.endTime;
  if (existing.contentHash === incoming.contentHash) {
    return { changeClass: "unchanged", previousStart, previousEnd };
  }
  if (incoming.status === "cancelled" && existing.status !== "cancelled") {
    return { changeClass: "cancelled", previousStart, previousEnd };
  }
  if (incoming.start !== existing.startTime || incoming.end !== existing.endTime) {
    return { changeClass: "start_end_changed", previousStart, previousEnd };
  }
  if (stableStringify(existing.attendees) !== stableStringify(incoming.attendees)) {
    return { changeClass: "attendees_changed", previousStart, previousEnd };
  }
  return { changeClass: "updated", previousStart, previousEnd };
}
