// Hermetic google-calendar adapter tests: stubbed fetch against RECORDED
// realistic events.list fixtures (full sync, paging, incremental, 410 token
// expiry), plus the read-only proof — every issued call is GET on the
// events.list path, and the bearer token comes from the tokenProvider.

import { describe, expect, it } from "vitest";
import {
  createGoogleCalendarSource,
  envOrKeychainTokenProvider,
  GoogleCalendarApiError,
  GoogleSyncTokenExpiredError,
  type FetchLike,
} from "./google-calendar.js";

const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

// Recorded-realistic event resources (shape as returned by calendar/v3).
const EVT_DENTIST = {
  kind: "calendar#event",
  id: "evt-dentist-001",
  iCalUID: "evt-dentist-001@google.com",
  status: "confirmed",
  summary: "Dentist",
  start: { dateTime: "2026-09-18T09:00:00-04:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-09-18T10:00:00-04:00", timeZone: "America/New_York" },
  attendees: [
    { email: "jejo@example.com", displayName: "Jehad", responseStatus: "accepted" },
  ],
  location: "12 Creek Rd",
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  updated: "2026-09-16T20:01:00.000Z",
};

const EVT_STANDUP = {
  kind: "calendar#event",
  id: "evt-standup-002",
  iCalUID: "evt-standup-002@google.com",
  status: "confirmed",
  summary: "Team standup",
  start: { dateTime: "2026-09-18T11:00:00+02:00", timeZone: "Europe/Berlin" },
  end: { dateTime: "2026-09-18T11:30:00+02:00", timeZone: "Europe/Berlin" },
  recurrence: ["RRULE:FREQ=DAILY;COUNT=10"],
  attendees: [
    { email: "jejo@example.com", responseStatus: "accepted" },
    { email: "sam@example.com", displayName: "Sam", responseStatus: "needsAction" },
  ],
  hangoutLink: "https://meet.google.com/xyz-1234",
  updated: "2026-09-15T08:00:00.000Z",
};

const EVT_OFFSITE = {
  kind: "calendar#event",
  id: "evt-offsite-003",
  iCalUID: "evt-offsite-003@google.com",
  status: "tentative",
  summary: "Offsite (all day)",
  start: { date: "2026-09-20" },
  end: { date: "2026-09-21" },
  updated: "2026-09-14T10:00:00.000Z",
};

const EVT_CANCELLED = {
  kind: "calendar#event",
  id: "evt-standup-002",
  status: "cancelled",
  updated: "2026-09-17T07:00:00.000Z",
};

interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(
  handler: (url: string) => Response | Promise<Response>,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      authorization: init?.headers?.["Authorization"],
    });
    return handler(url);
  }) as FetchLike;
  return { fetch, calls };
}

const token = (): string => "ya29.test-token";

