// Migration tests. The fs-based suite runs anywhere; the database suites need
// a PostgreSQL 16 instance and are skipped unless TEST_DATABASE_URL is set.
// Integration suites use per-file isolated databases (vitest parallelism).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { listMigrations, migrateUp, migrateDown, defaultMigrationsDir } from "../src/migrate";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "./test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// The 20 tables owned by 001 (principals lands separately via 000_bootstrap_auth.sql).
const TABLES_001 = [
  "domains", "events", "outbox", "entities", "commitments", "decisions",
  "assumptions", "relationships", "evidence", "memory_candidates", "procedures",
  "runs", "human_waits", "artifacts", "action_intents", "action_attempts",
  "capability_grants", "audit_log", "escalations", "model_calls",
] as const;

const ALL_MIGRATIONS = ["000_bootstrap_auth", "001_schema_core"] as const;

async function tableNames(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  return new Set(result.rows.map((row) => row.table_name));
}

describe("migration files (fs only)", () => {
  it("lists all migrations and applies in lexical order", async () => {
    const migrations = await listMigrations();
    expect(migrations.map((m) => m.name)).toEqual([...ALL_MIGRATIONS]);
  });

  it("every migration ships a tested down path (AGENTS.md)", async () => {
    const migrations = await listMigrations();
    for (const migration of migrations) {
      expect(migration.downSql.trim().length).toBeGreaterThan(0);
    }
  });

  it("down migration drops every table the up migration creates", async () => {
    const migrations = await listMigrations();
    const schema = migrations.find((m) => m.name === "001_schema_core");
    expect(schema).toBeDefined();
    for (const table of TABLES_001) {
      expect(schema!.sql).toMatch(new RegExp(`CREATE TABLE ${table}\\b`));
      expect(schema!.downSql).toMatch(new RegExp(`DROP TABLE IF EXISTS ${table}\\b`));
    }
    const bootstrap = migrations.find((m) => m.name === "000_bootstrap_auth");
    expect(bootstrap).toBeDefined();
    expect(bootstrap!.sql).toMatch(/CREATE TABLE principals\b/);
    expect(bootstrap!.downSql).toMatch(/DROP TABLE IF EXISTS principals\b/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("migrate up/down (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "migrate");
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("applies all migrations on a fresh database, records them, then fully reverses", async () => {
    const pool: Pool = db.pool;
    const applied = await migrateUp(pool, defaultMigrationsDir());
    expect(applied).toEqual([...ALL_MIGRATIONS]);

    const afterUp = await tableNames(pool);
    for (const table of TABLES_001) expect(afterUp.has(table)).toBe(true);
    expect(afterUp.has("principals")).toBe(true);
    expect(afterUp.has("schema_migrations")).toBe(true);

    const records = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
    expect(records.rows.map((r) => r.name)).toEqual([...ALL_MIGRATIONS]);

    const rolled = await migrateDown(pool, {}, defaultMigrationsDir());
    expect(rolled).toEqual([...[...ALL_MIGRATIONS].reverse()]);

    const afterDown = await tableNames(pool);
    for (const table of [...TABLES_001, "principals"]) {
      expect(afterDown.has(table)).toBe(false);
    }
    expect(afterDown.has("schema_migrations")).toBe(true);
  });

  it("is idempotent: re-up applies nothing; re-down rolls back nothing", async () => {
    const pool: Pool = db.pool;
    expect(await migrateUp(pool, defaultMigrationsDir())).toEqual([...ALL_MIGRATIONS]);
    expect(await migrateUp(pool, defaultMigrationsDir())).toEqual([]);
    expect(await migrateDown(pool, {}, defaultMigrationsDir())).toEqual(
      [...[...ALL_MIGRATIONS].reverse()],
    );
    expect(await migrateDown(pool, {}, defaultMigrationsDir())).toEqual([]);
  });
});
