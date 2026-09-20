// Hermetic google-calendar-write provider tests (Phase H): fetchImpl is
// stubbed exactly like the openrouter / google-calendar read tests — no
// network, no SDK. Pins the honest dispatch contract: definite 4xx → typed
// error; timeout / 5xx / id-less 2xx → ProviderResponseLostError (the
// attempt records UNKNOWN upstream); and NEVER a self-retry (M4B owns
// retries via inherited idempotency keys).

import { describe, expect, it } from "vitest";
import {
  createGoogleCalendarWriteProvider,
  GOOGLE_CALENDAR_EVENT_TIME_ZONE,
  GOOGLE_CALENDAR_WRITE_PROVIDER_ID,
  GoogleCalendarWriteError,
  type WriteFetchLike,
} from "../src/action-providers/google-calendar-write.js";
import {
  ProviderResponseLostError,
  type ProviderDispatchRequest,
} from "../src/action-providers/provider.js";

const TOKEN = "ya29.test-token";

interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(
  handler: (call: Call, signal?: AbortSignal) => Response | Promise<Response>,
): { fetch: WriteFetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      authorization: init?.headers?.["Authorization"],
      body: init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    };
    calls.push(call);
    return handler(call, init?.signal);
  }) as WriteFetchLike;
  return { fetch, calls };
}

const token = (): string => TOKEN;

function dispatchRequest(overrides: Partial<Record<string, unknown>> = {}): ProviderDispatchRequest {
  return {
    intentId: "0a1b2c3d-0000-4000-8000-000000000001",
    capability: "act:google-calendar",
    resource: "calendar:primary",
    payload: {
      action: "calendar_create",
      title: "Dentist",
      startIso: "2026-09-21T16:00:00Z",
      endIso: "2026-09-21T17:00:00Z",
      tentative: true,
      ...overrides,
    },
    idempotencyKey: "idem_123",
  };
}

