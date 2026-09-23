// Calibration service integration tests (Lane C1). Needs PostgreSQL 16 —
// skipped unless TEST_DATABASE_URL is set (per-file isolated db). Covers:
// connected-sources-only summary collection (never listing unconnected
// sources, never raw content), idempotent open + notification enqueue,
// sole/none/ambiguous eligibility, rating store + re-rate (audit both),
// miss storage with redaction and the §20 NO-memory-candidate rule,
// classification landing on the row, quiet-day collection, the §13 weekly
// rollup (seeded + empty week), the DB-level CHECKs (item_type widening,
// target_type vocabulary, rating bounds, one-open-per-period unique), and
// spec §26: rating a healthy-sensor day with rating=1 touches no sensor
// health tables.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  CalibrationInputError,
  CalibrationNotFoundError,
  classifyMiss,
  collectCalibrationSummary,
  isQuietCalibrationDay,
  openCalibrationItem,
  eligibleCalibrationItem,
  storeCalibrationRating,
  storeMissedFeedback,
  weeklyRollup,
} from "./service.js";
import { parseCalibrationCorrection } from "../imessage/calibration-verbs.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** 1 PM PT on Sunday 2026-09-20 — civil day 2026-09-20 (PDT, UTC-7). */
const T0 = new Date("2026-09-20T20:00:00.000Z");
const DAY = "2026-09-20";
const DAY_START = "2026-09-20T07:00:00.000Z";

