// packages/db/src/seed-domains.ts — seed the six v1 domains (plan §10; A16:
// all six are storage_mode=local in v1). Idempotent upsert on key.
// This is the ONLY data seeding in M1 (no other table is seeded).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export interface DomainSeed {
  key: string;
  name: string;
  sensitivity: string;
  retention_class: string;
  detachable: boolean;
  storage_mode: "local" | "remote" | "federated" | "opaque";
}

// sensitivity/retention_class vocabularies are not enumerated in plan §7;
// values below are the v1 defaults. Finance carries the stricter marker and
// work is the detachable domain (plan §10: exportable + deletable as a unit,
// excluded from personal semantic promotion — plan §6.2 gate 2).
export const V1_DOMAINS: DomainSeed[] = [
  { key: "personal", name: "Personal",       sensitivity: "normal",  retention_class: "default", detachable: false, storage_mode: "local" },
  { key: "finance",  name: "Finance",        sensitivity: "finance", retention_class: "default", detachable: false, storage_mode: "local" },
  { key: "research", name: "Research",       sensitivity: "normal",  retention_class: "default", detachable: false, storage_mode: "local" },
  { key: "learning", name: "Learning",       sensitivity: "normal",  retention_class: "default", detachable: false, storage_mode: "local" },
  { key: "creative", name: "Creative",       sensitivity: "normal",  retention_class: "default", detachable: false, storage_mode: "local" },
  { key: "work",     name: "Work",           sensitivity: "work",    retention_class: "default", detachable: true,  storage_mode: "local" },
];

const UPSERT = `
  INSERT INTO domains (key, name, sensitivity, retention_class, detachable, storage_mode)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (key) DO UPDATE SET
    name           = EXCLUDED.name,
    sensitivity    = EXCLUDED.sensitivity,
    retention_class = EXCLUDED.retention_class,
    detachable     = EXCLUDED.detachable,
    storage_mode   = EXCLUDED.storage_mode,
    updated_at     = now()
`;

/** Upserts the six v1 domains. Returns the number of rows written. */
export async function seedDomains(pool: Pool, domains: DomainSeed[] = V1_DOMAINS): Promise<number> {
  let written = 0;
  for (const domain of domains) {
    await pool.query(UPSERT, [
      domain.key,
      domain.name,
      domain.sensitivity,
      domain.retention_class,
      domain.detachable,
      domain.storage_mode,
    ]);
    written += 1;
  }
  return written;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad" });
  try {
    const written = await seedDomains(pool);
    console.log(`seeded ${written} domains`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
