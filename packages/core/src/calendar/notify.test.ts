// Calendar-change notification producer tests (E4-S). Two layers:
//
// 1. PURE unit tests (always run): the 48h window at its boundaries
//    (47h59m in, 48h01m out, exactly-48h in, past out, null out) and the
//    delivery title shapes.
// 2. INTEGRATION (needs TEST_DATABASE_URL, isolated db): the producer hook
//    inside syncCalendar behind opts.notify — disruptive classes only,
//    window-gated, dedupe-safe, auto-approved per policy, silent by default.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import type { NotificationsConfig } from "../notifications/config.js";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import type { GoogleCalendarEvent } from "@jehad/adapters";
import {
  calendarChangeNotificationTitle,
  isWithinNext48h,
  syncCalendar,
  type CalendarSourcePort,
} from "./sync.js";

const NOW = new Date("2026-09-17T12:00:00.000Z");

describe("48h disruptive-change window (pure)", () => {
  const now = NOW;
  it("47h59m ahead is IN; 48h01m ahead is OUT; exactly 48h is IN", () => {
    expect(isWithinNext48h("2026-09-19T11:59:00.000Z", now)).toBe(true); // +47h59m
    expect(isWithinNext48h("2026-09-19T12:01:00.000Z", now)).toBe(false); // +48h01m
    expect(isWithinNext48h("2026-09-19T12:00:00.000Z", now)).toBe(true); // exactly +48h
  });

  it("past or null starts are OUT (the window is the NEXT 48h)", () => {
    expect(isWithinNext48h("2026-09-17T11:59:00.000Z", now)).toBe(false); // 1m ago
    expect(isWithinNext48h(null, now)).toBe(false);
    expect(isWithinNext48h("not-a-date", now)).toBe(false);
  });

  it("titles: moved-to (UTC, readable) and cancelled", () => {
    expect(calendarChangeNotificationTitle("Dentist", "start_end_changed", "2026-09-17T15:00:00.000Z")).toBe(
      "Dentist: moved to 2026-09-17 15:00 UTC",
    );
    expect(calendarChangeNotificationTitle("Dentist", "cancelled", null)).toBe("Dentist: cancelled");
    expect(calendarChangeNotificationTitle("", "cancelled", null)).toBe("(untitled event): cancelled");
  });
});

// ---------------------------------------------------------------- integration

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const CONFIG: NotificationsConfig = {
  autoApproveKinds: ["brief", "calendar-change"],
  escalationMinUrgency: "high",
  defaultTtlMinutes: 240,
};

function event(overrides: Partial<GoogleCalendarEvent> & { id: string }): GoogleCalendarEvent {
  return {
    iCalUID: `${overrides.id}@google.com`,
    status: "confirmed",
    summary: `Event ${overrides.id}`,
    start: { dateTime: "2026-09-17T13:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-09-17T14:00:00Z", timeZone: "UTC" },
    updated: "2026-09-16T20:00:00.000Z",
    ...overrides,
  } as GoogleCalendarEvent;
}

/** Minimal cancelled payload — Google strips times/summary (same shape as E3 tests). */
const cancelOf = (base: GoogleCalendarEvent, updated: string): GoogleCalendarEvent =>
  ({ id: base.id, iCalUID: base.iCalUID, status: "cancelled", updated }) as GoogleCalendarEvent;

function scriptedSource(
  pages: readonly { events: readonly GoogleCalendarEvent[]; nextSyncToken?: string }[],
): CalendarSourcePort {
  const queue = [...pages];
  return {
    id: "adapter:google-calendar",
    calendarId: "primary",
    async listEvents() {
      const page = queue.shift();
      if (page === undefined) throw new Error("scripted source exhausted");
      return {
        events: [...page.events],
        nextPageToken: null,
        nextSyncToken: page.nextSyncToken ?? null,
      };
    },
  };
}

const EVT_SOON = event({ id: "soon", summary: "Dentist", start: { dateTime: "2026-09-17T13:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-17T14:00:00Z", timeZone: "UTC" } });
const EVT_4759 = event({ id: "b4759", summary: "Boundary in", start: { dateTime: "2026-09-19T11:59:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-19T12:59:00Z", timeZone: "UTC" } });
const EVT_4801 = event({ id: "b4801", summary: "Boundary out", start: { dateTime: "2026-09-19T12:01:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-19T13:01:00Z", timeZone: "UTC" } });
const EVT_ALLDAY_TOMORROW = event({ id: "allday-tomorrow", summary: "Offsite tomorrow", start: { date: "2026-09-18" }, end: { date: "2026-09-19" } });
const EVT_ALLDAY_TODAY = event({ id: "allday-today", summary: "Offsite today", start: { date: "2026-09-17" }, end: { date: "2026-09-18" } });
const EVT_ALLDAY_FAR = event({ id: "allday-far", summary: "Offsite far", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } });
const EVT_ATTENDEES = event({ id: "attendees", summary: "Standup", start: { dateTime: "2026-09-17T14:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-17T14:30:00Z", timeZone: "UTC" }, attendees: [{ email: "jejo@example.com" }] });

