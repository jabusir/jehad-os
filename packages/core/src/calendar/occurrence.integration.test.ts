// Occurrence integration tests (W5b, plan §7 W5(b) + §5 invariant 7)
// against an isolated migrated database. Owner-ratified semantics pinned
// here: time passing is NEVER evidence (sweep only labels the
// scheduled_past_unverified floor, 30-min grace, null-only, idempotent,
// lookback-bounded); ONLY explicit principal declaration graduates
// (confirmOccurrence, user_declared provenance, audited, transition-guarded
// — no silent re-graduation); cross-source signals only ever PROPOSE
// (builder output leaves occurrence untouched — DB pin; the reader queue
// drops rows once graduated); the migration CHECKs make fabricated
// observations impossible at the database. Needs PostgreSQL 16 — skipped
// unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  CalendarEventNotFoundError,
  OccurrenceAlreadyGraduatedError,
  OccurrenceInputError,
  confirmOccurrence,
  crossSourceProposals,
  proposeOccurrenceFromSignal,
  sweepPastUnverified,
} from "./occurrence.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const NOW = new Date("2026-09-21T18:00:00.000Z");
const H = 3_600_000;
const DAY = 24 * H;

interface SeedOptions {
  readonly googleEventId: string;
  readonly endOffsetMs: number; // relative to NOW
  readonly occurrence?: string | null;
  readonly occurrenceConfirmedBy?: Record<string, unknown> | null;
  readonly status?: string;
}

