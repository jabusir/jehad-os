// Grant-expiry reminder tick (owner directive 2026-09-21; F5). Integration
// only — the tick drives real SQL end to end. Needs PostgreSQL 16, skipped
// unless TEST_DATABASE_URL is set (per-file isolated db). Pins the F1/F2
// contract: the workflow-path grant-reminder notification lands APPROVED
// under the repo-root policy (the tick loads the config itself — never the
// default fallback), hence claimable by the edge, the once-per-grant dedupe
// holds, and (F5 fix, 2026-09-22) the reminder targets the EARLIEST-
// expiring live grant — the token the sensor actually holds.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../tests/isolated-db.js";
import { runGrantReminderTick } from "./grant-workflows.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Inside the T-48h window (grant expires in 24h).
const NOW = new Date("2026-09-24T17:15:00.000Z");
const now = (): Date => NOW;

describe.skipIf(!TEST_DATABASE_URL)("grant-expiry-reminder tick (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "wfgrantrem");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function seedGrant(expiresAt: Date): Promise<string> {
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    const grant = await db.pool.query(
      `INSERT INTO capability_grants (principal_id, capability, resource, domain_id, expires_at, token_hash)
       SELECT $1::uuid, 'imessage:ingest', 'imessage', d.id, $2::timestamptz, $3
       FROM domains d WHERE d.key = 'personal' RETURNING id`,
      [String(principal.rows[0].id), expiresAt.toISOString(), `hash-${randomUUID()}`],
    );
    return String(grant.rows[0].id);
  }

  it("inside the window: one APPROVED, claimable grant-reminder notification per grant", async () => {
    const grantId = await seedGrant(new Date(NOW.getTime() + 24 * 60 * 60 * 1000));
    const outcome = await runGrantReminderTick(db.pool, { now });
    expect(outcome).toMatchObject({ status: "reminded", grantId });

    const row = (
      await db.pool.query("SELECT id, kind, status, source_id FROM notifications WHERE id = $1::uuid", [
        outcome.status === "reminded" ? outcome.notificationId : randomUUID(),
      ])
    ).rows[0];
    expect(row).toMatchObject({ kind: "grant-reminder", status: "approved", source_id: grantId });

    // The approved row is claimable by a harness principal (the F1 root cause
    // was exactly this: pending rows are unclaimable and expire).
    const harness = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('harness', $1) RETURNING id",
      [`openclaw-${randomUUID().slice(0, 8)}`],
    );
    const claim = await db.pool.query(
      `UPDATE notifications
       SET claimed_at = $2::timestamptz, claimed_by = $1::uuid, updated_at = $2::timestamptz
       WHERE id = $3::uuid AND status = 'approved' AND claimed_at IS NULL AND expires_at > $2::timestamptz
       RETURNING id`,
      [String(harness.rows[0].id), NOW.toISOString(), row.id],
    );
    expect(claim.rows).toHaveLength(1);
  });

  it("already-reminded: a second tick enqueues nothing", async () => {
    const outcome = await runGrantReminderTick(db.pool, { now });
    expect(outcome).toMatchObject({ status: "already-reminded" });
    const count = await db.pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'grant-reminder'",
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("outside the window (only far-future grants live) → no reminder", async () => {
    // Clean world: retire the earlier, already-reminded grant so the
    // earliest-live target is the far-future one this test seeds.
    await db.pool.query("UPDATE capability_grants SET revoked_at = now() WHERE revoked_at IS NULL");
    await seedGrant(new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000));
    const outcome = await runGrantReminderTick(db.pool, { now });
    expect(outcome).toMatchObject({ status: "outside-window" });
  });

  it("F5 regression: two live grants → the reminder targets the EARLIEST (the sensor-held token), not the newest mint", async () => {
    // The 2026-09-22 finding: the sensor's Keychain held a grant expiring
    // Sep 25 while a minted-but-never-deployed Sep 28 grant existed; the
    // latest-first query aimed the reminder two days past the sensor's
    // death. Earliest-first is the conservative contract.
    await db.pool.query("UPDATE capability_grants SET revoked_at = now() WHERE revoked_at IS NULL");
    const heldToken = await seedGrant(new Date(NOW.getTime() + 26 * 60 * 60 * 1000)); // dies first
    await seedGrant(new Date(NOW.getTime() + 96 * 60 * 60 * 1000)); // newer mint, later expiry
    const outcome = await runGrantReminderTick(db.pool, { now });
    expect(outcome).toMatchObject({ status: "reminded", grantId: heldToken });
  });
});