describe.skipIf(!TEST_DATABASE_URL)("calibration service (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "lanec1cal");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    domainId = String(
      (await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`)).rows[0]!.id,
    );
    principalId = String(
      (
        await db.pool.query(
          "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
          [`owner-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0]!.id,
    );
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  // ------------------------------------------------------------- seed utils

  function seedEvent(type: string, occurredAt: string): Promise<string> {
    const id = randomUUID();
    return db.pool
      .query(
        `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
         VALUES ($1::uuid, $2, 'internal', $3::timestamptz, $4, $5::uuid, '{}', 'normal', 1)`,
        [id, type, occurredAt, randomUUID(), domainId],
      )
      .then(() => id);
  }

  async function connectCalendar(at = DAY_START): Promise<void> {
    await db.pool.query(
      `INSERT INTO calendar_sync_state (id, calendar_id, sync_token, last_synced_at, last_page_count)
       VALUES (1, 'primary', 'tok', $1::timestamptz, 1)`,
      [at],
    );
  }

  async function connectGmail(at = DAY_START): Promise<void> {
    await db.pool.query(
      `INSERT INTO gmail_sync_state (id, cursor_history_id, health, last_tick_at)
       VALUES ('singleton', 100, $1::jsonb, $2::timestamptz)`,
      [
        JSON.stringify({
          process: "healthy",
          credential: "healthy",
          cursor: "healthy",
          decode: "healthy",
          quota: "healthy",
        }),
        at,
      ],
    );
  }

  async function seedCalendarEvent(googleEventId: string, start: string): Promise<void> {
    const sourceEventId = await seedEvent("calendar.event.created", start);
    await db.pool.query(
      `INSERT INTO calendar_events
         (google_event_id, google_calendar_id, status, summary, start_time, end_time,
          timezone, attendees, location, metadata, source_event_id, content_hash)
       VALUES ($1, 'primary', 'confirmed', 'Sync', $2::timestamptz, $3::timestamptz, NULL, '[]', NULL, '{}', $4::uuid, 'x')`,
      [googleEventId, start, new Date(new Date(start).getTime() + 3600_000).toISOString(), sourceEventId],
    );
  }

  async function seedCommitment(status: "open" | "met", createdAt: string): Promise<void> {
    const sourceEventId = await seedEvent("commitment.created", createdAt);
    await db.pool.query(
      `INSERT INTO commitments
         (direction, counterparty_text, description, confidence, status, source_event_id, domain_id, created_at, updated_at)
       VALUES ('owes_me', 'Sam', 'Return the drill', 0.9, $1, $2::uuid, $3::uuid, $4::timestamptz, $4::timestamptz)`,
      [status, sourceEventId, domainId, createdAt],
    );
  }

  const auditRows = (action: string) =>
    db.pool
      .query(`SELECT outputs_ref FROM audit_log WHERE actor = 'service:calibration' AND action = $1 ORDER BY occurred_at ASC`, [action])
      .then((r) => r.rows.map((row) => JSON.parse(String(row.outputs_ref)) as Record<string, unknown>));

  // ------------------------------------------------------- summary collection

  it("collects quiet summary when no source is connected (never lists unconnected sources)", async () => {
    const summary = await collectCalibrationSummary(db.pool, { principalId, day: DAY });
    expect(summary.entries).toEqual([]);
    expect(isQuietCalibrationDay(summary)).toBe(true);
  });

  it("collects connected-sources-only counts (calendar, commitments, gmail) and no raw content", async () => {
    await connectCalendar();
    await connectGmail();
    await seedCalendarEvent("evt-1", "2026-09-20T15:00:00.000Z");
    await seedCalendarEvent("evt-2", "2026-09-20T17:00:00.000Z");
    await seedCalendarEvent("evt-out", "2026-09-22T17:00:00.000Z"); // outside the day
    await seedCalendarEvent("evt-3", "2026-09-20T16:00:00.000Z");
    await db.pool.query(
      `UPDATE calendar_events SET status = 'cancelled' WHERE google_event_id = 'evt-3'`,
    );
    await seedCommitment("open", "2026-09-20T16:30:00.000Z");
    await seedCommitment("met", "2026-09-20T18:00:00.000Z");
    await seedCommitment("open", "2026-09-19T16:30:00.000Z"); // yesterday: excluded
    await seedEvent("gmail.message.received", "2026-09-20T12:00:00.000Z");
    await seedEvent("gmail.message.received", "2026-09-20T13:00:00.000Z");
    await seedEvent("gmail.message.received", "2026-09-21T08:00:00.000Z"); // outside (PT)

    const summary = await collectCalibrationSummary(db.pool, { principalId, day: DAY });
    expect(summary.day).toBe(DAY);
    expect(summary.entries).toEqual([
      { sourceKey: "calendar", label: "Calendar", lines: ["2 planned calendar items"] },
      { sourceKey: "commitments", label: "Commitments", lines: ["2 new commitments, 1 completed"] },
      { sourceKey: "gmail", label: "Gmail", lines: ["2 emails received"] },
    ]);
    // Epistemic classes (quality fix 2026-09-23): the met commitment is
    // OBSERVED (canonical transition); the calendar events are PLANNED —
    // present with local-time labels but never rendered as done.
    expect(summary.reconstruction?.observed).toEqual([
      { label: 'Commitment met: "Return the drill"' },
    ]);
    expect(summary.reconstruction?.planned.map((p) => p.label)).toEqual([
      "8:00 AM — Sync",
      "10:00 AM — Sync",
      "2 new commitments recorded",
    ]);
    expect(summary.reconstruction?.activity).toEqual([{ label: "2 emails arrived" }]);
    expect(summary.reconstruction?.uncertain).toContain(
      "which of the 2 scheduled items actually happened, or in what order",
    );
    // Email activity is a count with an explicit uncertainty line — never a
    // significance claim, never a body.
    expect(JSON.stringify(summary.reconstruction)).not.toMatch(/email.*about|read|inbox zero/i);
    // Never an occurrence claim for planned items:
    expect(JSON.stringify(summary.reconstruction)).not.toMatch(/you (?:did|attended)/i);
  });

  it("a connected-but-zero sensor contributes no entry (observed counts only)", async () => {
    const summary = await collectCalibrationSummary(db.pool, { principalId, day: "2026-09-24" });
    expect(summary.entries).toEqual([]); // calendar/gmail connected but nothing that day
    expect(isQuietCalibrationDay(summary)).toBe(true);
  });

  it("W5(d): same-day plan churn reaches the summary as a count line (same-day collection only)", async () => {
    // One more in-day event that moved same-day: projection row + the
    // calendar.event.updated observation (sync payload shape).
    const sourceEventId = randomUUID();
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
       VALUES ($1, 'calendar.event.updated', 'adapter:google-calendar', $2::timestamptz, $2::timestamptz, $3, $4::uuid, $5::jsonb, 'normal', 1)`,
      [
        sourceEventId,
        "2026-09-20T18:00:00.000Z",
        randomUUID(),
        domainId,
        JSON.stringify({
          changeClass: "start_end_changed",
          googleEventId: "evt-churn",
          summary: "Churned sync",
          start: "2026-09-20T22:30:00.000Z",
          previousStart: "2026-09-20T22:00:00.000Z",
        }),
      ],
    );
    await db.pool.query(
      `INSERT INTO calendar_events
         (google_event_id, google_calendar_id, status, summary, start_time, end_time,
          timezone, attendees, location, metadata, source_event_id, content_hash)
       VALUES ('evt-churn', 'primary', 'confirmed', 'Churned sync', $1::timestamptz, $2::timestamptz, NULL, '[]', NULL, '{}', $3::uuid, 'y')`,
      ["2026-09-20T22:30:00.000Z", "2026-09-20T23:30:00.000Z", sourceEventId],
    );

    // Same-day collection (the live 20:00 path): churn line present, counts only.
    const summary = await collectCalibrationSummary(db.pool, { principalId, day: DAY, now: () => T0 });
    const calendar = summary.entries.find((e) => e.sourceKey === "calendar");
    expect(calendar?.lines).toEqual([
      "3 planned calendar items",
      "1 block moved or cancelled same-day (plan churn)",
    ]);
    // Count lines stay counts-only; the event title may appear ONLY as a
    // planned label in the reconstruction (never as an occurrence claim).
    expect(JSON.stringify(summary.entries)).not.toContain("Churned sync");
    expect(summary.reconstruction?.planned.some((p) => p.label.endsWith("— Churned sync"))).toBe(true);
  });

  it("explicit occurrence graduation moves a calendar item to OBSERVED (quality fix §14)", async () => {
    // calendar already connected by the earlier summary test (shared DB)
    // evt-1 (in-day): the owner later says "it happened" → observed_missed
    // sibling path; here mark it observed_occurred with an in-day stamp.
    await db.pool.query(
      `UPDATE calendar_events SET occurrence = 'observed_occurred',
         occurrence_confirmed_by = '{"kind": "user_declared", "via": "imessage"}'::jsonb,
         updated_at = '2026-09-20T19:00:00.000Z'
       WHERE google_event_id = 'evt-1'`,
    );
    const summary = await collectCalibrationSummary(db.pool, { principalId, day: DAY });
    expect(summary.reconstruction?.observed).toContainEqual({
      label: 'You confirmed "Sync" happened',
    });
    const plannedLabels = summary.reconstruction?.planned.map((p) => p.label) ?? [];
    expect(plannedLabels.some((l) => l.endsWith("— Sync"))).toBe(true);
    // The corroborated item no longer feeds the unverifiable-planned count
    // (evt-2 + the churned event remain unverified → 2, not 3):
    expect(summary.reconstruction?.uncertain.join(" ")).toContain("2 scheduled items");
  });

  it("a completed outcome surfaces under OBSERVED with its title (quality fix §14)", async () => {
    await db.pool.query(
      `INSERT INTO outcomes (id, principal_id, ref, title, directive, status, created_by, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'OBST', 'Plaid security review', 'do the review', 'completed',
               'conversation', '2026-09-20T18:00:00.000Z', '2026-09-20T21:00:00.000Z')`,
      [randomUUID(), principalId],
    );
    const summary = await collectCalibrationSummary(db.pool, { principalId, day: DAY });
    expect(summary.reconstruction?.observed).toContainEqual({
      label: 'Outcome "Plaid security review" completed',
    });
  });

  // --------------------------------------------------------------- open item

  it("opens idempotently: one open row per (principal, day, surface), one prompt_sent audit, enqueue on notify", async () => {
    const summary = await collectCalibrationSummary(db.pool, { principalId, day: DAY });
    const first = await openCalibrationItem(db.pool, {
      principalId,
      periodDate: DAY,
      summary,
      surface: "imessage",
      now: () => T0,
    });
    expect(first.created).toBe(true);
    expect(first.item.status).toBe("open");
    expect(first.item.promptSentAt).toBe(T0.toISOString());
    expect(first.item.summary.day).toBe(DAY);

    const notificationsAfterFirst = Number(
      (await db.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'calibration'`)).rows[0]!.n,
    );

    const second = await openCalibrationItem(db.pool, {
      principalId,
      periodDate: DAY,
      summary,
      surface: "imessage",
      now: () => new Date(T0.getTime() + 3600_000),
    });
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.promptSentAt).toBe(T0.toISOString()); // send instant unchanged

    expect(await auditRows("calibration.prompt_sent")).toHaveLength(1);
    expect(
      Number(
        (await db.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'calibration'`)).rows[0]!.n,
      ),
    ).toBe(notificationsAfterFirst); // idempotent path enqueues nothing

    const third = await openCalibrationItem(db.pool, {
      principalId,
      periodDate: DAY,
      summary,
      surface: "email", // different surface: a second OPEN item
      now: () => T0,
    });
    expect(third.created).toBe(true);
    expect(third.item.id).not.toBe(first.item.id);

    // A second OPEN item for the same (principal, day, surface) is impossible.
    await expect(
      db.pool.query(
        `INSERT INTO calibration_items (principal_id, period_date, surface, summary, prompt_sent_at)
         VALUES ($1::uuid, $2::date, 'imessage', '{}', now())`,
        [principalId, DAY],
      ),
    ).rejects.toThrow();

    // Notify path: one kind=calibration notification beside a fresh item.
    const notified = await openCalibrationItem(db.pool, {
      principalId,
      periodDate: "2026-09-21",
      summary: { kind: "calibration", day: "2026-09-21", entries: [] },
      surface: "imessage",
      now: () => new Date("2026-09-21T20:00:00.000Z"),
    }, { notify: true });
    expect(notified.created).toBe(true);
    const row = (
      await db.pool.query(
        `SELECT kind, source_type, source_id, payload, status FROM notifications WHERE source_id = $1`,
        [notified.item.id],
      )
    ).rows[0]!;
    expect(row.kind).toBe("calibration");
    expect(row.source_type).toBe("calibration");
    expect(row.status).toBe("approved"); // calibration is on the ratified policy auto-approve list, loaded by the producer hook
    expect(row.payload).toMatchObject({ calibrationItemId: notified.item.id, periodDate: "2026-09-21" });
    expect(JSON.stringify(row.payload)).toContain("I don't have a strong picture of today");
  });


  it("open rejects shape deviations (bad day, summary/day mismatch, bad surface)", async () => {
    const summary = { kind: "calibration" as const, day: "2026-09-22", entries: [] };
    await expect(
      openCalibrationItem(db.pool, { principalId, periodDate: "2026/09/22", summary, now: () => T0 }),
    ).rejects.toBeInstanceOf(CalibrationInputError);
    await expect(
      openCalibrationItem(db.pool, {
        principalId,
        periodDate: "2026-09-23",
        summary: { ...summary, day: "2026-09-24" },
        now: () => T0,
      }),
    ).rejects.toBeInstanceOf(CalibrationInputError);
    await expect(
      openCalibrationItem(db.pool, {
        principalId,
        periodDate: "2026-09-22",
        summary,
        surface: "",
        now: () => T0,
      }),
    ).rejects.toBeInstanceOf(CalibrationInputError);
  });

  // ------------------------------------------------------------ eligibility

  it("eligibility: none → sole → ambiguous as open items appear (owner-local day)", async () => {
    const other = String(
      (
        await db.pool.query(
          "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
          [`other-${randomUUID().slice(0, 8)}`],
        )
      ).rows[0]!.id,
    );
    expect(await eligibleCalibrationItem(db.pool, { principalId: other, now: T0 })).toEqual({ kind: "none" });

    // principalId has TWO open items for 2026-09-20 (imessage + email) from
    // the open test → ambiguous; the defense demands surface disambiguation.
    const ambiguous = await eligibleCalibrationItem(db.pool, { principalId, now: T0 });
    expect(ambiguous).toEqual({ kind: "ambiguous", count: 2 });

    // A different principal with exactly one open item → sole.
    const sole = await openCalibrationItem(db.pool, {
      principalId: other,
      periodDate: DAY,
      summary: { kind: "calibration", day: DAY, entries: [] },
      surface: "imessage",
      now: () => T0,
    });
    expect(sole.created).toBe(true);
    const eligible = await eligibleCalibrationItem(db.pool, { principalId: other, now: T0 });
    expect(eligible.kind).toBe("sole");
    expect(eligible.kind === "sole" && eligible.item.id).toBe(sole.item.id);

    // Eligibility is day-scoped: 2026-09-22 has nothing open for `other`
    // (the 2026-09-22 item from the shape test belongs to principalId).
    const nextDay = await eligibleCalibrationItem(db.pool, {
      principalId: other,
      now: new Date("2026-09-23T20:00:00.000Z"),
    });
    expect(nextDay.kind).toBe("none");
  });

  // ------------------------------------------------------------------ rating

  it("stores a rating; re-rate overwrites the same row with both audits (idempotent)", async () => {
    const opened = await openCalibrationItem(db.pool, {
      principalId,
      periodDate: "2026-09-25",
      summary: { kind: "calibration", day: "2026-09-25", entries: [] },
      now: () => new Date("2026-09-25T20:00:00.000Z"),
    });
    const itemId = opened.item.id;
    const t1 = new Date("2026-09-25T21:00:00.000Z");
    const t2 = new Date("2026-09-25T22:00:00.000Z");

    const first = await storeCalibrationRating(db.pool, {
      principalId, itemId, rating: 4, now: () => t1,
    });
    expect(first.priorRating).toBeNull();
    expect(first.item.rating).toBe(4);
    expect(first.item.ratedAt).toBe(t1.toISOString());

    const rerate = await storeCalibrationRating(db.pool, {
      principalId, itemId, rating: 2, now: () => t2,
    });
    expect(rerate.priorRating).toBe(4);
    expect(rerate.item.rating).toBe(2);
    expect(rerate.item.ratedAt).toBe(t2.toISOString());

    const rows = (await db.pool.query(`SELECT rating, rated_at FROM calibration_items WHERE id = $1::uuid`, [itemId])).rows;
    expect(rows).toHaveLength(1); // overwritten, never appended
    expect(rows[0]!.rating).toBe(2);

    const rated = await auditRows("calibration.rated");
    const mine = rated.filter((a) => a.itemId === itemId);
    expect(mine).toEqual([
      expect.objectContaining({ rating: 4, priorRating: null, rerate: false }),
      expect.objectContaining({ rating: 2, priorRating: 4, rerate: true }),
    ]);

    await expect(
      storeCalibrationRating(db.pool, { principalId, itemId, rating: 0 }),
    ).rejects.toBeInstanceOf(CalibrationInputError);
    await expect(
      storeCalibrationRating(db.pool, { principalId, itemId, rating: 6 }),
    ).rejects.toBeInstanceOf(CalibrationInputError);
    await expect(
      storeCalibrationRating(db.pool, { principalId, itemId: randomUUID(), rating: 3, now: () => t1 }),
    ).rejects.toBeInstanceOf(CalibrationNotFoundError);
    // Principal isolation: another principal cannot rate this item.
    const stranger = String(
      (await db.pool.query("INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id", [`s-${randomUUID().slice(0, 8)}`])).rows[0]!.id,
    );
    await expect(
      storeCalibrationRating(db.pool, { principalId: stranger, itemId, rating: 5, now: () => t1 }),
    ).rejects.toBeInstanceOf(CalibrationNotFoundError);
  });

  it("DB-level CHECKs: rating bounds and status vocabulary", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO calibration_items (principal_id, period_date, summary, prompt_sent_at, rating)
         VALUES ($1::uuid, '2026-09-26', '{}', now(), 6)`,
        [principalId],
      ),
    ).rejects.toThrow();
    await expect(
      db.pool.query(
        `INSERT INTO calibration_items (principal_id, period_date, status, summary, prompt_sent_at)
         VALUES ($1::uuid, '2026-09-26', 'closed', '{}', now())`,
        [principalId],
      ),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------- miss

  it("stores misses with redaction (card number masked) and creates NO memory candidates (§20)", async () => {
    const candidatesBefore = Number(
      (await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates`)).rows[0]!.n,
    );
    const opened = await openCalibrationItem(db.pool, {
      principalId,
      periodDate: "2026-09-27",
      summary: { kind: "calibration", day: "2026-09-27", entries: [] },
      now: () => new Date("2026-09-27T20:00:00.000Z"),
    });
    const t = new Date("2026-09-27T21:00:00.000Z");

    const item = await storeMissedFeedback(db.pool, {
      principalId,
      itemId: opened.item.id,
      text: "You missed the card charge 4111 1111 1111 1111 and the slack thread",
      surface: "imessage",
      now: () => t,
    });
    expect(item.targetType).toBe("specific_item");
    expect(item.redacted).toBe(true);

    const row = (
      await db.pool.query(
        `SELECT item_type, item_id, verdict, note, created_by, target_type, target_ref,
                source_attribution, calibration_item_id, created_at
         FROM feedback WHERE id = $1::uuid`,
        [item.feedbackId],
      )
    ).rows[0]!;
    expect(row.item_type).toBe("calibration");
    expect(row.item_id).toBe(opened.item.id);
    expect(row.verdict).toBe("missed");
    expect(row.note).not.toContain("4111");
    expect(row.note).toContain("⦙redacted⦙");
    expect(row.created_by).toBe(principalId);
    expect(row.target_type).toBe("specific_item");
    expect(row.target_ref).toBe(opened.item.id);
    expect(row.source_attribution).toBe("source_not_connected");
    expect(row.calibration_item_id).toBe(opened.item.id);
    expect(new Date(row.created_at).toISOString()).toBe(t.toISOString());

    // §20 pin: NO candidate rows appeared.
    const candidatesAfter = Number(
      (await db.pool.query(`SELECT count(*)::int AS n FROM memory_candidates`)).rows[0]!.n,
    );
    expect(candidatesAfter).toBe(candidatesBefore);

    // §21 pin: the miss audit is metadata-only — no text, no note content.
    const misses = await auditRows("calibration.missed");
    const auditText = JSON.stringify(misses.find((a) => a.feedbackId === item.feedbackId));
    expect(auditText).toContain("source_not_connected");
    expect(auditText).not.toContain("4111");
    expect(auditText).not.toContain("slack thread");

    // Whole-day miss (no item): whole_day target keyed to the owner-local day.
    const wholeDay = await storeMissedFeedback(db.pool, {
      principalId,
      itemId: null,
      text: "family dinner at six",
      surface: "imessage",
      now: () => t,
    });
    expect(wholeDay.targetType).toBe("whole_day");
    expect(wholeDay.category).toBe("unknown");
    const wdRow = (
      await db.pool.query(`SELECT item_id, target_type, calibration_item_id FROM feedback WHERE id = $1::uuid`, [
        wholeDay.feedbackId,
      ])
    ).rows[0]!;
    expect(wdRow.item_id).toBe(`whole_day:2026-09-27`);
    expect(wdRow.target_type).toBe("whole_day");
    expect(wdRow.calibration_item_id).toBeNull();

    await expect(
      storeMissedFeedback(db.pool, { principalId, itemId: null, text: "   ", now: () => t }),
    ).rejects.toBeInstanceOf(CalibrationInputError);
    await expect(
      storeMissedFeedback(db.pool, { principalId, itemId: "not-a-uuid", text: "x", now: () => t }),
    ).rejects.toBeInstanceOf(CalibrationInputError);
  });

  it("stores long misses bounded to 500 chars", async () => {
    const long = "a".repeat(600);
    const result = await storeMissedFeedback(db.pool, {
      principalId,
      itemId: null,
      text: long,
      now: () => new Date("2026-09-28T20:00:00.000Z"),
    });
    const row = (
      await db.pool.query(`SELECT note FROM feedback WHERE id = $1::uuid`, [result.feedbackId])
    ).rows[0]!;
    expect(row.note).toBe("a".repeat(500));
  });

  it("classification matrix lands on the stored row (source_attribution)", async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["the granola meeting notes", "source_not_connected"],
      ["whatsapp family group", "source_not_connected"],
      ["a walk by the river", "unknown"],
    ];
    for (const [text, expected] of cases) {
      expect(classifyMiss(text)).toBe(expected);
      const stored = await storeMissedFeedback(db.pool, {
        principalId,
        itemId: null,
        text,
        now: () => new Date("2026-09-29T20:00:00.000Z"),
      });
      const row = (
        await db.pool.query(`SELECT source_attribution FROM feedback WHERE id = $1::uuid`, [stored.feedbackId])
      ).rows[0]!;
      expect(row.source_attribution).toBe(expected);
    }
  });

  it("explicit correction categories ride the structured path (quality fix §9)", async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["I did them in a different order", "wrong_sequence"],
      ["you missed the call with the landlord", "observed_but_missing"],
      ["I skipped the 3pm thing", "planned_not_observed"],
      ["the report wasn't actually done", "wrong_completion_state"],
      ["that didn't happen", "overclaim"],
    ];
    for (const [text, expected] of cases) {
      // The orchestrator parses; the service stores — explicit beats heuristic.
      const parsed = parseCalibrationCorrection(text);
      expect(parsed?.category).toBe(expected);
      const stored = await storeMissedFeedback(db.pool, {
        principalId,
        itemId: null,
        text,
        category: parsed!.category,
        now: () => new Date("2026-09-29T21:00:00.000Z"),
      });
      expect(stored.category).toBe(expected);
      const row = (
        await db.pool.query(`SELECT source_attribution FROM feedback WHERE id = $1::uuid`, [stored.feedbackId])
      ).rows[0]!;
      expect(row.source_attribution).toBe(expected);
    }
    // Explicit category beats the classifier when supplied:
    const explicit = await storeMissedFeedback(db.pool, {
      principalId,
      itemId: null,
      text: "the granola meeting notes",
      category: "wrong_priority",
      now: () => new Date("2026-09-29T21:30:00.000Z"),
    });
    expect(explicit.category).toBe("wrong_priority");
  });

  it("DB-level feedback CHECKs: widened item_type admits 'calibration'; target_type vocabulary enforced", async () => {
    const ok = await db.pool.query(
      `INSERT INTO feedback (item_type, item_id, verdict, created_by, target_type)
       VALUES ('calibration', 'probe-1', 'missed', $1, 'whole_day') RETURNING id`,
      [principalId],
    );
    expect(ok.rows).toHaveLength(1);
    await expect(
      db.pool.query(
        `INSERT INTO feedback (item_type, item_id, verdict, created_by, target_type)
         VALUES ('calibration', 'probe-2', 'missed', $1, 'somewhere')`,
        [principalId],
      ),
    ).rejects.toThrow();
  });

  // ----------------------------------------------------------- weekly rollup

  it("weekly rollup aggregates ratings, misses (+categories), and existing feedback; honest small samples", async () => {
    // Week of 2026-10-05 (Mon) .. 2026-10-11 (Sun), owner-local.
    const weekStart = "2026-10-05";
    for (let i = 0; i < 4; i++) {
      const day = `2026-10-0${5 + i}`;
      const opened = await openCalibrationItem(db.pool, {
        principalId,
        periodDate: day,
        summary: { kind: "calibration", day, entries: [] },
        now: () => new Date(`${day}T20:00:00.000Z`),
      });
      await storeCalibrationRating(db.pool, {
        principalId,
        itemId: opened.item.id,
        rating: i + 2, // 2,3,4,5 → avg 3.5
        now: () => new Date(`${day}T21:00:00.000Z`),
      });
    }
    // One miss inside the window (slack) + one outside.
    await storeMissedFeedback(db.pool, {
      principalId,
      itemId: null,
      text: "slack thread about the outage",
      now: () => new Date("2026-10-07T22:00:00.000Z"),
    });
    await storeMissedFeedback(db.pool, {
      principalId,
      itemId: null,
      text: "out of window",
      now: () => new Date("2026-10-14T22:00:00.000Z"),
    });
    // Existing-feedback verdicts inside the window.
    await db.pool.query(
      `INSERT INTO feedback (item_type, item_id, verdict, created_by, created_at)
       VALUES
         ('notification', 'r1', 'useful', $1, '2026-10-06T15:00:00.000Z'),
         ('notification', 'r2', 'useful', $1, '2026-10-07T15:00:00.000Z'),
         ('notification', 'r3', 'noise', $1, '2026-10-08T15:00:00.000Z')`,
      [principalId],
    );

    const rollup = await weeklyRollup(db.pool, { principalId, weekStart });
    expect(rollup.daysRated).toBe(4);
    expect(rollup.avgRating).toBeCloseTo(3.5, 10);
    expect(rollup.missCount).toBe(1);
    expect(rollup.missCategories).toEqual([{ category: "source_not_connected", count: 1 }]);
    expect(rollup.feedbackCounts).toEqual({ useful: 2, noise: 1, incorrect: 0 });
    expect(rollup.text).toBe(
      [
        "Calibration — week of Oct 5",
        "4 days rated, average accuracy 3.5/5",
        "1 missed (1 source_not_connected)",
        "Feedback: 2 useful · 1 noise · 0 incorrect",
      ].join("\n"),
    );

    // Empty week: no data at all.
    const empty = await weeklyRollup(db.pool, { principalId, weekStart: "2026-11-02" });
    expect(empty.avgRating).toBeNull();
    expect(empty.daysRated).toBe(0);
    expect(empty.missCount).toBe(0);
    expect(empty.text).toContain("0 days rated — too little data yet.");
  });

  // --------------------------------------------------------------- spec §26

  it("§26: all sensors healthy + rating=1 leaves sensor health tables untouched", async () => {
    // Health snapshots BEFORE (calendar + gmail were connected earlier).
    const gmailBefore = (
      await db.pool.query(`SELECT cursor_history_id, health, last_tick_at, updated_at FROM gmail_sync_state`)
    ).rows[0]!;
    const calendarBefore = (
      await db.pool.query(`SELECT calendar_id, sync_token, last_synced_at, last_page_count, updated_at FROM calendar_sync_state`)
    ).rows[0]!;

    const opened = await openCalibrationItem(db.pool, {
      principalId,
      periodDate: "2026-10-12",
      summary: { kind: "calibration", day: "2026-10-12", entries: [] },
      now: () => new Date("2026-10-12T20:00:00.000Z"),
    });
    const rated = await storeCalibrationRating(db.pool, {
      principalId,
      itemId: opened.item.id,
      rating: 1, // "all sensors healthy but the picture was wrong"
      now: () => new Date("2026-10-12T21:00:00.000Z"),
    });
    expect(rated.item.rating).toBe(1);

    const gmailAfter = (
      await db.pool.query(`SELECT cursor_history_id, health, last_tick_at, updated_at FROM gmail_sync_state`)
    ).rows[0]!;
    const calendarAfter = (
      await db.pool.query(`SELECT calendar_id, sync_token, last_synced_at, last_page_count, updated_at FROM calendar_sync_state`)
    ).rows[0]!;
    expect(gmailAfter).toEqual(gmailBefore);
    expect(calendarAfter).toEqual(calendarBefore);
  });
});