describe.skipIf(!TEST_DATABASE_URL)("calendar occurrence (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w5bocc");
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

  async function seedEvent(opts: SeedOptions): Promise<string> {
    const sourceEventId = randomUUID();
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
       VALUES ($1::uuid, 'calendar.event.created', 'adapter:google-calendar', $2::timestamptz, $3, $4::uuid, '{}', 'normal', 1)`,
      [sourceEventId, new Date(NOW.getTime() + opts.endOffsetMs).toISOString(), randomUUID(), domainId],
    );
    const id = randomUUID();
    const start = new Date(NOW.getTime() + opts.endOffsetMs - H).toISOString();
    const end = new Date(NOW.getTime() + opts.endOffsetMs).toISOString();
    await db.pool.query(
      `INSERT INTO calendar_events
         (id, google_event_id, google_calendar_id, status, summary, start_time, end_time,
          timezone, attendees, location, metadata, source_event_id, content_hash,
          occurrence, occurrence_confirmed_by)
       VALUES ($1::uuid, $2, 'primary', $3, $4, $5::timestamptz, $6::timestamptz, NULL, '[]', NULL, '{}',
               $7::uuid, 'x', $8, $9::jsonb)`,
      [
        id,
        opts.googleEventId,
        opts.status ?? "confirmed",
        opts.googleEventId,
        start,
        end,
        sourceEventId,
        opts.occurrence ?? null,
        opts.occurrenceConfirmedBy === null || opts.occurrenceConfirmedBy === undefined
          ? null
          : JSON.stringify(opts.occurrenceConfirmedBy),
      ],
    );
    return id;
  }

  async function occurrenceOf(id: string): Promise<{ occurrence: string | null; confirmedBy: unknown }> {
    const row = (
      await db.pool.query(
        "SELECT occurrence, occurrence_confirmed_by FROM calendar_events WHERE id = $1::uuid",
        [id],
      )
    ).rows[0]!;
    return { occurrence: row.occurrence ?? null, confirmedBy: row.occurrence_confirmed_by ?? null };
  }

  // ------------------------------------------------------------- sweep

  it("sweep marks past null-occurrence events as the floor — nothing else", async () => {
    const past = await seedEvent({ googleEventId: "s-past", endOffsetMs: -2 * H });
    const future = await seedEvent({ googleEventId: "s-future", endOffsetMs: +2 * H });
    const alreadyFloor = await seedEvent({
      googleEventId: "s-floor", endOffsetMs: -2 * H, occurrence: "scheduled_past_unverified",
    });
    const occurred = await seedEvent({
      googleEventId: "s-occurred", endOffsetMs: -2 * H, occurrence: "observed_occurred",
      occurrenceConfirmedBy: { kind: "user_declared", source: `principal:${principalId}`, at: NOW.toISOString() },
    });
    const missed = await seedEvent({
      googleEventId: "s-missed", endOffsetMs: -2 * H, occurrence: "observed_missed",
      occurrenceConfirmedBy: { kind: "user_declared", source: `principal:${principalId}`, at: NOW.toISOString() },
    });

    const report = await sweepPastUnverified(db.pool, { now: NOW });

    expect(report.marked).toBe(1); // only the null past row
    expect((await occurrenceOf(past)).occurrence).toBe("scheduled_past_unverified");
    expect((await occurrenceOf(future)).occurrence).toBeNull();
    expect((await occurrenceOf(alreadyFloor)).occurrence).toBe("scheduled_past_unverified");
    // NEVER touches observed_* — graduation is user-declared only.
    expect((await occurrenceOf(occurred)).occurrence).toBe("observed_occurred");
    expect((await occurrenceOf(missed)).occurrence).toBe("observed_missed");
  });

  it("respects the 30-minute grace (strictly past end_time only)", async () => {
    const within = await seedEvent({ googleEventId: "g-within", endOffsetMs: -29 * 60_000 });
    const boundary = await seedEvent({ googleEventId: "g-boundary", endOffsetMs: -30 * 60_000 });
    const beyond = await seedEvent({ googleEventId: "g-beyond", endOffsetMs: -31 * 60_000 });

    const report = await sweepPastUnverified(db.pool, { now: NOW });

    expect(report.marked).toBe(1);
    expect((await occurrenceOf(within)).occurrence).toBeNull();
    expect((await occurrenceOf(boundary)).occurrence).toBeNull(); // end_time < now-30min is strict
    expect((await occurrenceOf(beyond)).occurrence).toBe("scheduled_past_unverified");
  });

  it("never marks rows without an end time (cannot determine ended-ness)", async () => {
    const sourceEventId = randomUUID();
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
       VALUES ($1::uuid, 'calendar.event.created', 'adapter:google-calendar', $2::timestamptz, $3, $4::uuid, '{}', 'normal', 1)`,
      [sourceEventId, NOW.toISOString(), randomUUID(), domainId],
    );
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO calendar_events
         (id, google_event_id, google_calendar_id, status, summary, source_event_id, content_hash)
       VALUES ($1::uuid, 'no-end', 'primary', 'confirmed', 'No end', $2::uuid, 'x')`,
      [id, sourceEventId],
    );
    const report = await sweepPastUnverified(db.pool, { now: NOW });
    expect(report.marked).toBe(0);
    expect((await occurrenceOf(id)).occurrence).toBeNull();
  });

  it("lookback bounds the sweep window; lookbackHours 0 marks nothing", async () => {
    const recent = await seedEvent({ googleEventId: "lb-recent", endOffsetMs: -2 * H });
    const ancient = await seedEvent({ googleEventId: "lb-ancient", endOffsetMs: -20 * DAY });

    expect((await sweepPastUnverified(db.pool, { now: NOW, lookbackHours: 24 * 14 })).marked).toBe(1);
    expect((await occurrenceOf(recent)).occurrence).toBe("scheduled_past_unverified");
    expect((await occurrenceOf(ancient)).occurrence).toBeNull(); // outside the 14-day default

    expect((await sweepPastUnverified(db.pool, { now: NOW, lookbackHours: 0 })).marked).toBe(0);

    expect((await sweepPastUnverified(db.pool, { now: NOW, lookbackHours: 24 * 30 })).marked).toBe(1);
    expect((await occurrenceOf(ancient)).occurrence).toBe("scheduled_past_unverified"); // widened window reaches it
  });

  it("is idempotent: a second pass marks nothing", async () => {
    await seedEvent({ googleEventId: "idem", endOffsetMs: -3 * H });
    expect((await sweepPastUnverified(db.pool, { now: NOW })).marked).toBe(1);
    expect((await sweepPastUnverified(db.pool, { now: NOW })).marked).toBe(0);
  });

  it("labels cancelled events too — occurrence is orthogonal to Google's status", async () => {
    const cancelled = await seedEvent({ googleEventId: "cxl", endOffsetMs: -2 * H, status: "cancelled" });
    expect((await sweepPastUnverified(db.pool, { now: NOW })).marked).toBe(1);
    expect((await occurrenceOf(cancelled)).occurrence).toBe("scheduled_past_unverified");
  });

  it("rejects invalid lookbackHours", async () => {
    await expect(
      sweepPastUnverified(db.pool, { now: NOW, lookbackHours: Number.NaN }),
    ).rejects.toThrow(OccurrenceInputError);
  });

  // ------------------------------------------------------------ confirm

  it("graduates a null event to observed_occurred with user_declared provenance + audit", async () => {
    const id = await seedEvent({ googleEventId: "c-null", endOffsetMs: -2 * H });
    const at = new Date("2026-09-21T18:30:00.000Z");

    const result = await confirmOccurrence(db.pool, {
      calendarEventId: id,
      happened: true,
      principalId,
      now: at,
    });

    expect(result.occurrence).toBe("observed_occurred");
    expect(result.confirmedBy).toEqual({
      kind: "user_declared",
      source: `principal:${principalId}`,
      at: at.toISOString(),
    });
    const row = await occurrenceOf(id);
    expect(row.occurrence).toBe("observed_occurred");
    expect(row.confirmedBy).toEqual({
      kind: "user_declared",
      source: `principal:${principalId}`,
      at: at.toISOString(),
    });

    const audit = await db.pool.query(
      `SELECT outputs_ref FROM audit_log
        WHERE actor = $1 AND action = 'calendar.occurrence.confirmed_occurred'`,
      [`principal:${principalId}`],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.parse(String(audit.rows[0]!.outputs_ref))).toMatchObject({
      calendarEventId: id,
      googleEventId: "c-null",
      occurrence: "observed_occurred",
      at: at.toISOString(),
    });
  });

  it("graduates a swept (scheduled_past_unverified) event to observed_missed", async () => {
    const id = await seedEvent({
      googleEventId: "c-floor", endOffsetMs: -2 * H, occurrence: "scheduled_past_unverified",
    });
    const at = new Date("2026-09-21T19:00:00.000Z");

    const result = await confirmOccurrence(db.pool, {
      calendarEventId: id,
      happened: false,
      principalId,
      now: at,
    });

    expect(result.occurrence).toBe("observed_missed");
    expect(result.confirmedBy.kind).toBe("user_declared");
    expect((await occurrenceOf(id)).occurrence).toBe("observed_missed");
    const audit = await db.pool.query(
      `SELECT 1 FROM audit_log
        WHERE actor = $1 AND action = 'calendar.occurrence.confirmed_missed'`,
      [`principal:${principalId}`],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("transition guard: an observed event cannot be silently re-graduated — even same verdict", async () => {
    const id = await seedEvent({ googleEventId: "c-guard", endOffsetMs: -2 * H });
    const first = await confirmOccurrence(db.pool, {
      calendarEventId: id, happened: true, principalId, now: new Date("2026-09-21T18:10:00.000Z"),
    });
    expect(first.occurrence).toBe("observed_occurred");

    await expect(
      confirmOccurrence(db.pool, {
        calendarEventId: id, happened: false, principalId, now: new Date("2026-09-21T18:20:00.000Z"),
      }),
    ).rejects.toThrow(OccurrenceAlreadyGraduatedError);
    await expect(
      confirmOccurrence(db.pool, {
        calendarEventId: id, happened: true, principalId, now: new Date("2026-09-21T18:30:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "OCCURRENCE_ALREADY_GRADUATED", occurrence: "observed_occurred" });

    // State + provenance + audit untouched by the refused declarations.
    const row = await occurrenceOf(id);
    expect(row.occurrence).toBe("observed_occurred");
    expect((row.confirmedBy as Record<string, unknown>).at).toBe("2026-09-21T18:10:00.000Z");
    const audits = await db.pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE outputs_ref LIKE $1",
      [`%"${id}"%`],
    );
    expect(audits.rows[0]!.n).toBe(1);
  });

  it("unknown and malformed event ids are CalendarEventNotFoundError", async () => {
    await expect(
      confirmOccurrence(db.pool, {
        calendarEventId: randomUUID(), happened: true, principalId, now: NOW,
      }),
    ).rejects.toThrow(CalendarEventNotFoundError);
    await expect(
      confirmOccurrence(db.pool, {
        calendarEventId: "not-a-uuid", happened: true, principalId, now: NOW,
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_EVENT_NOT_FOUND" });
    await expect(
      confirmOccurrence(db.pool, {
        calendarEventId: randomUUID(), happened: true, principalId: "nope", now: NOW,
      }),
    ).rejects.toThrow(OccurrenceInputError);
  });

  it("the sweep never re-graduates after confirmation (guard is structural)", async () => {
    const id = await seedEvent({ googleEventId: "c-post", endOffsetMs: -2 * H });
    await confirmOccurrence(db.pool, {
      calendarEventId: id, happened: true, principalId, now: new Date("2026-09-21T18:00:00.000Z"),
    });
    await sweepPastUnverified(db.pool, { now: new Date(NOW.getTime() + DAY) });
    expect((await occurrenceOf(id)).occurrence).toBe("observed_occurred");
  });

  // ----------------------------------------------- cross-source proposals

  it("the pure builder NEVER writes occurrence (DB pin: row untouched after proposing)", async () => {
    const id = await seedEvent({ googleEventId: "p-untouched", endOffsetMs: -2 * H });
    const proposal = proposeOccurrenceFromSignal({
      calendarEventId: id,
      signalSource: "adapter:gmail",
      evidenceSummary: "confirmation email from restaurant@example.com",
      now: NOW,
    });
    expect(proposal.proposedBy.kind).toBe("cross_source_proposed");

    const row = await occurrenceOf(id);
    expect(row.occurrence).toBeNull();
    expect(row.confirmedBy).toBeNull();
  });

  it("crossSourceProposals reads pending proposals and drops them once graduated", async () => {
    const pending = await seedEvent({
      googleEventId: "p-pending",
      endOffsetMs: -2 * H,
      occurrence: "scheduled_past_unverified",
      occurrenceConfirmedBy: {
        kind: "cross_source_proposed",
        source: "adapter:gmail",
        at: NOW.toISOString(),
      },
    });
    await seedEvent({ googleEventId: "p-plain", endOffsetMs: -2 * H }); // no proposal marker
    const graduatedId = await seedEvent({ googleEventId: "p-graduated", endOffsetMs: -2 * H });
    await confirmOccurrence(db.pool, {
      calendarEventId: graduatedId, happened: true, principalId, now: NOW,
    });

    let queue = await crossSourceProposals(db.pool);
    const mine = queue.filter((row) => row.calendarEventId === pending);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      googleEventId: "p-pending",
      occurrence: "scheduled_past_unverified",
      proposedBy: { kind: "cross_source_proposed", source: "adapter:gmail", at: NOW.toISOString() },
    });
    expect(queue.some((row) => row.calendarEventId === graduatedId)).toBe(false); // graduated left the queue

    // The principal's declaration supersedes the proposal marker.
    await confirmOccurrence(db.pool, {
      calendarEventId: pending, happened: false, principalId, now: NOW,
    });
    queue = await crossSourceProposals(db.pool);
    expect(queue.some((row) => row.calendarEventId === pending)).toBe(false);
    expect((await occurrenceOf(pending)).occurrence).toBe("observed_missed");
  });

  // ---------------------------------------------------- migration CHECK pins

  it("DB pin: observed_* without user_declared provenance is impossible (CHECK violations)", async () => {
    const id = await seedEvent({ googleEventId: "chk", endOffsetMs: -2 * H });
    const attempt = (occurrence: string, confirmedBy: string | null) =>
      db.pool.query(
        `UPDATE calendar_events SET occurrence = $2, occurrence_confirmed_by = $3::jsonb WHERE id = $1::uuid`,
        [id, occurrence, confirmedBy],
      );

    await expect(attempt("observed_occurred", null)).rejects.toMatchObject({ code: "23514" });
    await expect(
      attempt("observed_missed", JSON.stringify({ kind: "cross_source_proposed", source: "adapter:gmail", at: NOW.toISOString() })),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(attempt("teleported", null)).rejects.toMatchObject({ code: "23514" });
    await expect(
      attempt("scheduled_past_unverified", JSON.stringify({ kind: "machine_guessed", source: "x", at: NOW.toISOString() })),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await occurrenceOf(id)).occurrence).toBeNull(); // every refusal left the row untouched
  });
});