describe("createGoogleCalendarWriteProvider", () => {
  it("provider id is google-calendar (grant capability act:google-calendar)", () => {
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary" });
    expect(provider.id).toBe(GOOGLE_CALENDAR_WRITE_PROVIDER_ID);
    expect(provider.id).toBe("google-calendar");
  });

  it("happy path: POST events.insert with the exact v1 payload shape; returns the provider event id", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, { id: "evt-abc-001", status: "tentative" }));
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });

    const response = await provider.dispatch(dispatchRequest());

    expect(response).toEqual({ status: "succeeded", providerRef: "evt-abc-001" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toEqual({
      summary: "Dentist",
      status: "tentative",
      start: { dateTime: "2026-09-21T16:00:00Z", timeZone: GOOGLE_CALENDAR_EVENT_TIME_ZONE },
      end: { dateTime: "2026-09-21T17:00:00Z", timeZone: GOOGLE_CALENDAR_EVENT_TIME_ZONE },
      extendedProperties: {
        private: { idempotencyKey: "idem_123", intentId: "0a1b2c3d-0000-4000-8000-000000000001" },
      },
    });
    // timeZone pinned to the owner's civil zone (spec: America/Los_Angeles).
    expect(GOOGLE_CALENDAR_EVENT_TIME_ZONE).toBe("America/Los_Angeles");
    // Conferencing off + contract §5 drops — structurally absent:
    const body = call.body as Record<string, unknown>;
    for (const forbidden of ["conferenceData", "attendees", "recurrence", "description", "location", "reminders"]) {
      expect(body[forbidden]).toBeUndefined();
    }
  });

  it("event details ride when present: location/description map verbatim, guests become [{email}] and get invites (sendUpdates=all)", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, { id: "evt-det-1" }));
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });

    const response = await provider.dispatch(dispatchRequest({
      location: "War Room",
      description: "Quarterly numbers — bring the deck",
      attendees: ["a@b.com", "c@d.com"],
    }));

    expect(response).toEqual({ status: "succeeded", providerRef: "evt-det-1" });
    const call = calls[0]!;
    const body = call.body as Record<string, unknown>;
    expect(body["location"]).toBe("War Room");
    expect(body["description"]).toBe("Quarterly numbers — bring the deck");
    expect(body["attendees"]).toEqual([{ email: "a@b.com" }, { email: "c@d.com" }]);
    // Idempotency stamp + tentative transparency unchanged by the details.
    expect(body["extendedProperties"]).toEqual({
      private: { idempotencyKey: "idem_123", intentId: "0a1b2c3d-0000-4000-8000-000000000001" },
    });
    expect(body["status"]).toBe("tentative");
    // Explicit sendUpdates=all — guests were shown in the confirm render first.
    expect(new URL(call.url).searchParams.get("sendUpdates")).toBe("all");
  });

  it("each detail field is independently optional: absent or null → key absent from the body; sendUpdates=all is explicit either way", async () => {
    for (const over of [
      { location: "Somewhere" },
      { description: "Only a note" },
      { attendees: ["solo@x.com"] },
      { location: null, description: null, attendees: null },
    ] as Array<Record<string, unknown>>) {
      const { fetch, calls } = stubFetch(() => jsonResponse(200, { id: "evt-opt" }));
      const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
      await provider.dispatch(dispatchRequest(over));
      const body = calls[0]!.body as Record<string, unknown>;
      expect(body["location"], JSON.stringify(over)).toEqual(over.location ?? undefined);
      expect(body["description"], JSON.stringify(over)).toEqual(over.description ?? undefined);
      expect(body["attendees"], JSON.stringify(over)).toEqual(
        over.attendees === undefined || over.attendees === null
          ? undefined
          : [{ email: over.attendees[0] }],
      );
      expect(new URL(calls[0]!.url).searchParams.get("sendUpdates"), JSON.stringify(over)).toBe("all");
    }
  });

  it("empty attendee list is omitted from the body (nothing to invite)", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, { id: "evt-empty" }));
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    await provider.dispatch(dispatchRequest({ attendees: [] }));
    expect((calls[0]!.body as Record<string, unknown>)["attendees"]).toBeUndefined();
  });

  it("tentative flag maps both ways (ESCALATE-2 default: tentative)", async () => {
    for (const [tentative, status] of [[true, "tentative"], [false, "confirmed"]] as const) {
      const { fetch, calls } = stubFetch(() => jsonResponse(200, { id: "evt-x" }));
      const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
      await provider.dispatch(dispatchRequest({ tentative }));
      expect((calls[0]!.body as Record<string, unknown>)["status"]).toBe(status);
    }
  });

  it("4xx definite rejection → typed GoogleCalendarWriteError with the provider's safe message", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(400, { error: { message: "Invalid time zone: X" } }),
    );
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });

    await expect(provider.dispatch(dispatchRequest())).rejects.toBeInstanceOf(GoogleCalendarWriteError);
    await expect(provider.dispatch(dispatchRequest())).rejects.toThrow(/rejected .*HTTP 400.* Invalid time zone: X/);
  });

  it("timeout after dispatch → ProviderResponseLostError (attempt records UNKNOWN upstream); NEVER retries", async () => {
    let calls = 0;
    const { fetch, calls: log } = stubFetch(() => {
      calls += 1;
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });

    await expect(provider.dispatch(dispatchRequest())).rejects.toBeInstanceOf(ProviderResponseLostError);
    expect(calls).toBe(1); // one write, one call — retries belong to M4B attempts
    expect(log).toHaveLength(1);
  });

  it("5xx is ambiguous (effect may have landed) → ProviderResponseLostError, not failed", async () => {
    const { fetch } = stubFetch(() => jsonResponse(503, {}));
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    await expect(provider.dispatch(dispatchRequest())).rejects.toBeInstanceOf(ProviderResponseLostError);
  });

  it("2xx without an event id cannot certify the effect → ProviderResponseLostError", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, {}));
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    await expect(provider.dispatch(dispatchRequest())).rejects.toBeInstanceOf(ProviderResponseLostError);
  });

  it("malformed intent payload → TypeError (caller bug, attempt fails honestly)", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, { id: "evt-y" }));
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    await expect(provider.dispatch(dispatchRequest({ title: 42 }))).rejects.toBeInstanceOf(TypeError);
    await expect(provider.dispatch(dispatchRequest({ startIso: undefined }))).rejects.toBeInstanceOf(TypeError);
    await expect(provider.dispatch(dispatchRequest({ location: 7 }))).rejects.toBeInstanceOf(TypeError);
    await expect(provider.dispatch(dispatchRequest({ description: {} }))).rejects.toBeInstanceOf(TypeError);
    await expect(provider.dispatch(dispatchRequest({ attendees: "a@b.com" }))).rejects.toBeInstanceOf(TypeError);
    await expect(provider.dispatch(dispatchRequest({ attendees: [1, 2] }))).rejects.toBeInstanceOf(TypeError);
  });

  it("read-back: findEventByIdempotencyKey queries the private extended property and resolves exactly one event", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse(200, { items: [{ id: "evt-found-9" }] }),
    );
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });

    const found = await provider.findEventByIdempotencyKey("idem_123");

    expect(found).toEqual({ eventId: "evt-found-9" });
    expect(calls[0]!.method).toBe("GET");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("privateExtendedProperty")).toBe("idempotencyKey=idem_123");
  });

  it("read-back finds nothing → null", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, { items: [] }));
    const provider = createGoogleCalendarWriteProvider({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    expect(await provider.findEventByIdempotencyKey("idem_never")).toBeNull();
  });
});
