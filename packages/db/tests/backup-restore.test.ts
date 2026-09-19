// T16 regression (plan §7 M1 row, review §24): the practiced restore proves
// BOTH database rows AND artifact content survive backup → drop → restore
// (Option A: artifacts in Postgres — single backup domain). Integration only
// — skipped unless TEST_DATABASE_URL is set. Uses isolated per-file dbs.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, defaultMigrationsDir } from "../src/migrate";
import { seedDomains, V1_DOMAINS } from "../src/seed-domains";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "./test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface DomainRow {
  key: string;
  name: string;
  sensitivity: string;
  retention_class: string;
  detachable: boolean;
  storage_mode: string;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  kind: string;
  storage_backend: string;
  content: string;
  sha256: string | null;
  domain_id: string;
  sensitivity: string;
  created_at: Date;
}

interface EntityRow {
  id: string;
  discriminator: string;
  domain_id: string;
  name: string;
  external_refs: Record<string, unknown>;
  sensitivity: string;
  created_at: Date;
}

function dbUrlFor(baseDsn: string, dbName: string): string {
  const url = new URL(baseDsn);
  url.pathname = `/${dbName}`;
  return url.toString();
}

// pg tools live in brew's keg-only postgresql@16 when not on PATH
function pgBin(name: string): string {
  for (const dir of ["/opt/homebrew/opt/postgresql@16/bin", "/usr/local/opt/postgresql@16/bin"]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

const RESTORE_SH = fileURLToPath(new URL("../../../infra/dev/restore.sh", import.meta.url));

// byte-for-byte fixture: newlines, quotes, unicode, tabs, trailing spaces
const ARTIFACT_CONTENT = [
  "M1 restore proof — practiced backup/restore round-trip (T16).",
  "line 2: \"quoted\" ∑ ✓ unicode + tab\tand trailing spaces   ",
].join("\n");

describe.skipIf(!TEST_DATABASE_URL)("backup → restore (integration)", () => {
  let srcDb: IsolatedDb;
  let srcDropped = false;
  let dstDb: IsolatedDb | undefined;
  let dumpFile: string | undefined;

  let domainsBefore: DomainRow[];
  let artifactBefore: ArtifactRow;
  let entityBefore: EntityRow;

  beforeAll(async () => {
    dumpFile = path.join(
      mkdtempSync(path.join(tmpdir(), "jehad-brestore-")),
      "jehad-brestore.dump",
    );

    srcDb = await createIsolatedTestDb(TEST_DATABASE_URL!, "brestore");
    await migrateUp(srcDb.pool, defaultMigrationsDir());
    await seedDomains(srcDb.pool);

    // principals → runs → artifacts FK chain, plus one entity row
    const principal = await srcDb.pool.query<{ id: string }>(
      "INSERT INTO principals (type, name) VALUES ('user', 'brestore-proctor') RETURNING id",
    );
    const domain = await srcDb.pool.query<{ id: string }>(
      "SELECT id FROM domains WHERE key = 'personal'",
    );
    const run = await srcDb.pool.query<{ id: string }>(
      `INSERT INTO runs (kind, principal_id, domain_id, status, intent)
       VALUES ('workflow', $1, $2, 'succeeded', 'brestore proof run') RETURNING id`,
      [principal.rows[0].id, domain.rows[0].id],
    );
    await srcDb.pool.query(
      `INSERT INTO artifacts (run_id, kind, storage_backend, content, domain_id, sensitivity)
       VALUES ($1, 'eval_report', 'postgres', $2, $3, 'normal')`,
      [run.rows[0].id, ARTIFACT_CONTENT, domain.rows[0].id],
    );
    await srcDb.pool.query(
      `INSERT INTO entities (discriminator, domain_id, name, external_refs, sensitivity)
       VALUES ('person', $1, 'Restore Proof Entity', $2, 'normal')`,
      [domain.rows[0].id, JSON.stringify({ upstream: "brestore" })],
    );

    domainsBefore = (
      await srcDb.pool.query<DomainRow>(
        `SELECT key, name, sensitivity, retention_class, detachable, storage_mode
         FROM domains ORDER BY key`,
      )
    ).rows;
    artifactBefore = (
      await srcDb.pool.query<ArtifactRow>(
        `SELECT id, run_id, kind, storage_backend, content, sha256, domain_id, sensitivity, created_at
         FROM artifacts`,
      )
    ).rows[0];
    entityBefore = (
      await srcDb.pool.query<EntityRow>(
        `SELECT id, discriminator, domain_id, name, external_refs, sensitivity, created_at
         FROM entities`,
      )
    ).rows[0];
  });

  afterAll(async () => {
    if (srcDb && !srcDropped) await dropIsolatedTestDb(TEST_DATABASE_URL!, srcDb);
    if (dstDb) await dropIsolatedTestDb(TEST_DATABASE_URL!, dstDb);
    if (dumpFile) rmSync(path.dirname(dumpFile), { recursive: true, force: true });
  });

  it("restores database rows AND artifact content after the source db is dropped (T16)", async () => {
    // 1. backup: pg_dump the isolated source db in custom format
    execFileSync(pgBin("pg_dump"), ["-Fc", "-f", dumpFile, dbUrlFor(TEST_DATABASE_URL!, srcDb.dbName)]);

    // 2. destroy the source — the restore must stand on its own
    await dropIsolatedTestDb(TEST_DATABASE_URL!, srcDb);
    srcDropped = true;

    // 3. restore into a second isolated db via the real restore script
    dstDb = await createIsolatedTestDb(TEST_DATABASE_URL!, "brestore_restored");
    execFileSync("bash", [RESTORE_SH, dumpFile!, dstDb.dbName], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    });
    const pool = dstDb.pool;

    // domains: all six v1 rows survive intact
    expect(domainsBefore.map((d) => d.key)).toEqual([...V1_DOMAINS.map((d) => d.key)].sort());
    const domainsAfter = (
      await pool.query<DomainRow>(
        `SELECT key, name, sensitivity, retention_class, detachable, storage_mode
         FROM domains ORDER BY key`,
      )
    ).rows;
    expect(domainsAfter).toEqual(domainsBefore);

    // artifact content: byte-for-byte, same id and full row
    const artifactAfter = (
      await pool.query<ArtifactRow>(
        `SELECT id, run_id, kind, storage_backend, content, sha256, domain_id, sensitivity, created_at
         FROM artifacts WHERE id = $1`,
        [artifactBefore.id],
      )
    ).rows[0];
    expect(artifactAfter.content).toBe(artifactBefore.content);
    expect(artifactAfter.content).toBe(ARTIFACT_CONTENT);
    expect(artifactAfter).toEqual(artifactBefore);

    // entity row: exact match including jsonb refs
    const entityAfter = (
      await pool.query<EntityRow>(
        `SELECT id, discriminator, domain_id, name, external_refs, sensitivity, created_at
         FROM entities WHERE id = $1`,
        [entityBefore.id],
      )
    ).rows[0];
    expect(entityAfter).toEqual(entityBefore);

    // migration state rode along in the same dump
    const migrations = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    expect(migrations.rows.map((r) => r.name)).toEqual([
      "000_bootstrap_auth",
      "001_schema_core",
      "002_action_transition_guard",
      "003_evidence_links",
      "004_commitments_domain",
      "005_commitments_temporal",
      "006_notifications",
      "007_calendar",
      "008_feedback",
      "009_notification_calendar_change",
    ]);
  });
});