describe.skipIf(!TEST_DATABASE_URL)("calendar-change producer (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "e4scalnotify");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  interface NotificationRow {
    id: string;
    kind: string;
    title: string;
    status: string;
    source_type: string;
    payload: Record<string, unknown>;
  }

  async function notifications(): Promise<NotificationRow[]> {
    const rows = await db.pool.query(
      "SELECT id, kind, title, status, source_type, payload FROM notifications ORDER BY created_at",
    );
    return rows.rows as NotificationRow[];
  }

  it("default (notify off): a disruptive within-48h move enqueues NOTHING", async () => {
    await syncCalendar(db.pool, scriptedSource([{ events: [EVT_SOON], nextSyncToken: "t0" }]), { now: () => NOW });
    const moved = event({ ...EVT_SOON, start: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-17T16:00:00Z", timeZone: "UTC" }, updated: "2026-09-17T12:30:00.000Z" });
    await syncCalendar(db.pool, scriptedSource([{ events: [moved], nextSyncToken: "t1" }]), { now: () => NOW });
    expect(await notifications()).toEqual([]); // quiet by default
  });

  it("created events NEVER notify — even starting an hour from now", async () => {
    // Fresh projection: wipe rows so the batch classifies created again.
    await db.pool.query("DELETE FROM calendar_events");
    await db.pool.query("UPDATE calendar_sync_state SET sync_token = NULL");
    await syncCalendar(
      db.pool,
      scriptedSource([
        { events: [EVT_SOON, EVT_4759, EVT_4801, EVT_ALLDAY_TOMORROW, EVT_ALLDAY_TODAY, EVT_ATTENDEES, EVT_ALLDAY_FAR], nextSyncToken: "t2" },
      ]),
      { now: () => NOW, notify: true, notificationConfig: CONFIG },
    );
    expect(await notifications()).toEqual([]);
  });

  it("start_end_changed with the new start within 48h → ONE auto-approved calendar-change notification", async () => {
    const moved = event({ ...EVT_SOON, start: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-17T16:00:00Z", timeZone: "UTC" }, updated: "2026-09-17T12:31:00.000Z" });
    const report = await syncCalendar(db.pool, scriptedSource([{ events: [moved], nextSyncToken: "t3" }]), {
      now: () => NOW,
      notify: true,
      notificationConfig: CONFIG,
    });
    expect(report.changes[0]!.changeClass).toBe("start_end_changed");

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    const notification = rows[0]!;
    expect(notification.kind).toBe("calendar-change");
    expect(notification.title).toBe("Dentist: moved to 2026-09-17 15:00 UTC");
    expect(notification.status).toBe("approved"); // policy auto-approve (48h filter = the noise gate)
    expect(notification.source_type).toBe("calendar");
    expect(notification.payload).toMatchObject({
      change: {
        changeClass: "start_end_changed",
        summary: "Dentist",
        start: "2026-09-17T15:00:00.000Z",
        previousStart: "2026-09-17T13:00:00.000Z",
      },
      provenance: { googleEventId: "soon", calendarId: "primary", source: "calendar-sync" },
    });
    expect(typeof (notification.payload.provenance as Record<string, unknown>)["eventId"]).toBe("string");
  });

  it("moved FAR OUT but the PREVIOUS start was within 48h → still notifies (near-term schedule changed)", async () => {
    const farOut = event({ ...EVT_ATTENDEES, start: { dateTime: "2026-10-01T09:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-01T09:30:00Z", timeZone: "UTC" }, updated: "2026-09-17T12:45:00.000Z" });
    await syncCalendar(db.pool, scriptedSource([{ events: [farOut], nextSyncToken: "t4" }]), {
      now: () => NOW,
      notify: true,
      notificationConfig: CONFIG,
    });
    const rows = await notifications();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.title).toBe("Standup: moved to 2026-10-01 09:00 UTC");
  });

  it("moved far-out to far-out (neither start within 48h) → silent", async () => {
    const farToFar = event({ ...EVT_ATTENDEES, start: { dateTime: "2026-10-05T09:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-05T09:30:00Z", timeZone: "UTC" }, updated: "2026-09-17T12:50:00.000Z" });
    await syncCalendar(db.pool, scriptedSource([{ events: [farToFar], nextSyncToken: "t5" }]), {
      now: () => NOW,
      notify: true,
      notificationConfig: CONFIG,
    });
    expect(await notifications()).toHaveLength(2);
  });

  it("cancelled at 47h59m → notifies; cancelled at 48h01m → silent (boundaries)", async () => {
    const cancelIn = cancelOf(EVT_4759, "2026-09-17T12:55:00.000Z");
    const cancelOut = cancelOf(EVT_4801, "2026-09-17T12:56:00.000Z");
    await syncCalendar(db.pool, scriptedSource([{ events: [cancelIn, cancelOut], nextSyncToken: "t6" }]), {
      now: () => NOW,
      notify: true,
      notificationConfig: CONFIG,
    });
    const rows = await notifications();
    expect(rows).toHaveLength(3);
    expect(rows[2]!.title).toBe("Boundary in: cancelled"); // previous summary survives the minimal payload
    expect(rows.map((r) => r.title)).not.toContain("Boundary out: cancelled");
  });

  it("cancelled ALL-DAY edge: tomorrow (midnight within window) notifies; today (midnight passed) and +4 days stay silent", async () => {
    const cancelTomorrow = cancelOf(EVT_ALLDAY_TOMORROW, "2026-09-17T12:57:00.000Z");
    const cancelToday = cancelOf(EVT_ALLDAY_TODAY, "2026-09-17T12:58:00.000Z");
    const cancelFar = cancelOf(EVT_ALLDAY_FAR, "2026-09-17T12:59:00.000Z");
    await syncCalendar(db.pool, scriptedSource([{ events: [cancelTomorrow, cancelToday, cancelFar], nextSyncToken: "t7" }]), {
      now: () => NOW,
      notify: true,
      notificationConfig: CONFIG,
    });
    const rows = await notifications();
    expect(rows).toHaveLength(4);
    expect(rows[3]!.title).toBe("Offsite tomorrow: cancelled"); // start = 2026-09-18T00:00Z, +12h → IN
    const titles = rows.map((r) => r.title);
    expect(titles).not.toContain("Offsite today: cancelled"); // start = 2026-09-17T00:00Z, already past
    expect(titles).not.toContain("Offsite far: cancelled"); // start = 2026-09-21T00:00Z, +4d
  });

  it("non-disruptive changes (attendees, summary) NEVER notify — they ride the morning brief", async () => {
    // Built on the CURRENT projected state of 'soon' (15:00 after the move):
    // start/end unchanged so the classes stay attendees_changed / updated.
    const withAttendee = event({ ...EVT_SOON, start: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-17T16:00:00Z", timeZone: "UTC" }, attendees: [{ email: "jejo@example.com" }, { email: "sam@example.com", displayName: "Sam" }], updated: "2026-09-17T13:05:00.000Z" });
    await syncCalendar(db.pool, scriptedSource([{ events: [withAttendee], nextSyncToken: "t8" }]), {
      now: () => NOW,
      notify: true,
      notificationConfig: CONFIG,
    });
    const retitled = event({ ...EVT_SOON, summary: "Dentist (rescheduled)", start: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-17T16:00:00Z", timeZone: "UTC" }, attendees: [{ email: "jejo@example.com" }, { email: "sam@example.com", displayName: "Sam" }], updated: "2026-09-17T13:06:00.000Z" });
    await syncCalendar(db.pool, scriptedSource([{ events: [retitled], nextSyncToken: "t9" }]), {
      now: () => NOW,
      notify: true,
      notificationConfig: CONFIG,
    });
    expect(await notifications()).toHaveLength(4);
  });

  it("deduped redelivery of the same disruptive occurrence → NO second notification", async () => {
    // Crash-recovery shape: projection reverted, the SAME moved occurrence
    // (identical `updated` stamp → identical externalId) redelivered.
    await db.pool.query(
      `UPDATE calendar_events SET start_time = '2026-09-17T13:00Z', end_time = '2026-09-17T14:00Z', content_hash = 'reverted'
       WHERE google_event_id = 'soon'`,
    );
    const movedAgain = event({ ...EVT_SOON, start: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-17T16:00:00Z", timeZone: "UTC" }, updated: "2026-09-17T12:31:00.000Z" });
    const report = await syncCalendar(db.pool, scriptedSource([{ events: [movedAgain], nextSyncToken: "t10" }]), {
      now: () => NOW,
      notify: true,
      notificationConfig: CONFIG,
    });
    expect(report.changes[0]!.accepted).toBe(false); // deduped redelivery
    const rows = await notifications();
    expect(rows).toHaveLength(4); // unchanged — the dedupe held
    expect(rows.filter((r) => r.title.startsWith("Dentist"))).toHaveLength(1);
  });

  it("production path (NO notificationConfig override): the repo-root policy auto-approves calendar-change", async () => {
    // F1 pin: production never passes notificationConfig — the producer hook
    // must load the ratified policy itself and land the row approved.
    await db.pool.query("DELETE FROM calendar_events");
    await db.pool.query("UPDATE calendar_sync_state SET sync_token = NULL");
    const EVT_PROD = event({ id: "prodpath", summary: "ProductionPath", start: { dateTime: "2026-09-17T13:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-17T14:00:00Z", timeZone: "UTC" } });
    await syncCalendar(db.pool, scriptedSource([{ events: [EVT_PROD], nextSyncToken: "p0" }]), { now: () => NOW, notify: true });
    const moved = event({ ...EVT_PROD, start: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-17T16:00:00Z", timeZone: "UTC" }, updated: "2026-09-17T14:00:00.000Z" });
    await syncCalendar(db.pool, scriptedSource([{ events: [moved], nextSyncToken: "p1" }]), { now: () => NOW, notify: true });
    const row = (
      await db.pool.query("SELECT kind, status FROM notifications WHERE title = $1", [
        "ProductionPath: moved to 2026-09-17 15:00 UTC",
      ])
    ).rows[0];
    expect(row).toBeDefined();
    expect(row).toMatchObject({ kind: "calendar-change", status: "approved" });
  });
});
