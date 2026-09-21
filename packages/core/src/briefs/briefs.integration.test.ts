// Brief/close service integration tests (M6B; plan §13, §31 shapes) against
// an isolated migrated database seeded with the M6A fixture world (including
// the review §25 leverage graph: Decision A blocks B/C/D + depth chain,
// overdue/due-soon i_owe variants, blocked/stalled sets) plus fresh
// "today" rows and open escalations. Also W5(d): the evening close's
// plan-divergence section after real calendar churn (sync pass 1 plans the
// day, pass 2 moves + cancels same-day). Needs PostgreSQL 16 — skipped
// unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { seedQueryFixtureWorld, type FixtureIds } from "../queries/fixtures.js";
import { raiseEscalation } from "../escalations/service.js";
import { syncCalendar, type CalendarSourcePort } from "../calendar/sync.js";
import { renderEveningClose, renderMorningBrief } from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-17T12:00:00.000Z");
const now = (): Date => NOW;
const HOUR = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)("briefs (integration)", () => {
  let db: IsolatedDb;
  let f: FixtureIds;
  let emptyDb: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m6briefs");
    await migrateUp(db.pool);
    f = await seedQueryFixtureWorld(db.pool, { now: NOW });

    // Fresh "overnight/today" rows (all inside the default 16h window).
    const domainId = f.domains.personal;
    const insertEvent = async (type: string, payload: Record<string, unknown>, at: Date): Promise<string> => {
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

    // Overnight event delta.
    await insertEvent("capture.recorded", { text: "Acme pinged overnight" }, new Date(NOW.getTime() - 2 * HOUR));

    // Today's decision (evening close: decisions made).
    const decisionEvent = await insertEvent("decision.recorded", { question: "Pick the briefing channel" }, new Date(NOW.getTime() - 3 * HOUR));
    await db.pool.query(
      `INSERT INTO decisions (domain_id, question, chosen, decided_at, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'Pick the briefing channel', 'stdout', $2::timestamptz, $3::uuid,
               $2::timestamptz, $2::timestamptz)`,
      [domainId, new Date(NOW.getTime() - 3 * HOUR).toISOString(), decisionEvent],
    );

    // New open commitment (evening close: new commitments).
    const commitEvent = await insertEvent("capture.recorded", { text: "Confirm squash court" }, new Date(NOW.getTime() - 3 * HOUR));
    await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at, confidence,
                                status, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'i_owe', 'Gym', 'Book squash court', NULL, 0.9, 'open', $2::uuid,
               $3::timestamptz, $3::timestamptz)`,
      [domainId, commitEvent, new Date(NOW.getTime() - 3 * HOUR).toISOString()],
    );

    // Completed commitment (evening close: completed).
    const metEvent = await insertEvent("capture.recorded", { text: "Bill paid" }, new Date(NOW.getTime() - 4 * HOUR));
    await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at, confidence,
                                status, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'i_owe', 'ISP', 'Pay internet bill', NULL, 0.9, 'met', $2::uuid,
               $3::timestamptz, $3::timestamptz)`,
      [domainId, metEvent, new Date(NOW.getTime() - 4 * HOUR).toISOString()],
    );

    // Open escalations (morning brief batch summary): one pending, one batched.
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    const runId = String(
      (
        await db.pool.query(
          `INSERT INTO runs (kind, principal_id, status, domain_id)
           SELECT 'workflow', $1, 'running', d.id FROM domains d WHERE d.key = 'personal'
           RETURNING id`,
          [principal.rows[0].id],
        )
      ).rows[0].id,
    );
    await raiseEscalation(db.pool, { runId, reason: "approval_required" }, { now });
    const second = await raiseEscalation(db.pool, { runId, reason: "ambiguous_requirements" }, { now });
    await db.pool.query(`UPDATE escalations SET status = 'batched' WHERE id = $1::uuid`, [
      second.escalation.id,
    ]);

    // Empty world for the suppression tests.
    emptyDb = await createIsolatedTestDb(TEST_DATABASE_URL!, "m6bempty");
    await migrateUp(emptyDb.pool);
    await seedDomains(emptyDb.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
    await dropIsolatedTestDb(TEST_DATABASE_URL!, emptyDb);
  });

  it("morning brief renders the §31 delta shape and persists a 'brief' artifact", async () => {
    const outcome = await renderMorningBrief(db.pool, { now });

    expect(outcome.suppressed).toBe(false);
    expect(outcome.kind).toBe("brief");
    const content = outcome.content!;
    // Overnight event delta appears.
    expect(content).toContain("capture.recorded ×");
    // Overdue i_owe commitment appears (fixture: rent due a day ago).
    expect(content).toContain("OVERDUE Pay October rent — due 2026-09-16T12:00:00.000Z (i_owe Landlord)");
    // §25 leverage: Decision A (blocks B/C/D + depth chain) is today's unlock.
    expect(content).toContain("- Choose the migration approach (chosen: Strangler fig)");
    expect(content).toContain("unblocks 5 downstream items (3 direct)");
    expect(content).toContain("- Task B: draft schema");
    // Blocked + stalled sections.
    expect(content).toContain("blocked by decision \"Choose the migration approach\"");
    expect(content).toContain("Stale unblocked commitment (8 days silent) — stalled 8.0d (threshold 7d)");
    // Escalation batch summary.
    expect(content).toContain("- 2 open (pending 1, batched 1)");
    expect(content).toContain("- ambiguous_requirements ×1");
    expect(content).toContain("- approval_required ×1");
    // Personal-domain brief never leaks the work-domain fixtures.
    expect(content).not.toContain("must never leak");
    expect(content).not.toContain("Deploy window");

    // Artifact row: kind brief, postgres backend, personal domain, content matches.
    const row = (
      await db.pool.query(
        `SELECT a.kind, a.storage_backend, a.content, d.key AS domain_key, r.workflow_id
         FROM artifacts a
         JOIN runs r ON r.id = a.run_id
         JOIN domains d ON d.id = a.domain_id
         WHERE a.id = $1::uuid`,
        [outcome.artifactId],
      )
    ).rows[0];
    expect(row).toMatchObject({
      kind: "brief",
      storage_backend: "postgres",
      content,
      domain_key: "personal",
      workflow_id: "brief-morning",
    });
  });

  it("morning brief is deterministic across renders (golden stability)", async () => {
    const first = await renderMorningBrief(db.pool, { now });
    const second = await renderMorningBrief(db.pool, { now });
    expect(second.content).toBe(first.content);
    expect(second.artifactId).not.toBe(first.artifactId);
  });

  it("E3: today's schedule section renders from the calendar projection after a sync", async () => {
    // One calendar event today (2026-09-17 per NOW), one tomorrow, one cancelled today.
    const googleEvents = [
      {
        id: "brief-evt-1",
        iCalUID: "brief-evt-1@google.com",
        status: "confirmed",
        summary: "Calendar sync review",
        start: { dateTime: "2026-09-17T15:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-09-17T16:00:00Z", timeZone: "UTC" },
        updated: "2026-09-17T07:00:00.000Z",
      },
      {
        id: "brief-evt-2",
        status: "confirmed",
        summary: "Tomorrow thing",
        start: { dateTime: "2026-09-18T09:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-09-18T10:00:00Z", timeZone: "UTC" },
        updated: "2026-09-17T07:00:00.000Z",
      },
      {
        id: "brief-evt-3",
        status: "cancelled",
        summary: "Cancelled today",
        start: { dateTime: "2026-09-17T18:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-09-17T19:00:00Z", timeZone: "UTC" },
        updated: "2026-09-17T07:00:00.000Z",
      },
    ];
    const source: CalendarSourcePort = {
      id: "adapter:google-calendar",
      calendarId: "brief-cal",
      listEvents: async () => ({ events: googleEvents, nextPageToken: null, nextSyncToken: "bt-1" }),
    };
    await syncCalendar(db.pool, source, { now });

    const outcome = await renderMorningBrief(db.pool, { now });
    expect(outcome.suppressed).toBe(false);
    const content = outcome.content!;
    expect(content).toContain("Today");
    expect(content).toContain("Calendar sync review");
    // Tomorrow's event is neither a schedule line nor a next-up hint when
    // today already has events (next-up is the quiet-day fallback only).
    expect(content).not.toContain("Tomorrow thing");
    expect(content).not.toContain("Cancelled today");
  });

  it("morning brief on an empty world → suppressed, no artifact", async () => {
    const outcome = await renderMorningBrief(emptyDb.pool, { now });
    expect(outcome).toMatchObject({ kind: "brief", suppressed: true, content: null, artifactId: null });
    const count = await emptyDb.pool.query(`SELECT count(*)::int AS n FROM artifacts`);
    expect(count.rows[0].n).toBe(0);
  });

  it("evening close renders the §31 TODAY shape and persists a 'close' artifact", async () => {
    const outcome = await renderEveningClose(db.pool, { now });

    expect(outcome.suppressed).toBe(false);
    expect(outcome.kind).toBe("close");
    const content = outcome.content!;
    // Today's decision + new commitment + completed appear.
    expect(content).toContain("Decisions made");
    expect(content).toContain("- Pick the briefing channel → stdout");
    expect(content).toContain("New commitments");
    expect(content).toContain("- Book squash court (i_owe)");
    expect(content).toContain("Completed");
    expect(content).toContain("- Pay internet bill");
    // Still waiting: fixture overdue SOW flagged.
    expect(content).toContain("OVERDUE Acme owes Jehad the signed SOW");
    // Standing risks + tomorrow's unlock (Decision A, §25 graph).
    expect(content).toContain("New risks / blocked");
    expect(content).toContain("Tomorrow's best unlock");
    expect(content).toContain("Choose the migration approach (unblocks 5 downstream items)");

    const row = (
      await db.pool.query(
        `SELECT a.kind, a.storage_backend, a.content, d.key AS domain_key, r.workflow_id
         FROM artifacts a
         JOIN runs r ON r.id = a.run_id
         JOIN domains d ON d.id = a.domain_id
         WHERE a.id = $1::uuid`,
        [outcome.artifactId],
      )
    ).rows[0];
    expect(row).toMatchObject({
      kind: "close",
      storage_backend: "postgres",
      content,
      domain_key: "personal",
      workflow_id: "brief-evening",
    });
  });

  it("evening close with nothing changed → suppressed, zero artifact rows", async () => {
    const outcome = await renderEveningClose(emptyDb.pool, { now });
    expect(outcome).toMatchObject({ kind: "close", suppressed: true, content: null, artifactId: null });
    const count = await emptyDb.pool.query(`SELECT count(*)::int AS n FROM artifacts`);
    expect(count.rows[0].n).toBe(0);
  });

  it("W5(d): same-day calendar churn renders the plan-divergence section (and un-suppresses a quiet close)", async () => {
    // Own world: plan the day at 8am PDT, churn it at 11am PDT, close at 8:30pm PDT.
    const churnDb = await createIsolatedTestDb(TEST_DATABASE_URL!, "w5cchurn");
    try {
      await migrateUp(churnDb.pool);
      await seedDomains(churnDb.pool);
      const EVENING = new Date("2026-09-18T03:30:00.000Z"); // 8:30 PM PDT Sep 17
      const T1 = new Date("2026-09-17T15:00:00.000Z"); // 8 AM PDT
      const T2 = new Date("2026-09-17T18:00:00.000Z"); // 11 AM PDT

      const planned = [
        { id: "churn-a", iCalUID: "churn-a@google.com", status: "confirmed", summary: "Henna sync",
          start: { dateTime: "2026-09-17T23:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-18T00:00:00Z", timeZone: "UTC" } },
        { id: "churn-b", iCalUID: "churn-b@google.com", status: "confirmed", summary: "Venue tour",
          start: { dateTime: "2026-09-18T01:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-18T02:00:00Z", timeZone: "UTC" } },
        { id: "churn-c", iCalUID: "churn-c@google.com", status: "confirmed", summary: "Gym block",
          start: { dateTime: "2026-09-18T00:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-18T01:00:00Z", timeZone: "UTC" } },
      ].map((e) => ({ ...e, updated: T1.toISOString() }));
      const source = (events: typeof planned, token: string): CalendarSourcePort => ({
        id: "adapter:google-calendar",
        calendarId: "churn-cal",
        listEvents: async () => ({ events, nextPageToken: null, nextSyncToken: token }),
      });
      // Pass 1: the day is planned (created observations — not churn).
      await syncCalendar(churnDb.pool, source(planned, "t1"), { now: () => T1 });

      // Pass 2: Henna sync moves 4→5:30 PM; Venue tour cancels; Gym unchanged.
      const churned = planned.map((e) => ({ ...e, updated: T2.toISOString() }));
      churned[0] = { ...churned[0]!, start: { dateTime: "2026-09-18T00:30:00Z", timeZone: "UTC" }, end: { dateTime: "2026-09-18T01:30:00Z", timeZone: "UTC" } };
      churned[1] = { ...churned[1]!, status: "cancelled" };
      await syncCalendar(churnDb.pool, source(churned, "t2"), { now: () => T2 });

      const outcome = await renderEveningClose(churnDb.pool, { now: () => EVENING });
      expect(outcome.suppressed).toBe(false);
      const content = outcome.content!;
      expect(content).toContain("Plan churn");
      expect(content).toContain(
        "- 2 of 3 blocks moved or cancelled same-day. That's plan divergence — what actually happened is unverified.",
      );
      expect(content).toContain("- Henna sync — moved");
      expect(content).toContain("- Venue tour — cancelled");
      // Plan churn only — never a claim about what actually happened.
      expect(content).not.toContain("You missed");
      expect(content).not.toContain("attended");
    } finally {
      await dropIsolatedTestDb(TEST_DATABASE_URL!, churnDb);
    }
  });
});