describe("createGoogleCalendarSource", () => {
  it("full sync: lists events without syncToken, returns nextSyncToken", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse(200, {
        kind: "calendar#events",
        items: [EVT_DENTIST, EVT_STANDUP, EVT_OFFSITE],
        nextSyncToken: "sync-token-1",
      }),
    );
    const source = createGoogleCalendarSource({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    const result = await source.listEvents({});

    expect(result.events.map((e) => e.id)).toEqual(["evt-dentist-001", "evt-standup-002", "evt-offsite-003"]);
    expect(result.nextPageToken).toBeNull();
    expect(result.nextSyncToken).toBe("sync-token-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BASE}?showDeleted=true`);
    expect(calls[0]!.authorization).toBe("Bearer ya29.test-token");
  });

  it("pages a large calendar via nextPageToken, syncToken only on the last page", async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.includes("pageToken=page-2")) {
        return jsonResponse(200, { items: [EVT_OFFSITE], nextSyncToken: "sync-token-2" });
      }
      return jsonResponse(200, { items: [EVT_DENTIST, EVT_STANDUP], nextPageToken: "page-2" });
    });
    const source = createGoogleCalendarSource({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });

    const first = await source.listEvents({});
    expect(first.nextPageToken).toBe("page-2");
    expect(first.nextSyncToken).toBeNull();

    const second = await source.listEvents({ pageToken: first.nextPageToken! });
    expect(second.events.map((e) => e.id)).toEqual(["evt-offsite-003"]);
    expect(second.nextPageToken).toBeNull();
    expect(second.nextSyncToken).toBe("sync-token-2");
    expect(calls[1]!.url).toBe(`${BASE}?showDeleted=true&pageToken=page-2`);
  });

  it("incremental sync: sends the stored syncToken, gets changed/cancelled items only", async () => {
    const { fetch, calls } = stubFetch((url) => {
      expect(url).toBe(`${BASE}?showDeleted=true&syncToken=sync-token-1`);
      return jsonResponse(200, {
        items: [EVT_DENTIST, EVT_CANCELLED],
        nextSyncToken: "sync-token-3",
      });
    });
    const source = createGoogleCalendarSource({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    const result = await source.listEvents({ syncToken: "sync-token-1" });

    expect(result.events).toHaveLength(2);
    expect(result.events[1]!.status).toBe("cancelled");
    expect(result.nextSyncToken).toBe("sync-token-3");
    expect(calls[0]!.url).toContain("syncToken=sync-token-1");
  });

  it("410 on a stale token raises GoogleSyncTokenExpiredError for the full-resync path", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(410, { error: { code: 410, message: "Sync token is no longer valid" } }),
    );
    const source = createGoogleCalendarSource({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    await expect(source.listEvents({ syncToken: "stale" })).rejects.toBeInstanceOf(GoogleSyncTokenExpiredError);
  });

  it("other non-OK statuses raise GoogleCalendarApiError with the status and body", async () => {
    const { fetch } = stubFetch(() => jsonResponse(401, { error: { message: "Invalid Credentials" } }));
    const source = createGoogleCalendarSource({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    await expect(source.listEvents({})).rejects.toMatchObject({
      name: "GoogleCalendarApiError",
      status: 401,
    } satisfies Partial<GoogleCalendarApiError>);
  });

  it("skips malformed items instead of failing the page", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(200, { items: [{ kind: "calendar#event" }, EVT_DENTIST, "junk"], nextSyncToken: "t" }),
    );
    const source = createGoogleCalendarSource({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    const result = await source.listEvents({});
    expect(result.events.map((e) => e.id)).toEqual(["evt-dentist-001"]);
  });

  it("READ-ONLY: every call across full+paged+incremental flows is GET on the events.list path", async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.includes("pageToken=")) {
        return jsonResponse(200, { items: [EVT_OFFSITE], nextSyncToken: "t2" });
      }
      return jsonResponse(200, { items: [EVT_DENTIST], nextPageToken: "p2" });
    });
    const source = createGoogleCalendarSource({ tokenProvider: token, calendarId: "primary", fetchImpl: fetch });
    await source.listEvents({});
    await source.listEvents({ pageToken: "p2" });
    await source.listEvents({ syncToken: "t2" });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.url.startsWith(`${BASE}?`)).toBe(true);
    }
  });

  it("encodes non-trivial calendar ids into the path", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, { items: [] }));
    const source = createGoogleCalendarSource({
      tokenProvider: token,
      calendarId: "jejo@example.com",
      fetchImpl: fetch,
    });
    await source.listEvents({});
    expect(
      calls[0]!.url.startsWith(
        "https://www.googleapis.com/calendar/v3/calendars/jejo%40example.com/events?",
      ),
    ).toBe(true);
  });

  it("rejects an empty token from the provider", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, { items: [] }));
    const source = createGoogleCalendarSource({ tokenProvider: () => "  ", calendarId: "primary", fetchImpl: fetch });
    await expect(source.listEvents({})).rejects.toThrow(/empty token/);
    expect(source.id).toBe("adapter:google-calendar");
  });

  it("requires a non-empty calendarId", () => {
    expect(() =>
      createGoogleCalendarSource({ tokenProvider: token, calendarId: "  ", fetchImpl: (async () => new Response()) as FetchLike }),
    ).toThrow(TypeError);
  });
});

describe("envOrKeychainTokenProvider", () => {
  it("GCALENDAR_ACCESS_TOKEN env wins (dev override)", async () => {
    process.env.GCALENDAR_ACCESS_TOKEN = "env-token-123";
    try {
      await expect(envOrKeychainTokenProvider()).resolves.toBe("env-token-123");
    } finally {
      delete process.env.GCALENDAR_ACCESS_TOKEN;
    }
  });

  it("throws a bootstrap-pointer error when neither env nor Keychain item exists", async () => {
    const prev = process.env.GCALENDAR_ACCESS_TOKEN;
    delete process.env.GCALENDAR_ACCESS_TOKEN;
    try {
      await expect(envOrKeychainTokenProvider()).rejects.toThrow(/jehad-gcalendar/);
    } finally {
      if (prev !== undefined) process.env.GCALENDAR_ACCESS_TOKEN = prev;
    }
  });
});
