// Migration tests. The fs-based suite runs anywhere; the database suites need
// a PostgreSQL 16 instance and are skipped unless TEST_DATABASE_URL is set
// (vitest, run later once the toolchain lands — Lane A / M0).

import { describe, it, expect } from "vitest";
import { Pool } from "pg";
import { listMigrations, migrateUp, migrateDown, defaultMigrationsDir } from "../src/migrate";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const dsn = TEST_DATABASE_URL ?? "";

// The 20 tables owned by 001 (principals lands separately via 000_bootstrap_auth.sql).
const TABLES_001 = [
  "domains", "events", "outbox", "entities", "commitments", "decisions",
  "assumptions", "relationships", "evidence", "memory_candidates", "procedures",
  "runs", "human_waits", "artifacts", "action_intents", "action_attempts",
  "capability_grants", "audit_log", "escalations", "model_calls",
] as const;

async function tableNames(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  return new Set(result.rows.map((row) => row.table_name));
}

describe("migration files (fs only)", () => {
  it("lists 001 and applies in lexical order", async () => {
    const migrations = await listMigrations();
    expect(migrations.map((m) => m.name)).toEqual(["001_schema_core"]);
  });

  it("every migration ships a tested down path (AGENTS.md)", async () => {
    const migrations = await listMigrations();
    for (const migration of migrations) {
      expect(migration.downSql.trim().length).toBeGreaterThan(0);
    }
  });

  it("down migration drops every table the up migration creates", async () => {
    const [migration] = await listMigrations();
    expect(migration).toBeDefined();
    for (const table of TABLES_001) {
      expect(migration!.sql).toMatch(new RegExp(`CREATE TABLE ${table}\\b`));
      expect(migration!.downSql).toMatch(new RegExp(`DROP TABLE IF EXISTS ${table}\\b`));
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("migrate up/down (integration)", () => {
  it("applies 001 on a fresh database, records it, then fully reverses", async () => {
    const pool = new Pool({ connectionString: dsn });
    try {
      const applied = await migrateUp(pool, defaultMigrationsDir());
      expect(applied).toEqual(["001_schema_core"]);

      const afterUp = await tableNames(pool);
      for (const table of TABLES_001) expect(afterUp.has(table)).toBe(true);
      expect(afterUp.has("schema_migrations")).toBe(true);

      const records = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
      expect(records.rows.map((r) => r.name)).toEqual(["001_schema_core"]);

      const rolled = await migrateDown(pool, {}, defaultMigrationsDir());
      expect(rolled).toEqual(["001_schema_core"]);

      const afterDown = await tableNames(pool);
      for (const table of TABLES_001) expect(afterDown.has(table)).toBe(false);
      expect(afterDown.has("schema_migrations")).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("is idempotent: a second up applies nothing and down rolls back nothing", async () => {
    const pool = new Pool({ connectionString: dsn });
    try {
      await migrateUp(pool, defaultMigrationsDir());
      expect(await migrateUp(pool, defaultMigrationsDir())).toEqual([]);
      expect(await migrateDown(pool, {}, defaultMigrationsDir())).toEqual([]);
      await migrateUp(pool, defaultMigrationsDir()); // leave the schema up
    } finally {
      await pool.end();
    }
  });
});
