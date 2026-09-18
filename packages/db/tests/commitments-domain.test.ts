// 004_commitments_domain backfill correctness (Wave 5, M6A flag): pre-004
// commitments rows — which carry no domain_id and derive their domain via
// source_event_id → events.domain_id — must land on their source event's
// domain when 004 applies, including the work-domain isolation case.
// Integration only — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, migrateDown, defaultMigrationsDir } from "../src/migrate";
import { seedDomains } from "../src/seed-domains";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "./test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("004 commitments.domain_id backfill (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w5commitdom");
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function domainIdOf(key: string): Promise<string> {
    const row = await db.pool.query<{ id: string }>(`SELECT id FROM domains WHERE key = $1`, [key]);
    return String(row.rows[0]!.id);
  }

  async function insertLegacyCommitment(domainKey: string, description: string): Promise<string> {
    const eventId = randomUUID();
    const at = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                           domain_id, payload, sensitivity, schema_version)
       VALUES ($1, 'capture.recorded', 'cli.capture', $2::timestamptz, $2::timestamptz, $3,
               $4::uuid, $5::jsonb, 'normal', 1)`,
      [eventId, at, `sha256:${randomUUID()}`, await domainIdOf(domainKey), JSON.stringify({ text: description })],
    );
    const inserted = await db.pool.query<{ id: string }>(
      `INSERT INTO commitments (direction, counterparty_text, description, due_at, confidence,
                                status, source_event_id)
       VALUES ('i_owe', 'self', $1, NULL, 0.9, 'open', $2::uuid)
       RETURNING id`,
      [description, eventId],
    );
    return String(inserted.rows[0]!.id);
  }

  it("backfills domain_id from each commitment's source event domain (incl. work)", async () => {
    const pool = db.pool;

    // 1. Reach the pre-004 shape: full up (proves 004 applies cleanly), then
    //    roll back exactly 004 — its down path drops the column.
    await migrateUp(pool, defaultMigrationsDir());
    expect(await migrateDown(pool, { to: "003_evidence_links" }, defaultMigrationsDir())).toEqual([
      "008_feedback",
      "007_calendar",
      "006_notifications",
      "005_commitments_temporal",
      "004_commitments_domain",
    ]);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'commitments' AND column_name = 'domain_id'`,
    );
    expect(columns.rows).toEqual([]);

    // 2. Seed legacy rows whose domain lives only on their source events.
    await seedDomains(pool);
    const personalId = await insertLegacyCommitment("personal", "Pay October rent");
    const workId = await insertLegacyCommitment("work", "Ship the quarterly review deck");

    expect(await migrateUp(pool, defaultMigrationsDir())).toEqual([
      "004_commitments_domain",
      "005_commitments_temporal",
      "006_notifications",
      "007_calendar",
      "008_feedback",
    ]);

    const rows = (
      await pool.query<{ id: string; domain_id: string }>(
        `SELECT id, domain_id FROM commitments WHERE id = ANY($1::uuid[])`,
        [[personalId, workId]],
      )
    ).rows;
    const byId = new Map(rows.map((row) => [row.id, row.domain_id]));
    expect(byId.get(personalId)).toBe(await domainIdOf("personal"));
    expect(byId.get(workId)).toBe(await domainIdOf("work"));

    // 4. Column is NOT NULL and the (domain_id, status) index exists.
    const nullable = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'commitments' AND column_name = 'domain_id'`,
    );
    expect(nullable.rows[0]!.is_nullable).toBe("NO");
    const index = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'commitments' AND indexname = 'commitments_domain_status_idx'`,
    );
    expect(index.rows).toHaveLength(1);

    // 5. A post-backfill down path still reverses 004 cleanly (005+ first).
    expect(await migrateDown(pool, { to: "003_evidence_links" }, defaultMigrationsDir())).toEqual([
      "008_feedback",
      "007_calendar",
      "006_notifications",
      "005_commitments_temporal",
      "004_commitments_domain",
    ]);
  });
});
