// Date-trust overdue gating integration tests (owner directive 2026-09-17):
// an overdue flag fires ONLY for trustworthy due dates — calendar-native, or
// normalized with resolutionConfidence >= trustThreshold (default 0.9).
// Ambiguous / low-confidence-normalized / legacy (no temporal block) past-due
// dates NEVER auto-flag overdue; they surface needsReview:
// "ambiguous_due_date". Also covers the pre-W6A schema fallback: without the
// commitments.temporal column every past-due row is legacy → fail closed.
// Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { seedQueryFixtureWorld, type FixtureIds } from "./fixtures.js";
import { whatAmIWaitingFor, whatWaitsOnMe } from "./waiting.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-17T12:00:00.000Z");
const now = (): Date => NOW;

describe.skipIf(!TEST_DATABASE_URL)("overdue date-trust gating (integration)", () => {
  let db: IsolatedDb;
  let legacyDb: IsolatedDb | undefined;
  let f: FixtureIds;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w6ctrust");
    await migrateUp(db.pool);
    f = await seedQueryFixtureWorld(db.pool, { now: NOW });
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
    if (legacyDb !== undefined) await dropIsolatedTestDb(TEST_DATABASE_URL!, legacyDb);
  });

  it("calendar-native resolved past-due → overdue fires, no needsReview", async () => {
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now });
    expect(mine.find((c) => c.id === f.commitments.mineOverdue)).toMatchObject({
      overdue: true,
      needsReview: null,
    });
    const waiting = await whatAmIWaitingFor(db.pool, { domainId: "personal", now });
    expect(waiting.find((c) => c.id === f.commitments.waitingOverdue)).toMatchObject({
      overdue: true,
      needsReview: null,
    });
  });

  it("normalized resolved past-due at/above the 0.9 threshold → overdue fires", async () => {
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now });
    const item = mine.find((c) => c.id === f.commitments.mineNormalizedPast)!;
    expect(item).toBeDefined();
    expect(item.overdue).toBe(true);
    expect(item.needsReview).toBeNull();
  });

  it("ambiguous past-due (null normalizedTime) → NO overdue, needsReview set (both directions)", async () => {
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now });
    expect(mine.find((c) => c.id === f.commitments.mineAmbiguousPast)).toMatchObject({
      overdue: false,
      needsReview: "ambiguous_due_date",
    });
    const waiting = await whatAmIWaitingFor(db.pool, { domainId: "personal", now });
    expect(waiting.find((c) => c.id === f.commitments.waitingAmbiguousPast)).toMatchObject({
      overdue: false,
      needsReview: "ambiguous_due_date",
    });
  });

  it("normalized past-due below the trust threshold → NO overdue, needsReview set", async () => {
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now });
    expect(mine.find((c) => c.id === f.commitments.mineLowConfidencePast)).toMatchObject({
      overdue: false,
      needsReview: "ambiguous_due_date",
    });
  });

  it("legacy row (no temporal block) past due → NO auto-overdue, needsReview (fail closed)", async () => {
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now });
    expect(mine.find((c) => c.id === f.commitments.mineLegacyPast)).toMatchObject({
      overdue: false,
      needsReview: "ambiguous_due_date",
    });
  });

  it("null due_at without temporal keeps the identical legacy behavior", async () => {
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now });
    expect(mine.find((c) => c.id === f.commitments.mineNoDue)).toMatchObject({
      overdue: false,
      dueSoon: false,
      needsReview: null,
    });
  });

  it("an untrusted past-due date never resurfaces as due-soon", async () => {
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now, dueSoonDays: 30 });
    const item = mine.find((c) => c.id === f.commitments.mineAmbiguousPast)!;
    expect(item.overdue).toBe(false);
    expect(item.dueSoon).toBe(false);
    expect(item.needsReview).toBe("ambiguous_due_date");
  });

  it("trustThreshold is configurable: 0.7 lets the 0.7-confidence normalized date drive overdue", async () => {
    const mine = await whatWaitsOnMe(db.pool, { domainId: "personal", now, trustThreshold: 0.7 });
    expect(mine.find((c) => c.id === f.commitments.mineLowConfidencePast)).toMatchObject({
      overdue: true,
      needsReview: null,
    });
    // Ambiguity is never threshold-fixable.
    expect(mine.find((c) => c.id === f.commitments.mineAmbiguousPast)!.overdue).toBe(false);
  });

  it("rejects an out-of-range trustThreshold", async () => {
    await expect(whatWaitsOnMe(db.pool, { now, trustThreshold: 1.5 })).rejects.toThrow(RangeError);
    await expect(whatAmIWaitingFor(db.pool, { now, trustThreshold: -0.1 })).rejects.toThrow(
      RangeError,
    );
  });

  // ---- pre-W6A schema fallback: the temporal column itself is absent ------
  it("without the commitments.temporal column every past-due row fails closed to needsReview", async () => {
    legacyDb = await createIsolatedTestDb(TEST_DATABASE_URL!, "w6cnocol");
    await migrateUp(legacyDb.pool);
    await seedDomains(legacyDb.pool);
    const domains = await legacyDb.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    const domainId = String(domains.rows[0].id);

    async function seedCommitment(dueDaysAgo: number | null): Promise<string> {
      const id = randomUUID();
      const at = dueDaysAgo === null ? NOW : new Date(NOW.getTime() - dueDaysAgo * 86_400_000);
      await legacyDb.pool.query(
        `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                             domain_id, payload, sensitivity, schema_version)
         VALUES ($1, 'capture.recorded', 'cli.capture', $2::timestamptz, $2::timestamptz, $3,
                 $4::uuid, '{}'::jsonb, 'normal', 1)`,
        [id, NOW.toISOString(), `sha256:${randomUUID()}`, domainId],
      );
      const inserted = await legacyDb.pool.query(
        `INSERT INTO commitments (domain_id, direction, counterparty_text, description,
                                  due_at, confidence, status, source_event_id, created_at, updated_at)
         VALUES ($1::uuid, 'i_owe', 'Legacy Co', $2, $3::timestamptz, 0.9, 'open', $4::uuid,
                 $5::timestamptz, $5::timestamptz)
         RETURNING id`,
        [domainId, `legacy-${dueDaysAgo}`, at.toISOString(), id, NOW.toISOString()],
      );
      return String(inserted.rows[0].id);
    }

    const pastDue = await seedCommitment(2);
    const noDue = await seedCommitment(null);

    const mine = await whatWaitsOnMe(legacyDb.pool, { now });
    expect(mine.find((c) => c.id === pastDue)).toMatchObject({
      overdue: false,
      needsReview: "ambiguous_due_date",
    });
    expect(mine.find((c) => c.id === noDue)).toMatchObject({
      overdue: false,
      needsReview: null,
    });
  });
});
