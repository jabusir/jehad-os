// Calendar sync integration tests (E3) against an isolated migrated
// database: full first sync with provenance links, incremental change
// classes (start move / cancel / attendee add / summary edit), idempotent
// re-sync, 410 full-resync recovery, externalId dedupe on replay, and the
// attention wiring (whatChanged sees calendar observations). Needs
// PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GoogleSyncTokenExpiredError, type GoogleCalendarEvent } from "@jehad/adapters";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { whatChanged } from "../queries/changed.js";
import { syncCalendar, type CalendarSourcePort } from "./sync.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-17T12:00:00.000Z");
const now = (): Date => NOW;

interface ScriptedPage {
  readonly events: GoogleCalendarEvent[];
  readonly nextPageToken?: string;
  readonly nextSyncToken?: string;
}

function scriptedSource(
  pages: readonly ScriptedPage[],
  opts: {
    readonly expireSyncTokens?: readonly string[];
    readonly calendarId?: string;
  } = {},
): { source: CalendarSourcePort; calls: { syncToken?: string; pageToken?: string }[] } {
  const queue = [...pages];
  const calls: { syncToken?: string; pageToken?: string }[] = [];
  return {
    calls,
    source: {
      id: "adapter:google-calendar",
      calendarId: opts.calendarId ?? "primary",
      async listEvents(query) {
        calls.push({ syncToken: query.syncToken, pageToken: query.pageToken });
        if (query.syncToken !== undefined && (opts.expireSyncTokens ?? []).includes(query.syncToken)) {
          throw new GoogleSyncTokenExpiredError();
        }
        const page = queue.shift();
        if (page === undefined) throw new Error("scripted source exhausted");
        return {
          events: page.events,
          nextPageToken: page.nextPageToken ?? null,
          nextSyncToken: page.nextSyncToken ?? null,
        };
      },
    },
  };
}

const EVT_A = {
  id: "evt-a-111",
  iCalUID: "evt-a-111@google.com",
  status: "confirmed",
  summary: "Dentist",
  start: { dateTime: "2026-09-17T13:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-09-17T14:00:00Z", timeZone: "UTC" },
  attendees: [{ email: "jejo@example.com", displayName: "Jehad" }],
  location: "12 Creek Rd",
  updated: "2026-09-16T20:01:00.000Z",
} satisfies GoogleCalendarEvent;

const EVT_B = {
  id: "evt-b-222",
  iCalUID: "evt-b-222@google.com",
  status: "confirmed",
  summary: "Team standup",
  start: { dateTime: "2026-09-18T09:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-09-18T09:30:00Z", timeZone: "UTC" },
  attendees: [{ email: "jejo@example.com" }],
  updated: "2026-09-15T08:00:00.000Z",
} satisfies GoogleCalendarEvent;

const EVT_C = {
  id: "evt-c-333",
  iCalUID: "evt-c-333@google.com",
  status: "tentative",
  summary: "Offsite (all day)",
  start: { date: "2026-09-20" },
  end: { date: "2026-09-21" },
  updated: "2026-09-14T10:00:00.000Z",
} satisfies GoogleCalendarEvent;

