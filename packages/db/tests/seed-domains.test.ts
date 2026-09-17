// Domain seed tests. Integration only — needs PostgreSQL 16 and is skipped
// unless TEST_DATABASE_URL is set. Uses an isolated per-file database.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrateUp, defaultMigrationsDir } from "../src/migrate";
import { seedDomains, V1_DOMAINS } from "../src/seed-domains";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "./test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("seedDomains (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "seed");
    await migrateUp(db.pool, defaultMigrationsDir());
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("seeds exactly the six v1 domains, all storage_mode=local (A16), and is idempotent", async () => {
    const pool = db.pool;
    await seedDomains(pool);
    await seedDomains(pool); // second run must neither duplicate nor fail

    const result = await pool.query<{
      key: string;
      storage_mode: string;
      detachable: boolean;
    }>("SELECT key, storage_mode, detachable FROM domains ORDER BY key");

    expect(result.rows.map((r) => r.key)).toEqual(
      V1_DOMAINS.map((d) => d.key).sort(),
    );
    expect(result.rows).toHaveLength(6);
    for (const row of result.rows) {
      expect(row.storage_mode).toBe("local");
    }
    const work = result.rows.find((r) => r.key === "work");
    expect(work?.detachable).toBe(true);
    const nonWork = result.rows.filter((r) => r.key !== "work");
    for (const row of nonWork) expect(row.detachable).toBe(false);
  });
});
