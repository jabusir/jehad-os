// W5(d) integration tests: planDivergence over a real migrated database —
// churn detection from calendar observation events + the projection,
// window/civil-day scoping, and quiet-day suppression (null). Needs
// PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { planDivergence } from "./divergence.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** 2:00 PM PDT on 2026-09-17 — civil day 2026-09-17 (PDT, UTC-7). */
const NOW = new Date("2026-09-17T21:00:00.000Z");
const now = (): Date => NOW;
/** 2026-09-17T00:00 PDT. */
const DAY_START = new Date("2026-09-17T07:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("plan divergence (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w5cdiv");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    domainId = String(
      (await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`)).rows[0]!.id,
    );
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function insertObservation(args: {
    type: "calendar.event.updated" | "calendar.event.cancelled" | "calendar.event.created";
    occurredAt: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                           domain_id, payload, sensitivity, schema_version)
       VALUES ($1, $2, 'adapter:google-calendar', $3::timestamptz, $3::timestamptz, $4, $5::uuid,
               $6::jsonb, 'normal', 1)`,
      [randomUUID(), args.type, args.occurredAt, `sha256:${randomUUID()}`, domainId, JSON.stringify(args.payload)],
    );
  }

  async function insertCalendarRow(args: {
    googleEventId: string;
    summary: string;
    start: string | null;
    status?: string;
  }): Promise<void> {
    const sourceEventId = randomUUID();
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                           domain_id, payload, sensitivity, schema_version)
       VALUES ($1, 'calendar.event.created', 'adapter:google-calendar', $2::timestamptz, $2::timestamptz, $3, $4::uuid,
               '{}'::jsonb, 'normal', 1)`,
      [sourceEventId, "2026-09-17T08:00:00.000Z", `sha256:${randomUUID()}`, domainId],
    );
    await db.pool.query(
      `INSERT INTO calendar_events (google_event_id, google_calendar_id, status, summary, start_time,
                                    end_time, timezone, attendees, location, metadata, source_event_id, content_hash)
       VALUES ($1, 'primary', $2, $3, $4::timestamptz, $4::timestamptz, NULL, '[]'::jsonb, NULL,
               '{}'::jsonb, $5::uuid, $6)`,
      [args.googleEventId, args.status ?? "confirmed", args.summary, args.start, sourceEventId, randomUUID()],
    );
  }

  it("quiet day: no mutations → null (suppression)", async () => {
    await insertCalendarRow({ googleEventId: "calm-1", summary: "Gym block", start: "2026-09-18T00:00:00.000Z" });
    expect(await planDivergence(db.pool, { now, windowStart: DAY_START })).toBeNull();
  });

  it("same-day move + cancellation are churn; count, kinds, and the planned denominator", async () => {
    // Henna sync: moved 4pm→5:30pm PDT today, mutation observed 11am PDT.
    await insertCalendarRow({ googleEventId: "evt-moved", summary: "Henna sync", start: "2026-09-18T00:30:00.000Z" });
    await insertObservation({
      type: "calendar.event.updated",
      occurredAt: "2026-09-17T18:00:00.000Z",
      payload: {
        changeClass: "start_end_changed",
        googleEventId: "evt-moved",
        summary: "Henna sync",
        start: "2026-09-18T00:30:00.000Z",
        end: "2026-09-18T01:30:00.000Z",
        previousStart: "2026-09-17T23:00:00.000Z",
        previousEnd: "2026-09-18T00:00:00.000Z",
      },
    });
    // Venue tour: cancelled (6pm PDT today), minimal payload nulls start.
    await insertCalendarRow({
      googleEventId: "evt-cancelled",
      summary: "Venue tour",
      start: null,
      status: "cancelled",
    });
    await insertObservation({
      type: "calendar.event.cancelled",
      occurredAt: "2026-09-17T19:00:00.000Z",
      payload: {
        changeClass: "cancelled",
        googleEventId: "evt-cancelled",
        summary: "Venue tour",
        start: null,
        end: null,
        previousStart: "2026-09-18T01:00:00.000Z",
        previousEnd: "2026-09-18T02:00:00.000Z",
      },
    });

    const result = await planDivergence(db.pool, { now, windowStart: DAY_START });
    expect(result).not.toBeNull();
    expect(result!.day).toBe("2026-09-17");
    expect(result!.churnedCount).toBe(2);
    // Planned: Gym (remaining) + Henna sync (moved, still in-day) + Venue
    // tour (cancelled row left the remaining set) = 3.
    expect(result!.plannedCount).toBe(3);
    expect(result!.items).toEqual([
      { googleEventId: "evt-moved", title: "Henna sync", changeKind: "moved" },
      { googleEventId: "evt-cancelled", title: "Venue tour", changeKind: "cancelled" },
    ]);
  });

  it("mutations outside the scan window and non-disruptive classes never count", async () => {
    // Moved yesterday (observation before the window) about today's event.
    await insertCalendarRow({ googleEventId: "evt-old-move", summary: "Old move", start: "2026-09-17T22:00:00.000Z" });
    await insertObservation({
      type: "calendar.event.updated",
      occurredAt: "2026-09-16T20:00:00.000Z", // before dayStart
      payload: {
        changeClass: "start_end_changed",
        googleEventId: "evt-old-move",
        summary: "Old move",
        start: "2026-09-17T22:00:00.000Z",
        previousStart: "2026-09-17T20:00:00.000Z",
      },
    });
    // Attendees edit today (content churn, not plan divergence v1).
    await insertObservation({
      type: "calendar.event.updated",
      occurredAt: "2026-09-17T20:00:00.000Z",
      payload: {
        changeClass: "attendees_changed",
        googleEventId: "evt-moved",
        summary: "Henna sync",
        start: "2026-09-18T00:30:00.000Z",
      },
    });
    // A churn-class observation about TOMORROW's plan, mutated today.
    await insertCalendarRow({ googleEventId: "evt-tomorrow", summary: "Future conf", start: "2026-09-18T17:00:00.000Z" });
    await insertObservation({
      type: "calendar.event.updated",
      occurredAt: "2026-09-17T20:30:00.000Z",
      payload: {
        changeClass: "start_end_changed",
        googleEventId: "evt-tomorrow",
        summary: "Future conf",
        start: "2026-09-18T18:00:00.000Z",
        previousStart: "2026-09-18T17:00:00.000Z",
      },
    });

    const result = await planDivergence(db.pool, { now, windowStart: DAY_START });
    expect(result).not.toBeNull();
    expect(result!.items.map((i) => i.googleEventId)).toEqual(["evt-moved", "evt-cancelled"]);
  });

  it("windowStart after now fails honest (RangeError)", async () => {
    await expect(
      planDivergence(db.pool, { now, windowStart: new Date(NOW.getTime() + 60_000) }),
    ).rejects.toThrow(RangeError);
  });
});
