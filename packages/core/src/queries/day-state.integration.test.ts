import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { seedQueryFixtureWorld, type FixtureIds } from "./fixtures.js";
import { raiseEscalation } from "../escalations/service.js";
import { syncCalendar, type CalendarSourcePort } from "../calendar/sync.js";
import { upsertCalendarSyncState } from "../calendar/projection.js";
import { collectDayState, DAY_STATE_COVERAGE, renderDayStateText } from "./day-state.js";
import { executeReadTool, runReadSet } from "../imessage/read-tools.js";
import { createReminder } from "../reminders/queries.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-17T12:00:00.000Z");
const now = (): Date => NOW;
const HOUR = 3_600_000;

describe.skipIf(!TEST_DATABASE_URL)("day.state (integration)", () => {
  let db: IsolatedDb;
  let emptyDb: IsolatedDb;
  let f: FixtureIds;
  let principalA: string;
  let principalB: string;
  let quietPrincipal: string;
  let hennaId: string;
  let venueId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "j2daystate");
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

    await insertEvent("capture.recorded", { text: "Acme pinged overnight" }, new Date(NOW.getTime() - 2 * HOUR));

    const decisionEvent = await insertEvent(
      "decision.recorded",
      { question: "Pick the briefing channel" },
      new Date(NOW.getTime() - 3 * HOUR),
    );
    await db.pool.query(
      `INSERT INTO decisions (domain_id, question, chosen, decided_at, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'Pick the briefing channel', 'stdout', $2::timestamptz, $3::uuid,
               $2::timestamptz, $2::timestamptz)`,
      [domainId, new Date(NOW.getTime() - 3 * HOUR).toISOString(), decisionEvent],
    );

    const commitEvent = await insertEvent(
      "capture.recorded",
      { text: "Confirm squash court" },
      new Date(NOW.getTime() - 3 * HOUR),
    );
    await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at, confidence,
                                status, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'i_owe', 'Gym', 'Book squash court', NULL, 0.9, 'open', $2::uuid,
               $3::timestamptz, $3::timestamptz)`,
      [domainId, commitEvent, new Date(NOW.getTime() - 3 * HOUR).toISOString()],
    );

    const metEvent = await insertEvent(
      "capture.recorded",
      { text: "Bill paid" },
      new Date(NOW.getTime() - 4 * HOUR),
    );
    await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at, confidence,
                                status, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'i_owe', 'ISP', 'Pay internet bill', NULL, 0.9, 'met', $2::uuid,
               $3::timestamptz, $3::timestamptz)`,
      [domainId, metEvent, new Date(NOW.getTime() - 4 * HOUR).toISOString()],
    );

    // W5(a) priority seeds: the one-thing — an overdue owes_me commitment with
    // may_follow_up on and downstream work (venue deposit) blocked on it.
    // Distinct timestamps keep the overnight delta ordering deterministic.
    const hennaEvent = await insertEvent(
      "capture.recorded",
      { text: "Henna owes the venue confirmation" },
      new Date(NOW.getTime() - 70 * 60_000),
    );
    const henna = await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at,
                                confidence, status, source_event_id, may_follow_up, temporal,
                                created_at, updated_at)
       VALUES ($1::uuid, 'owes_me', 'Henna', 'Henna owes the venue confirmation',
               $2::timestamptz, 0.9, 'open', $3::uuid, true, $4::jsonb,
               $5::timestamptz, $5::timestamptz)
       RETURNING id`,
      [
        domainId,
        new Date(NOW.getTime() - 3 * 24 * HOUR).toISOString(),
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
        new Date(NOW.getTime() - 70 * 60_000).toISOString(),
      ],
    );
    hennaId = String(henna.rows[0]!.id);

    const venueEvent = await insertEvent(
      "capture.recorded",
      { text: "Venue deposit" },
      new Date(NOW.getTime() - 65 * 60_000),
    );
    const venue = await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at,
                                confidence, status, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'i_owe', 'Venue', 'Venue deposit', NULL, 0.9, 'open', $2::uuid,
               $3::timestamptz, $3::timestamptz)
       RETURNING id`,
      [domainId, venueEvent, new Date(NOW.getTime() - 65 * 60_000).toISOString()],
    );
    venueId = String(venue.rows[0]!.id);

    const edgeEvent = await insertEvent(
      "capture.recorded",
      { note: "venue dependency" },
      new Date(NOW.getTime() - 60 * 60_000),
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
        new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      ],
    );

    const mkPrincipal = async (name: string): Promise<string> => {
      const inserted = await db.pool.query(
        `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
        [name],
      );
      return String(inserted.rows[0]!.id);
    };
    principalA = await mkPrincipal(`jehad-${randomUUID().slice(0, 8)}`);
    principalB = await mkPrincipal(`yusra-${randomUUID().slice(0, 8)}`);

    const mkRun = async (principalId: string): Promise<string> =>
      String(
        (
          await db.pool.query(
            `INSERT INTO runs (kind, principal_id, status, domain_id)
             SELECT 'workflow', $1, 'running', d.id FROM domains d WHERE d.key = 'personal'
             RETURNING id`,
            [principalId],
          )
        ).rows[0]!.id,
      );

    const runA = await mkRun(principalA);
    await raiseEscalation(db.pool, { runId: runA, reason: "approval_required" }, { now });
    const batched = await raiseEscalation(
      db.pool,
      { runId: runA, reason: "ambiguous_requirements" },
      { now },
    );
    await db.pool.query(`UPDATE escalations SET status = 'batched' WHERE id = $1::uuid`, [
      batched.escalation.id,
    ]);
    const resolved = await raiseEscalation(db.pool, { runId: runA, reason: "system_failure" }, { now });
    await db.pool.query(`UPDATE escalations SET status = 'resolved' WHERE id = $1::uuid`, [
      resolved.escalation.id,
    ]);

    const runB = await mkRun(principalB);
    await raiseEscalation(db.pool, { runId: runB, reason: "missing_credentials" }, { now });

    const googleEvents = [
      {
        id: "j2-evt-1",
        iCalUID: "j2-evt-1@google.com",
        status: "confirmed",
        summary: "Calendar sync review",
        start: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-09-17T16:00:00Z", timeZone: "UTC" },
        updated: "2026-09-17T07:00:00.000Z",
      },
      {
        id: "j2-evt-2",
        status: "confirmed",
        summary: "Tomorrow thing",
        start: { dateTime: "2026-09-18T09:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-09-18T10:00:00Z", timeZone: "UTC" },
        updated: "2026-09-17T07:00:00.000Z",
      },
      {
        id: "j2-evt-3",
        status: "cancelled",
        summary: "Cancelled today",
        start: { dateTime: "2026-09-17T18:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-09-17T19:00:00Z", timeZone: "UTC" },
        updated: "2026-09-17T07:00:00.000Z",
      },
    ];
    const source: CalendarSourcePort = {
      id: "adapter:google-calendar",
      calendarId: "j2-cal",
      listEvents: async () => ({ events: googleEvents, nextPageToken: null, nextSyncToken: "j2-t1" }),
    };
    await syncCalendar(db.pool, source, { now });

    emptyDb = await createIsolatedTestDb(TEST_DATABASE_URL!, "j2dayempty");
    await migrateUp(emptyDb.pool);
    await seedDomains(emptyDb.pool);
    const quiet = await emptyDb.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
      [`quiet-${randomUUID().slice(0, 8)}`],
    );
    quietPrincipal = String(quiet.rows[0]!.id);
    await upsertCalendarSyncState(emptyDb.pool, {
      calendarId: "j2-quiet-cal",
      syncToken: "t",
      lastSyncedAt: new Date(NOW.getTime() - HOUR),
      lastPageCount: 0,
    });
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
    await dropIsolatedTestDb(TEST_DATABASE_URL!, emptyDb);
  });

  it("busy day: deterministic labeled-section golden render", async () => {
    const data = await collectDayState(db.pool, principalA, { now });
    expect(data.priority).not.toBeNull();
    expect(data.priority!.ref).toBe(`commitment:${hennaId}`);
    expect(data.priority!.kind).toBe("overdue_follow_up");
    expect(data.priority!.score).toBe(69);
    const text = renderDayStateText(data);
    expect(text).toBe(
      [
        "Day state — Thu, Sep 17",
        "",
        "You have one thing that actually needs your attention: Henna owes the venue confirmation (3 days overdue; may_follow_up is on; Venue deposit is blocked on this).",
        "Also in play: 27 waiting, 16 blocked or stalled.",
        "",
        "NOW/NEXT",
        "- 8–9 AM Calendar sync review",
        "",
        "WAITING",
        "- OVERDUE Pay October rent — due Wed, Sep 16 (i_owe Landlord)",
        "- OVERDUE Send the contractor the signed renewal — due Wed, Sep 16 (i_owe Contractor)",
        "- DUE SOON Submit quarter-end paperwork — due Sat, Sep 19 (i_owe Bank)",
        "- 20 more open commitments without near due dates",
        "- OVERDUE Henna owes the venue confirmation — due Mon, Sep 14 (owes_me Henna)",
        "- OVERDUE Acme owes Jehad the signed SOW — due Tue, Sep 15 (owes_me Acme Corp)",
        "- 2 more waiting on others",
        "",
        "BLOCKED",
        '- Cycle side X — blocked by commitment "Cycle side Y" (dependency cycle)',
        '- Cycle side Y — blocked by commitment "Cycle side X" (dependency cycle)',
        '- Stale but explicitly blocked (8 days silent) — blocked by decision "Pick the CI provider"',
        '- Task B: draft schema — blocked by decision "Choose the migration approach"',
        '- Task C: extraction prompt — blocked by decision "Choose the migration approach"',
        '- Task D: brief renderer — blocked by decision "Choose the migration approach"',
        '- Task F: CI pipeline — blocked by decision "Pick the CI provider"',
        '- Task T2 (depth 2 under A) — blocked by commitment "Task B: draft schema"',
        '- Task T3 (depth 3 under A) — blocked by commitment "Task T2 (depth 2 under A)"',
        '- Task T4 (depth 4 under A — beyond cap) — blocked by commitment "Task T3 (depth 3 under A)"',
        '- Task already delivered — blocked by decision "Vendor contract renewal"',
        '- Venue deposit — blocked by commitment "Henna owes the venue confirmation"',
        "- Legacy Migration — stalled 12.0d (threshold 7d)",
        "- Acme owes Jehad the signed SOW — stalled 8.0d (threshold 7d)",
        "- Stale unblocked commitment (8 days silent) — stalled 8.0d (threshold 7d)",
        "- Stale with an expired blocked_by edge (8 days silent) — stalled 8.0d (threshold 7d)",
        "",
        "BEST UNLOCK",
        "- Choose the migration approach (chosen: Strangler fig)",
        "  unblocks 5 downstream items (3 direct)",
        "  - Task B: draft schema",
        "  - Task C: extraction prompt",
        "  - Task D: brief renderer",
        "  - Task T2 (depth 2 under A)",
        "  - Task T3 (depth 3 under A)",
        "",
        "OVERNIGHT",
        "- 14 events:",
        "  - capture.recorded ×6",
        "  - escalation.raised ×4",
        "  - calendar.event.created ×3",
        "  - …and 1 more kinds",
        "- 4 commitments captured:",
        "  - Pay internet bill (i_owe, met)",
        "  - Book squash court (i_owe, open)",
        "  - Henna owes the venue confirmation (owes_me, open)",
        "  - Venue deposit (i_owe, open)",
        "- 1 decision:",
        "  - Pick the briefing channel → stdout",
        "- 1 relationship update",
        "",
        "ESCALATIONS",
        "- 2 open (pending 1, batched 1)",
        "- ambiguous_requirements ×1",
        "- approval_required ×1",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("must never leak");
    expect(text).not.toContain("Deploy window");
    expect(text).not.toContain("gmail");
  });

  it("empty day: quiet golden render with fresh calendar", async () => {
    const data = await collectDayState(emptyDb.pool, quietPrincipal, { now });
    expect(data.priority).toBeNull();
    expect(renderDayStateText(data)).toBe(
      [
        "Day state — Thu, Sep 17",
        "",
        "NOW/NEXT",
        "- nothing scheduled",
        "",
        "All quiet — nothing waiting, nothing blocked.",
        "",
      ].join("\n"),
    );
  });

  it("stale-calendar shapes: caveat lines appear past 6h and never for fresh", async () => {
    await db.pool.query(`UPDATE calendar_sync_state SET last_synced_at = $1::timestamptz`, [
      new Date(NOW.getTime() - 7 * HOUR).toISOString(),
    ]);
    const stale = renderDayStateText(await collectDayState(db.pool, principalA, { now }));
    expect(stale.endsWith("calendar last synced 7h ago\n")).toBe(true);
    expect(stale).not.toContain("gmail");

    await db.pool.query(`UPDATE calendar_sync_state SET last_synced_at = $1::timestamptz`, [
      new Date(NOW.getTime() - (5 + 59 / 60) * HOUR).toISOString(),
    ]);
    const fresh = renderDayStateText(await collectDayState(db.pool, principalA, { now }));
    expect(fresh).not.toContain("calendar last synced");

    await db.pool.query(`UPDATE calendar_sync_state SET last_synced_at = NULL`);
    const never = renderDayStateText(await collectDayState(db.pool, principalA, { now }));
    expect(never).toContain("calendar has never synced");

    await db.pool.query(`UPDATE calendar_sync_state SET last_synced_at = $1::timestamptz`, [
      NOW.toISOString(),
    ]);
  });

  it("principal scoping: two principals never see each other's escalations", async () => {
    const dataA = await collectDayState(db.pool, principalA, { now });
    expect(dataA.escalations).toEqual({
      pending: 1,
      batched: 1,
      byReason: [
        { reason: "ambiguous_requirements", count: 1 },
        { reason: "approval_required", count: 1 },
      ],
    });
    const dataB = await collectDayState(db.pool, principalB, { now });
    expect(dataB.escalations).toEqual({
      pending: 1,
      batched: 0,
      byReason: [{ reason: "missing_credentials", count: 1 }],
    });
    const textA = renderDayStateText(dataA);
    const textB = renderDayStateText(dataB);
    expect(textA).toContain("- approval_required ×1");
    expect(textA).toContain("- ambiguous_requirements ×1");
    expect(textA).not.toContain("missing_credentials");
    expect(textA).not.toContain("system_failure");
    expect(textB).toContain("- missing_credentials ×1");
    expect(textB).not.toContain("approval_required");
    expect(textB).not.toContain("ambiguous_requirements");
  });

  it("executeReadTool day.state: coverage-honest, pre-rendered, principal-scoped", async () => {
    const result = await executeReadTool(db.pool, { tool: "day.state" }, { now, principalId: principalA });
    expect(result.tool).toBe("day.state");
    expect(result.source).toBe("state");
    expect(result.coverage).toBe(DAY_STATE_COVERAGE);
    const data = result.data as {
      timezone: string;
      date: string;
      stale: string[];
      text: string;
    };
    expect(data.timezone).toBe("America/Los_Angeles");
    expect(data.date).toBe("2026-09-17");
    expect(data.stale).toEqual([]);
    expect(data.text).toContain("WAITING");
    expect(data.text).toContain("BEST UNLOCK");
    expect(data.text).not.toContain("missing_credentials");
    expect(data.text.length).toBeLessThanOrEqual(4000);
  });

  it("runReadSet composes day.state + calendar.next with per-block budgets and provenance", async () => {
    const blocks = await runReadSet(db.pool, principalA, ["day.state", "calendar.next"], {
      now,
      blockCharBudget: 600,
    });
    expect(blocks).toHaveLength(2);
    const [dayBlock, nextBlock] = blocks;
    expect(dayBlock!.tool).toBe("day.state");
    expect(dayBlock!.source).toBe("state");
    expect(dayBlock!.coverage).toBe(DAY_STATE_COVERAGE);
    expect(dayBlock!.truncated).toBe(true);
    expect(dayBlock!.charBudget).toBe(600);
    expect(typeof dayBlock!.data).toBe("string");
    expect((dayBlock!.data as string).length).toBe(600);
    expect((dayBlock!.data as string).endsWith("…")).toBe(true);
    expect(nextBlock!.tool).toBe("calendar.next");
    expect(nextBlock!.source).toBe("calendar");
    expect(nextBlock!.truncated).toBe(false);
    expect(nextBlock!.data).toMatchObject({ timezone: "America/Los_Angeles" });
    expect((nextBlock!.data as { items: { title: string }[] }).items.map((i) => i.title)).toEqual([
      "Tomorrow thing",
    ]);
  });

  it("bulk import collapse: a ≥20 calendar delta group renders as one bulk line", async () => {
    const domainId = f.domains.personal;
    for (let i = 0; i < 21; i += 1) {
      await db.pool.query(
        `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                             domain_id, payload, sensitivity, schema_version)
         VALUES ($1, 'calendar.event.updated', 'adapter:google-calendar', $2::timestamptz,
                 $2::timestamptz, $3, $4::uuid, $5::jsonb, 'normal', 1)`,
        [
          randomUUID(),
          new Date(NOW.getTime() - HOUR).toISOString(),
          `sha256:${randomUUID()}`,
          domainId,
          JSON.stringify({
            googleEventId: `bulk-${i}`,
            start: "2026-09-18T00:00:00Z",
            end: "2026-09-18T01:00:00Z",
          }),
        ],
      );
    }
    const text = renderDayStateText(await collectDayState(db.pool, principalA, { now }));
    expect(text).toContain("- calendar sync: 21 upcoming events updated (bulk import)");
    expect(text).not.toContain("calendar.event.updated ×21");
  });

  it("armed reminders: count renders only when > 0, scoped per principal", async () => {
    const inserted = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
      [`reminder-${randomUUID().slice(0, 8)}`],
    );
    const principalC = String(inserted.rows[0]!.id);
    await createReminder(db.pool, {
      principal: principalC,
      title: "Call the dentist",
      dueDate: "2026-09-18",
      firstTouchAt: NOW,
      firstTouchKind: "morning",
    });
    await createReminder(db.pool, {
      principal: principalC,
      title: "Pay the parking ticket",
      dueDate: "2026-09-18",
      firstTouchAt: NOW,
      firstTouchKind: "morning",
    });

    const data = await collectDayState(db.pool, principalC, { now });
    expect(data.armedReminders).toBe(2);
    expect(renderDayStateText(data)).toContain("Reminders armed: 2.");

    // Zero → no line (and never leaked across principals).
    const quietData = await collectDayState(db.pool, quietPrincipal, { now });
    expect(quietData.armedReminders).toBe(0);
    const quietText = renderDayStateText(quietData);
    expect(quietText).not.toContain("Reminders armed");
    const busyData = await collectDayState(db.pool, principalA, { now });
    expect(busyData.armedReminders).toBe(0);
    expect(renderDayStateText(busyData)).not.toContain("Reminders armed");
  });
});
