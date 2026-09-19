/**
 * Google Calendar SourceAdapter (E3; plan §4 ports, §8 event model) — a
 * READ-ONLY sensor. The only remote operation is GET events.list (full sync
 * without a syncToken, incremental with one); there is deliberately no
 * create/update/delete path toward Google — Calendar remains authoritative
 * for the calendar event itself.
 *
 * Transport is plain fetch (no SDK, no new deps; ADR-0002 vendor isolation):
 * https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events with
 * `showDeleted=true` so cancellations arrive, paging via pageToken, and
 * incremental change feeds via syncToken. A 410 GONE response means the
 * stored token expired (too far behind / calendar changed) and surfaces as
 * GoogleSyncTokenExpiredError — the sync core answers with a full resync.
 *
 * Token provisioning is the operator's concern (no OAuth flow here):
 * envOrKeychainTokenProvider() reads GCALENDAR_ACCESS_TOKEN first, else the
 * `jehad-gcalendar` Keychain item — see infra/calendar/README.md.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GOOGLE_CALENDAR_SOURCE = "adapter:google-calendar";

const EVENTS_URL_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/** The adapter's own private view of a Google Calendar API event resource. */
export interface GoogleCalendarEvent {
  readonly id: string;
  readonly iCalUID?: string;
  readonly status?: "confirmed" | "tentative" | "cancelled";
  readonly summary?: string;
  readonly start?: { readonly dateTime?: string; readonly date?: string; readonly timeZone?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string; readonly timeZone?: string };
  readonly attendees?: readonly {
    readonly email: string;
    readonly displayName?: string;
  }[];
  readonly location?: string;
  readonly hangoutLink?: string;
  readonly recurrence?: readonly string[];
  readonly timeZone?: string;
  /** RFC 3339 — when Google last changed this event; feeds the observation occurredAt. */
  readonly updated?: string;
}

export interface GoogleCalendarListResult {
  readonly events: GoogleCalendarEvent[];
  readonly nextPageToken: string | null;
  /** Present only on the last page; persists as the sync cursor. */
  readonly nextSyncToken: string | null;
}

/** 410 GONE — the syncToken is no longer valid; caller must full-resync. */
export class GoogleSyncTokenExpiredError extends Error {
  constructor(message = "google-calendar sync token expired (HTTP 410); full resync required") {
    super(message);
    this.name = "GoogleSyncTokenExpiredError";
  }
}

export class GoogleCalendarApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`google-calendar API error ${status}: ${body.slice(0, 300)}`);
    this.name = "GoogleCalendarApiError";
  }
}

export type FetchLike = (input: string, init?: { readonly method?: string; readonly headers?: Record<string, string> }) => Promise<Response>;

export interface GoogleCalendarSource {
  /** Source string for observations normalized from this adapter. */
  readonly id: string;
  readonly calendarId: string;
  /**
   * One events.list call: full sync when syncToken is omitted, incremental
   * when present. Pages beyond the first pass pageToken (with syncToken).
   */
  listEvents(opts: { readonly syncToken?: string; readonly pageToken?: string }): Promise<GoogleCalendarListResult>;
}

export function createGoogleCalendarSource(opts: {
  readonly tokenProvider: () => Promise<string> | string;
  readonly calendarId: string;
  readonly fetchImpl?: FetchLike;
}): GoogleCalendarSource {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof opts.calendarId !== "string" || opts.calendarId.trim().length === 0) {
    throw new TypeError("google-calendar: calendarId must be a non-empty string");
  }

  return {
    id: GOOGLE_CALENDAR_SOURCE,
    calendarId: opts.calendarId,

    async listEvents({ syncToken, pageToken }: { syncToken?: string; pageToken?: string }) {
      const params = new URLSearchParams({ showDeleted: "true" });
      if (syncToken !== undefined) params.set("syncToken", syncToken);
      if (pageToken !== undefined) params.set("pageToken", pageToken);
      const token = await opts.tokenProvider();
      if (typeof token !== "string" || token.trim().length === 0) {
        throw new Error("google-calendar: tokenProvider returned an empty token");
      }
      const url = `${EVENTS_URL_BASE}/${encodeURIComponent(opts.calendarId)}/events?${params.toString()}`;
      const response = await doFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 410) throw new GoogleSyncTokenExpiredError();
      if (!response.ok) {
        throw new GoogleCalendarApiError(response.status, await response.text().catch(() => ""));
      }
      const body = (await response.json()) as {
        items?: unknown;
        nextPageToken?: string;
        nextSyncToken?: string;
      };
      const items = Array.isArray(body.items) ? body.items : [];
      const events: GoogleCalendarEvent[] = [];
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const candidate = item as Partial<GoogleCalendarEvent>;
        if (typeof candidate.id !== "string" || candidate.id.length === 0) continue;
        events.push(candidate as GoogleCalendarEvent);
      }
      return {
        events,
        nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
        nextSyncToken: typeof body.nextSyncToken === "string" ? body.nextSyncToken : null,
      };
    },
  };
}

/**
 * Token provider for dogfooding (no OAuth flow implemented; see
 * infra/calendar/README.md): GCALENDAR_ACCESS_TOKEN env override first (dev),
 * else the `jehad-gcalendar` Keychain item via `security find-generic-password`.
 * The token itself never enters the event log or the database.
 */
export async function envOrKeychainTokenProvider(
  keychainService = "jehad-gcalendar",
): Promise<string> {
  const envToken = process.env.GCALENDAR_ACCESS_TOKEN;
  if (typeof envToken === "string" && envToken.trim().length > 0) return envToken.trim();
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      keychainService,
      "-w",
    ]);
    const token = stdout.trim();
    if (token.length === 0) throw new Error("empty keychain value");
    return token;
  } catch {
    throw new Error(
      "google-calendar: no access token — set GCALENDAR_ACCESS_TOKEN or create the " +
        `Keychain item \`${keychainService}\` (infra/calendar/README.md)`,
    );
  }
}