describe.skipIf(!TEST_DATABASE_URL)("calendar sync (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "e3calsync");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function eventCount(type?: string): Promise<number> {
    const result = await db.pool.query(
      `SELECT count(*)::int AS n FROM events WHERE type = COALESCE($1, type) AND source = 'adapter:google-calendar'`,
      [type ?? null],
    );
    return result.rows[0].n as number;
  }

  it("full first sync: 3 events → 3 calendar.event.created + 3 projection rows + provenance links", async () => {
    const { source, calls } = scriptedSource([
      { events: [EVT_A, EVT_B, EVT_C], nextSyncToken: "tok-1" },
    ]);
    const report = await syncCalendar(db.pool, source, { now });

    expect(report.fullResync).toBe(false);
    expect(report.nextSyncToken).toBe("tok-1");
    expect(report.changes.map((c) => c.changeClass)).toEqual(["created", "created", "created"]);
    expect(report.changes.every((c) => c.accepted)).toBe(true);
    expect(calls).toEqual([{}]); // full sync: no syncToken, no pageToken

    expect(await eventCount("calendar.event.created")).toBe(3);

    const rows = await db.pool.query<{
      google_event_id: string;
      status: string;
      start_time: Date;
      summary: string;
      event_type: string;
      event_source: string;
      event_payload: Record<string, unknown>;
    }>(
      `SELECT ce.google_event_id, ce.status, ce.start_time, ce.summary,
              ev.type AS event_type, ev.source AS event_source, ev.payload AS event_payload
       FROM calendar_events ce JOIN events ev ON ev.id = ce.source_event_id
       ORDER BY ce.google_event_id`,
    );
    expect(rows.rows).toHaveLength(3);
    const a = rows.rows.find((r) => r.google_event_id === "evt-a-111")!;
    expect(a.status).toBe("confirmed");
    expect(a.start_time.toISOString()).toBe("2026-09-17T13:00:00.000Z");
    expect(a.event_type).toBe("calendar.event.created");
    expect(a.event_source).toBe("adapter:google-calendar");
    expect(a.event_payload).toMatchObject({
      changeClass: "created",
      googleEventId: "evt-a-111",
      calendarId: "primary",
      summary: "Dentist",
      start: "2026-09-17T13:00:00.000Z",
      end: "2026-09-17T14:00:00.000Z",
    });
    const c = rows.rows.find((r) => r.google_event_id === "evt-c-333")!;
    expect(c.start_time.toISOString()).toBe("2026-09-20T00:00:00.000Z"); // all-day → UTC midnight

    const state = await db.pool.query(
      `SELECT calendar_id, sync_token, last_page_count FROM calendar_sync_state WHERE id = 1`,
    );
    expect(state.rows[0]).toMatchObject({
      calendar_id: "primary",
      sync_token: "tok-1",
      last_page_count: 1,
    });
  });

  it("incremental: start moved → exactly one calendar.event.updated with start_end_changed + previous times", async () => {
    const before = await eventCount();
    const moved = {
      ...EVT_A,
      start: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-09-17T16:00:00Z", timeZone: "UTC" },
      updated: "2026-09-17T09:00:00.000Z",
    };
    const { source, calls } = scriptedSource([{ events: [moved], nextSyncToken: "tok-2" }]);
    const report = await syncCalendar(db.pool, source, { now });

    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({ changeClass: "start_end_changed", googleEventId: "evt-a-111" });
    expect(calls).toEqual([{ syncToken: "tok-1" }]); // cursor used
    expect(await eventCount()).toBe(before + 1);

    const event = await db.pool.query(
      `SELECT type, payload, occurred_at FROM events WHERE id = $1::uuid`,
      [report.changes[0]!.eventId],
    );
    expect(event.rows[0].type).toBe("calendar.event.updated");
    expect(event.rows[0].occurred_at.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    expect(event.rows[0].payload).toMatchObject({
      changeClass: "start_end_changed",
      previousStart: "2026-09-17T13:00:00.000Z",
      previousEnd: "2026-09-17T14:00:00.000Z",
      start: "2026-09-17T15:00:00.000Z",
      end: "2026-09-17T16:00:00.000Z",
    });

    const row = await db.pool.query(
      `SELECT ce.start_time, ce.source_event_id FROM calendar_events ce
       WHERE ce.google_event_id = 'evt-a-111'`,
    );
    expect(row.rows[0].start_time.toISOString()).toBe("2026-09-17T15:00:00.000Z");
    expect(String(row.rows[0].source_event_id)).toBe(report.changes[0]!.eventId); // new provenance
  });

  it("cancelled → calendar.event.cancelled + projection status cancelled + previous times retained in the observation", async () => {
    const cancelled = { id: EVT_A.id, iCalUID: EVT_A.iCalUID, status: "cancelled", updated: "2026-09-17T10:00:00.000Z" };
    const { source } = scriptedSource([{ events: [cancelled], nextSyncToken: "tok-3" }]);
    const report = await syncCalendar(db.pool, source, { now });

    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]!.changeClass).toBe("cancelled");
    const event = await db.pool.query(
      `SELECT type, payload FROM events WHERE id = $1::uuid`,
      [report.changes[0]!.eventId],
    );
    expect(event.rows[0].type).toBe("calendar.event.cancelled");
    expect(event.rows[0].payload).toMatchObject({
      changeClass: "cancelled",
      status: "cancelled",
      previousStart: "2026-09-17T15:00:00.000Z",
      previousEnd: "2026-09-17T16:00:00.000Z",
    });

    const row = await db.pool.query(
      `SELECT status, source_event_id FROM calendar_events WHERE google_event_id = 'evt-a-111'`,
    );
    expect(row.rows[0].status).toBe("cancelled");
    expect(String(row.rows[0].source_event_id)).toBe(report.changes[0]!.eventId);
  });

  it("attendee add → attendees_changed", async () => {
    const withAttendee = {
      ...EVT_B,
      attendees: [{ email: "jejo@example.com" }, { email: "sam@example.com", displayName: "Sam" }],
      updated: "2026-09-17T10:30:00.000Z",
    };
    const { source } = scriptedSource([{ events: [withAttendee], nextSyncToken: "tok-4" }]);
    const report = await syncCalendar(db.pool, source, { now });

    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]!.changeClass).toBe("attendees_changed");
    const event = await db.pool.query(`SELECT type, payload FROM events WHERE id = $1::uuid`, [
      report.changes[0]!.eventId,
    ]);
    expect(event.rows[0].type).toBe("calendar.event.updated");
    expect(event.rows[0].payload.attendees).toEqual([
      { email: "jejo@example.com", name: null },
      { email: "sam@example.com", name: "Sam" },
    ]);
  });

  it("summary-only change → updated (class updated)", async () => {
    const retitled = { ...EVT_C, summary: "Offsite (confirmed date)", updated: "2026-09-17T11:00:00.000Z" };
    const { source } = scriptedSource([{ events: [retitled], nextSyncToken: "tok-5" }]);
    const report = await syncCalendar(db.pool, source, { now });

    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]!.changeClass).toBe("updated");
    const event = await db.pool.query(`SELECT type, payload->>'changeClass' AS cc FROM events WHERE id = $1::uuid`, [
      report.changes[0]!.eventId,
    ]);
    expect(event.rows[0].type).toBe("calendar.event.updated");
    expect(event.rows[0].cc).toBe("updated");
  });

  it("unchanged re-sync → zero new events (idempotent projection refresh only)", async () => {
    const before = await eventCount();
    const cancelledA = { id: EVT_A.id, iCalUID: EVT_A.iCalUID, status: "cancelled", updated: "2026-09-17T10:00:00.000Z" };
    const withAttendeeB = {
      ...EVT_B,
      attendees: [{ email: "jejo@example.com" }, { email: "sam@example.com", displayName: "Sam" }],
      updated: "2026-09-17T10:30:00.000Z",
    };
    const retitledC = { ...EVT_C, summary: "Offsite (confirmed date)", updated: "2026-09-17T11:00:00.000Z" };
    // Full listing with current content — even with bumped `updated` stamps,
    // content-hash equality classifies everything unchanged.
    const bumped = [
      { ...cancelledA, updated: "2026-09-17T12:00:00.000Z" },
      { ...withAttendeeB, updated: "2026-09-17T12:00:00.000Z" },
      { ...retitledC, updated: "2026-09-17T12:00:00.000Z" },
    ];
    const { source } = scriptedSource([{ events: bumped, nextSyncToken: "tok-6" }]);
    const report = await syncCalendar(db.pool, source, { now });

    expect(report.changes).toHaveLength(0);
    expect(await eventCount()).toBe(before);
  });

  it("410 token expiry → full resync, changes re-derived, no duplicate semantic effects", async () => {
    const before = await eventCount();
    const cancelledA = { id: EVT_A.id, iCalUID: EVT_A.iCalUID, status: "cancelled", updated: "2026-09-17T10:00:00.000Z" };
    const withAttendeeB = {
      ...EVT_B,
      attendees: [{ email: "jejo@example.com" }, { email: "sam@example.com", displayName: "Sam" }],
      updated: "2026-09-17T10:30:00.000Z",
    };
    const retitledC = { ...EVT_C, summary: "Offsite (confirmed date)", updated: "2026-09-17T11:00:00.000Z" };
    const current = [cancelledA, withAttendeeB, retitledC];

    const { source, calls } = scriptedSource([{ events: current, nextSyncToken: "tok-7" }], {
      expireSyncTokens: ["tok-6"],
    });
    const report = await syncCalendar(db.pool, source, { now });

    expect(report.fullResync).toBe(true);
    expect(report.changes).toHaveLength(0); // identical content → unchanged everywhere
    expect(report.nextSyncToken).toBe("tok-7");
    expect(calls).toEqual([{ syncToken: "tok-6" }, {}]); // 410 → cleared-token full sync
    expect(await eventCount()).toBe(before);

    const state = await db.pool.query(`SELECT sync_token FROM calendar_sync_state WHERE id = 1`);
    expect(state.rows[0].sync_token).toBe("tok-7");
  });

  it("idempotent replay of the same batch → no new events (externalId dedupe via acceptEvent)", async () => {
    const before = await eventCount();

    // Simulate a crash between acceptEvent and the projection upsert: revert
    // evt-a-111 to its pre-cancelled projection state, then redeliver the
    // SAME cancelled occurrence (identical `updated` stamp → same externalId).
    const revert = await db.pool.query(
      `UPDATE calendar_events
       SET status = 'confirmed',
           start_time = '2026-09-17T15:00:00Z',
           end_time = '2026-09-17T16:00:00Z',
           content_hash = 'reverted-not-important'
       WHERE google_event_id = 'evt-a-111'
       RETURNING id`,
    );
    expect(revert.rows).toHaveLength(1);

    const cancelledAgain = {
      id: EVT_A.id,
      iCalUID: EVT_A.iCalUID,
      status: "cancelled",
      updated: "2026-09-17T10:00:00.000Z", // identical occurrence → identical externalId
    };
    const { source } = scriptedSource([{ events: [cancelledAgain], nextSyncToken: "tok-8" }]);
    const report = await syncCalendar(db.pool, source, { now });

    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]!.changeClass).toBe("cancelled");
    expect(report.changes[0]!.accepted).toBe(false); // deduped redelivery
    expect(await eventCount()).toBe(before); // no new event rows

    const row = await db.pool.query(
      `SELECT status FROM calendar_events WHERE google_event_id = 'evt-a-111'`,
    );
    expect(row.rows[0].status).toBe("cancelled"); // projection converged again
  });

  it("pages a multi-page calendar and records the page count", async () => {
    const { source, calls } = scriptedSource(
      [
        { events: [], nextPageToken: "page-2" },
        { events: [], nextSyncToken: "tok-9" },
      ],
      { calendarId: "other-calendar" }, // cursor mismatch → full sync through both pages
    );
    const report = await syncCalendar(db.pool, source, { now });
    expect(report.nextSyncToken).toBe("tok-9");
    expect(calls).toEqual([{}, { pageToken: "page-2" }]);
    const state = await db.pool.query(
      `SELECT calendar_id, last_page_count FROM calendar_sync_state WHERE id = 1`,
    );
    expect(state.rows[0]).toMatchObject({ calendar_id: "other-calendar", last_page_count: 2 });
  });

  it("attention wiring: calendar observations surface in whatChanged with no extra wiring", async () => {
    const result = await whatChanged(db.pool, {
      since: "2026-09-16T00:00:00.000Z",
      domainId: "personal",
    });
    const calendarGroups = result.eventGroups.filter((g) => g.type.startsWith("calendar.event."));
    const counts = new Map(calendarGroups.map((g) => [g.type, g.count]));
    expect(counts.get("calendar.event.created")).toBe(3);
    expect(counts.get("calendar.event.updated")).toBe(3); // start_end_changed + attendees_changed + updated
    expect(counts.get("calendar.event.cancelled")).toBe(1);
    for (const group of calendarGroups) {
      for (const event of group.events) {
        expect(event.source).toBe("adapter:google-calendar");
        expect(event.domainKey).toBe("personal");
      }
    }
  });
});
