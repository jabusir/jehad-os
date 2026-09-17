// packages/db/src/migrate.ts — tiny forward-only migration runner.
// Reads packages/db/migrations/*.sql (excluding *.down.sql), applies in
// lexical order inside one transaction per migration, records each in
// schema_migrations. Down migrations exist for the tested down path during
// development (AGENTS.md); production intent is forward-only.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export interface MigrationFile {
  /** File stem, e.g. "001_schema_core" — the recorded identity. */
  name: string;
  /** Absolute path of the up SQL. */
  file: string;
  /** Absolute path of the matching down SQL (required — AGENTS.md). */
  downFile: string;
  /** sha256 of the up SQL; a mismatch after apply is a hard error. */
  checksum: string;
  sql: string;
  downSql: string;
}

const MIGRATION_NAME_RE = /^\d+_[a-z0-9_]+\.sql$/;

export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../migrations");
}

/** Lists migrations in apply order; throws if any is missing its down file. */
export async function listMigrations(dir: string = defaultMigrationsDir()): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).sort();
  const migrations: MigrationFile[] = [];
  for (const entry of entries) {
    if (!MIGRATION_NAME_RE.test(entry) || entry.endsWith(".down.sql")) continue;
    const downFile = path.join(dir, entry.replace(/\.sql$/, ".down.sql"));
    const [sql, downSql] = await Promise.all([
      readFile(path.join(dir, entry), "utf8"),
      readFile(downFile, "utf8"),
    ]);
    migrations.push({
      name: entry.replace(/\.sql$/, ""),
      file: path.join(dir, entry),
      downFile,
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql,
      downSql,
    });
  }
  if (migrations.length === 0) throw new Error(`no migrations found in ${dir}`);
  return migrations;
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedChecksums(client: PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

/** Applies every pending migration in order. Returns the names applied now. */
export async function migrateUp(pool: Pool, dir: string = defaultMigrationsDir()): Promise<string[]> {
  const migrations = await listMigrations(dir);
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedChecksums(client);
    const justApplied: string[] = [];
    for (const migration of migrations) {
      const existing = applied.get(migration.name);
      if (existing !== undefined) {
        // Forward-only discipline: an applied migration's SQL must never change.
        if (existing !== migration.checksum) {
          throw new Error(
            `migration ${migration.name} was applied with a different checksum; ` +
              "write a new migration instead of editing an applied one",
          );
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        justApplied.push(migration.name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return justApplied;
  } finally {
    client.release();
  }
}

/**
 * Rolls back applied migrations in reverse order. `to` is an exclusive bound:
 * migrations lexicographically greater than `to` are rolled back. Omit `to`
 * (or pass "") to roll back everything recorded.
 */
export async function migrateDown(
  pool: Pool,
  opts: { to?: string } = {},
  dir: string = defaultMigrationsDir(),
): Promise<string[]> {
  const migrations = await listMigrations(dir);
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedChecksums(client);
    const to = opts.to ?? "";
    const rolledBack: string[] = [];
    for (const migration of [...migrations].reverse()) {
      if (!applied.has(migration.name)) continue;
      if (to !== "" && migration.name <= to) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.downSql);
        await client.query("DELETE FROM schema_migrations WHERE name = $1", [migration.name]);
        await client.query("COMMIT");
        rolledBack.push(migration.name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return rolledBack;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const toFlag = rest.indexOf("--to");
  const to = toFlag >= 0 ? rest[toFlag + 1] : undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad" });
  try {
    if (command === "up") {
      const applied = await migrateUp(pool);
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
    } else if (command === "down") {
      const rolled = await migrateDown(pool, { to });
      console.log(rolled.length ? `rolled back: ${rolled.join(", ")}` : "nothing to roll back");
    } else {
      console.error("usage: migrate.ts up | down [--to <migration-stem>]");
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
