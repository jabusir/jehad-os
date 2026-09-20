/**
 * Google Calendar WRITE ActionProvider (Phase H;
 * docs/plans/ig-phase-h-contracts.md §1–§3) — the first real external
 * side-effect provider. Exactly ONE operation: events.insert on the owner's
 * primary calendar. Deletes, modifications, recurrence are permanently
 * not-now for v1 (contract §10); the event-details lane adds optional
 * location/description/attendees to the SAME single operation.
 *
 * Honesty contract (ADR-0011 T13): this provider NEVER retries a write —
 * the M4B attempt machinery owns retries (idempotency keys are inherited
 * across attempts). A transport failure or ambiguous response after the
 * POST was issued throws ProviderResponseLostError so the attempt records
 * outcome `unknown` until read-back reconciliation. A definite 4xx
 * rejection (no effect happened) throws GoogleCalendarWriteError → attempt
 * `failed`. A 5xx is NOT a definite rejection (the effect may have landed
 * before the error) → ProviderResponseLostError → `unknown`.
 *
 * Transport is plain fetch, no SDK (ADR-0002 vendor isolation); the token
 * provider rides the same E3 Google credential seam
 * (envOrKeychainTokenProvider — infra/calendar/README.md).
 */

import {
  ProviderResponseLostError,
  type ActionProvider,
  type ProviderDispatchRequest,
  type ProviderDispatchResponse,
} from "./provider.js";

export const GOOGLE_CALENDAR_WRITE_PROVIDER_ID = "google-calendar";

const EVENTS_URL_BASE = "https://www.googleapis.com/calendar/v3/calendars";
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Civil timezone stamped on event start/end — matches the control plane's
 * BRIEF_TIMEZONE (America/Los_Angeles); dates resolve server-side only
 * (contract §3 step 4).
 */
export const GOOGLE_CALENDAR_EVENT_TIME_ZONE = "America/Los_Angeles";

/** Definite provider rejection (4xx) — no effect happened; maps to `failed`. */
export class GoogleCalendarWriteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GoogleCalendarWriteError";
    this.status = status;
  }
}

export type WriteFetchLike = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;

/** The single v1 write operation's input (contract §4 payload table). */
export interface CalendarEventInput {
  readonly title: string;
  readonly startIso: string;
  readonly endIso: string;
  /** ESCALATE-2 default: agent-created events insert as `tentative`. */
  readonly tentative: boolean;
  /** Optional event details (event-details lane) — sent only when present. */
  readonly location?: string;
  readonly description?: string;
  /** Guest emails — dispatched verbatim; invites go out (sendUpdates=all). */
  readonly attendees?: readonly string[];
  readonly intentId: string;
  readonly idempotencyKey: string;
}

/**
 * Read-back seam for reconciliation (contract §3 step 9): every created
 * event carries `extendedProperties.private.idempotencyKey`, so a lookup
 * by that private property resolves an ambiguous attempt to exactly one
 * event. Returns the provider event id, or null when none exists.
 */
export interface GoogleCalendarWriteProvider extends ActionProvider {
  readonly id: typeof GOOGLE_CALENDAR_WRITE_PROVIDER_ID;
  createEvent(input: CalendarEventInput): Promise<{ readonly eventId: string }>;
  findEventByIdempotencyKey(idempotencyKey: string): Promise<{ readonly eventId: string } | null>;
}

export interface GoogleCalendarWriteProviderOptions {
  readonly tokenProvider: () => Promise<string> | string;
  readonly calendarId: string;
  readonly fetchImpl?: WriteFetchLike;
  readonly timeoutMs?: number;
  readonly timeZone?: string;
}

/** Only the provider's own error.message is surfaced — never the raw body. */
function safeProviderMessage(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // unparseable body — nothing safe to surface
  }
  return undefined;
}

function toLost(cause: unknown, what: string): ProviderResponseLostError {
  const name = cause instanceof Error ? cause.name : "unknown error";
  return new ProviderResponseLostError(
    `google-calendar write ${what} — the effect may or may not have happened (${name})`,
  );
}

