// Per-file isolated test database (same pattern as packages/db/tests/test-db.ts;
// mirrored here because packages/db does not export its test helper).

import { Pool } from "pg";

export interface IsolatedDb {
  pool: Pool;
  dbName: string;
  /** Connection DSN for the isolated database (to hand to spawned workers). */
  dsn: string;
}

function adminUrl(baseDsn: string): string {
  const url = new URL(baseDsn);
  url.pathname = "/postgres";
  return url.toString();
}

function dbUrlFor(baseDsn: string, dbName: string): string {
  const url = new URL(baseDsn);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export async function createIsolatedTestDb(
  baseDsn: string,
  name: string,
): Promise<IsolatedDb> {
  const dbName = `jehad_test_${name}`;
  const admin = new Pool({ connectionString: adminUrl(baseDsn) });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  return {
    pool: new Pool({ connectionString: dbUrlFor(baseDsn, dbName) }),
    dbName,
    dsn: dbUrlFor(baseDsn, dbName),
  };
}

export async function dropIsolatedTestDb(baseDsn: string, db: IsolatedDb): Promise<void> {
  await db.pool.end();
  const admin = new Pool({ connectionString: adminUrl(baseDsn) });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${db.dbName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
