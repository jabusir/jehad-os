import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { seedQueryFixtureWorld, type FixtureIds } from "./fixtures.js";
import { syncCalendar, type CalendarSourcePort } from "../calendar/sync.js";
import { collectDayState, renderDayStateText } from "./day-state.js";
import { theOneThing, topPriorities } from "./priority.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-17T12:00:00.000Z");
const now = (): Date => NOW;
const MIN = 60_000;
const DAY = 86_400_000;

describe.skipIf(!TEST_DATABASE_URL)("priority (integration)", () => {
  let db: IsolatedDb;
  let quietDb: IsolatedDb;
  let f: FixtureIds;
  let hennaId: string;
  let venueId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "j2w5aprio");
    await migrateUp(db.pool);
    f = await seedQueryFixtureWorld(db.pool, { now: NOW });

    const domainId = f.domains.personal;
    const insertEvent = async (
      type: string,
      payload: Record<string, unknown>,
      at: Date,
    ): Promise<string> => {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                             domain_id, payload, sensitivity, schema_version)
         VALUES ($1, $2, 'cli.capture', $3::timestamptz, $3::timestamptz, $4, $5::uuid,
                 $6::jsonb, 'normal', 1)`,
        [id, type, at.toISOString(), `sha256:${randomUUID()}`, domainId, JSON.stringify(payload)],
      );
      return id;
    };

    // The §3-flavored one-thing: an overdue owes_me commitment with
    // may_follow_up on, with downstream work (venue deposit) blocked on it.
    // Distinct timestamps keep the shared world's delta orderings deterministic.
    const hennaEvent = await insertEvent(
      "capture.recorded",
      { text: "Henna owes the venue confirmation" },
      new Date(NOW.getTime() - 70 * MIN),
    );
    const hennaInserted = await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at,
                                confidence, status, source_event_id, may_follow_up, temporal,
                                created_at, updated_at)
       VALUES ($1::uuid, 'owes_me', 'Henna', 'Henna owes the venue confirmation',
               $2::timestamptz, 0.9, 'open', $3::uuid, true, $4::jsonb,
               $5::timestamptz, $5::timestamptz)
       RETURNING id`,
      [
        domainId,
        new Date(NOW.getTime() - 3 * DAY).toISOString(),
        hennaEvent,
        JSON.stringify({
          rawExpression: "2026-09-14",
          anchorTime: NOW.toISOString(),
          anchorTimezone: "UTC",
          normalizedTime: "2026-09-14",
          resolutionStatus: "resolved",
          normalizerVersion: "test-fixture",
          resolutionConfidence: 1,
          resolutionMethod: "calendar-native",
        }),
        new Date(NOW.getTime() - 70 * MIN).toISOString(),
      ],
    );
    hennaId = String(hennaInserted.rows[0]!.id);

    const venueEvent = await insertEvent(
      "capture.recorded",
      { text: "Venue deposit" },
      new Date(NOW.getTime() - 65 * MIN),
    );
    const venueInserted = await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at,
                                confidence, status, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'i_owe', 'Venue', 'Venue deposit', NULL, 0.9, 'open', $2::uuid,
               $3::timestamptz, $3::timestamptz)
       RETURNING id`,
      [domainId, venueEvent, new Date(NOW.getTime() - 65 * MIN).toISOString()],
    );
    venueId = String(venueInserted.rows[0]!.id);

    const edgeEvent = await insertEvent(
      "capture.recorded",
      { note: "venue dependency" },
      new Date(NOW.getTime() - 60 * MIN),
    );
    await db.pool.query(
      `INSERT INTO relationships (domain_id, from_type, from_id, relation, to_type, to_id,
                                  source_event_id, valid_from, created_at, updated_at)
       VALUES ($1::uuid, 'commitment', $2::uuid, 'blocked_by', 'commitment', $3::uuid,
               $4::uuid, $5::timestamptz, $5::timestamptz, $5::timestamptz)`,
      [
        domainId,
        venueId,
        hennaId,
        edgeEvent,
        new Date(NOW.getTime() - 60 * MIN).toISOString(),
      ],
    );

    // Calendar: one event starting exactly 2h from now.
    const source: CalendarSourcePort = {
      id: "adapter:google-calendar",
      calendarId: "j2w5a-cal",
      listEvents: async () => ({
        events: [
          {
            id: "j2w5a-evt-1",
            iCalUID: "j2w5a-evt-1@google.com",
            status: "confirmed",
            summary: "Henna sync",
            start: { dateTime: "2026-09-17T14:00:00Z", timeZone: "UTC" },
            end: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" },
            updated: "2026-09-17T07:00:00.000Z",
          },
        ],
        nextPageToken: null,
        nextSyncToken: "j2w5a-t1",
      }),
    };
    await syncCalendar(db.pool, source, { now });

    quietDb = await createIsolatedTestDb(TEST_DATABASE_URL!, "j2w5aquiet");
    await migrateUp(quietDb.pool);
    await seedDomains(quietDb.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
    await dropIsolatedTestDb(TEST_DATABASE_URL!, quietDb);
  });

  it("the blocking-overdue item wins the one thing", async () => {
    const result = await theOneThing(db.pool, { now });
    expect(result).not.toBeNull();
    expect(result!.ref).toBe(`commitment:${hennaId}`);
    expect(result!.kind).toBe("overdue_follow_up");
    expect(result!.summary).toBe("Henna owes the venue confirmation");
    expect(result!.score).toBe(69);
    expect(result!.reason).toEqual([
      "3 days overdue",
      "may_follow_up is on",
      "Venue deposit is blocked on this",
    ]);
  });

  it("topPriorities: ranked list with per-item reasons (blocking-overdue > unlock > imminent > aging)", async () => {
    const results = await topPriorities(db.pool, { now });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.kind)).toEqual([
      "overdue_follow_up",
      "blocked_unlock",
      "calendar_imminent",
    ]);
    expect(results.map((r) => r.score)).toEqual([69, 50, 35]);
    expect(results[1]!.ref).toBe(`decision:${f.decisions.decisionA}`);
    expect(results[1]!.summary).toBe("Choose the migration approach");
    expect(results[1]!.reason[0]).toBe("unblocks 5 downstream items (3 direct)");
    expect(results[2]!.summary).toBe("7 AM Henna sync");
    expect(results[2]!.reason).toEqual(["in 2h"]);

    const wide = await topPriorities(db.pool, { now, limit: 5 });
    expect(wide).toHaveLength(4);
    expect(wide[3]!.kind).toBe("waiting_aging");
    expect(wide[3]!.ref).toBe(`commitment:${f.commitments.waitingOverdue}`);
    expect(wide[3]!.reason).toEqual(["waiting on Acme Corp for 8 days"]);
  });

  it("may_follow_up gates the overdue signal: overdue without it surfaces only as aging", async () => {
    const wide = await topPriorities(db.pool, { now, limit: 5 });
    const acmeResults = wide.filter((r) => r.ref === `commitment:${f.commitments.waitingOverdue}`);
    expect(acmeResults).toHaveLength(1);
    expect(acmeResults[0]!.kind).toBe("waiting_aging");
    expect(
      wide.some((r) => r.kind === "overdue_follow_up" && r.ref !== `commitment:${hennaId}`),
    ).toBe(false);
  });

  it("domain scoping: work domain sees its own unlock, never personal items or calendar", async () => {
    const result = await theOneThing(db.pool, { now, domainId: "work" });
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("blocked_unlock");
    expect(result!.ref).toBe(`decision:${f.decisions.decisionWork}`);
    expect(result!.summary).toBe("Deploy window");
    expect(result!.score).toBe(34);
    expect(result!.reason[0]).toBe("unblocks 1 downstream item (1 direct)");
    expect(result!.summary).not.toContain("Henna");
  });

  it("determinism pin: same fixtures → identical output across runs", async () => {
    const oneA = await theOneThing(db.pool, { now });
    const oneB = await theOneThing(db.pool, { now });
    expect(oneA).toEqual(oneB);
    const listA = await topPriorities(db.pool, { now, limit: 5 });
    const listB = await topPriorities(db.pool, { now, limit: 5 });
    expect(JSON.stringify(listA)).toBe(JSON.stringify(listB));
  });

  it("quiet world: null one thing, empty list, day.state omits the priority line", async () => {
    expect(await theOneThing(quietDb.pool, { now })).toBeNull();
    expect(await topPriorities(quietDb.pool, { now })).toEqual([]);
    const data = await collectDayState(quietDb.pool, "00000000-0000-4000-8000-000000000001", { now });
    expect(data.priority).toBeNull();
    const text = renderDayStateText(data);
    expect(text).toContain("All quiet — nothing waiting, nothing blocked.");
    expect(text).not.toContain("one thing");
  });
});