export function createGoogleCalendarWriteProvider(
  opts: GoogleCalendarWriteProviderOptions,
): GoogleCalendarWriteProvider {
  if (typeof opts.calendarId !== "string" || opts.calendarId.trim().length === 0) {
    throw new TypeError("google-calendar-write: calendarId must be a non-empty string");
  }
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as WriteFetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeZone = opts.timeZone ?? GOOGLE_CALENDAR_EVENT_TIME_ZONE;
  const eventsUrl = `${EVENTS_URL_BASE}/${encodeURIComponent(opts.calendarId)}/events`;

  async function resolveToken(): Promise<string> {
    const token = await opts.tokenProvider();
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error("google-calendar-write: tokenProvider returned an empty token");
    }
    return token.trim();
  }

  return {
    id: GOOGLE_CALENDAR_WRITE_PROVIDER_ID,

    async createEvent(input: CalendarEventInput): Promise<{ readonly eventId: string }> {
      const token = await resolveToken();
      // Conferencing off: no conferenceDataVersion param, no conferenceData
      // field — v1 events never create meeting links. Recurrence and
      // reminders remain structurally absent; location/description/attendees
      // ride ONLY when present (event-details lane — guests were already
      // shown verbatim in the confirm render, so sendUpdates=all is
      // explicit: guests get their invites).
      const body = JSON.stringify({
        summary: input.title,
        status: input.tentative ? "tentative" : "confirmed",
        start: { dateTime: input.startIso, timeZone },
        end: { dateTime: input.endIso, timeZone },
        ...(input.location ? { location: input.location } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.attendees && input.attendees.length > 0
          ? { attendees: input.attendees.map((email) => ({ email })) }
          : {}),
        extendedProperties: {
          private: {
            idempotencyKey: input.idempotencyKey,
            intentId: input.intentId,
          },
        },
      });
      let response: Response;
      try {
        response = await doFetch(`${eventsUrl}?sendUpdates=all`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // The POST may have reached Google — never guess; UNKNOWN upstream.
        throw toLost(err, "request failed after dispatch");
      }
      if (response.status >= 400 && response.status < 500) {
        const bodyText = await response.text().catch(() => "");
        throw new GoogleCalendarWriteError(
          response.status,
          `google-calendar events.insert rejected (HTTP ${response.status}): ` +
            (safeProviderMessage(bodyText) ?? "no provider message"),
        );
      }
      if (!response.ok) {
        // 5xx: ambiguous — the insert may have landed before the error.
        throw toLost({ name: `HTTP ${response.status}` }, "returned a server error");
      }
      const parsed = (await response.json().catch(() => null)) as { id?: unknown } | null;
      const eventId = typeof parsed?.id === "string" ? parsed.id : "";
      if (eventId.length === 0) {
        throw new ProviderResponseLostError(
          "google-calendar write returned 2xx without an event id — the effect may have happened; outcome unknown",
        );
      }
      return { eventId };
    },

    async findEventByIdempotencyKey(
      idempotencyKey: string,
    ): Promise<{ readonly eventId: string } | null> {
      const token = await resolveToken();
      const params = new URLSearchParams({
        privateExtendedProperty: `idempotencyKey=${idempotencyKey}`,
        maxResults: "1",
      });
      let response: Response;
      try {
        response = await doFetch(`${eventsUrl}?${params.toString()}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw toLost(err, "read-back lookup failed");
      }
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new GoogleCalendarWriteError(
          response.status,
          `google-calendar events.list read-back failed (HTTP ${response.status}): ` +
            (safeProviderMessage(bodyText) ?? "no provider message"),
        );
      }
      const parsed = (await response.json().catch(() => null)) as { items?: unknown } | null;
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      const first = items[0] as { id?: unknown } | undefined;
      return typeof first?.id === "string" && first.id.length > 0 ? { eventId: first.id } : null;
    },

    async dispatch(request: ProviderDispatchRequest): Promise<ProviderDispatchResponse> {
      const payload = request.payload as Record<string, unknown> | null;
      const title = payload?.["title"];
      const startIso = payload?.["startIso"];
      const endIso = payload?.["endIso"];
      const tentative = payload?.["tentative"];
      const location = payload?.["location"];
      const description = payload?.["description"];
      const attendees = payload?.["attendees"];
      if (
        typeof title !== "string" ||
        typeof startIso !== "string" ||
        typeof endIso !== "string" ||
        typeof tentative !== "boolean"
      ) {
        throw new TypeError(
          "google-calendar-write: intent payload must carry { title, startIso, endIso, tentative }",
        );
      }
      // Optional detail fields: absent/null → omitted; wrong shape → caller bug.
      if (location !== undefined && location !== null && typeof location !== "string") {
        throw new TypeError("google-calendar-write: payload location must be a string when present");
      }
      if (description !== undefined && description !== null && typeof description !== "string") {
        throw new TypeError(
          "google-calendar-write: payload description must be a string when present",
        );
      }
      if (
        attendees !== undefined &&
        attendees !== null &&
        !(Array.isArray(attendees) && attendees.every((a) => typeof a === "string"))
      ) {
        throw new TypeError(
          "google-calendar-write: payload attendees must be an array of email strings when present",
        );
      }
      const { eventId } = await this.createEvent({
        title,
        startIso,
        endIso,
        tentative,
        ...(typeof location === "string" ? { location } : {}),
        ...(typeof description === "string" ? { description } : {}),
        ...(Array.isArray(attendees) ? { attendees: attendees as readonly string[] } : {}),
        intentId: request.intentId,
        idempotencyKey: request.idempotencyKey,
      });
      return { status: "succeeded", providerRef: eventId };
    },
  };
}
