// LocalBackend + registry smoke (integration — needs TEST_DATABASE_URL;
// per-file isolated database, seeded with the six v1 domains). Proves: local
// domain resolution reads local tables, with domain_id enforced on every
// read path (plan §10).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { LocalBackend, UnknownDomainError, loadDomainBackendRegistry } from "./index.js";


const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CTX = { principalId: "test-principal", purpose: "smoke" };

async function insertEvent(pool: Pool, domainKey: string, type: string, hoursAgo: number): Promise<void> {
  await pool.query(
    `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
     SELECT gen_random_uuid(), $1, 'internal', now() - ($3 || ' hours')::interval,
            'smoke-' || $1 || '-' || $2, d.id, '{}'::jsonb, 'normal', 1
     FROM domains d WHERE d.key = $2`,
    [type, domainKey, String(hoursAgo)],
  );
}

describe.skipIf(!TEST_DATABASE_URL)("local domain resolution (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m4clocal");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    await insertEvent(db.pool, "personal", "note.captured", 3);
    await insertEvent(db.pool, "personal", "commitment.captured", 2);
    await insertEvent(db.pool, "finance", "transaction.recorded", 1);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("registry resolves the six seeded local domains to LocalBackends", async () => {
    const registry = await loadDomainBackendRegistry(db.pool);
    expect(registry.keys().sort()).toEqual(["creative", "finance", "learning", "personal", "research", "work"]);
    const backend = registry.resolve("personal");
    expect(backend).toBeInstanceOf(LocalBackend);
    expect(backend.mode).toBe("local");
    expect(backend.id).toBe("local:personal");
  });

  it("LocalBackend reads local tables and sees ONLY its domain's rows", async () => {
    const backend = new LocalBackend("personal", db.pool);
    const counted = await backend.query({ kind: "events.count" }, CTX);
    expect(counted.rows).toEqual([{ count: 2 }]); // the finance row is invisible

    const recent = await backend.query({ kind: "events.recent", params: { limit: 10 } }, CTX);
    const types = (recent.rows as readonly { type: string }[]).map((r) => r.type).sort();
    expect(types).toEqual(["commitment.captured", "note.captured"]);
  });

  it("context returns only this domain's items, newest first, with a watermark", async () => {
    const backend = new LocalBackend("personal", db.pool);
    const packet = await backend.context({ purpose: "smoke" }, CTX);
    expect(packet.items).toHaveLength(2);
    const rows = packet.items as readonly { type: string; occurred_at: string }[];
    expect(rows[0]!.type).toBe("commitment.captured"); // 2h ago > 3h ago
    expect(packet.watermark).toBe(new Date(rows[0]!.occurred_at).toISOString());
  });

  it("health and capabilities are served locally", async () => {
    const backend = new LocalBackend("personal", db.pool);
    expect(await backend.health()).toEqual({ status: "healthy" });
    expect(await backend.capabilities()).toEqual([
      { name: "events.count", available: true },
      { name: "events.recent", available: true },
      { name: "context", available: true },
    ]);
  });

  it("unknown domain keys fail closed", async () => {
    const registry = await loadDomainBackendRegistry(db.pool);
    expect(() => registry.resolve("employer-x")).toThrow(UnknownDomainError);
    expect(registry.has("employer-x")).toBe(false);
  });

  it("duplicate registration is an error", async () => {
    const { DomainBackendRegistry } = await import("./index.js");
    const registry = new DomainBackendRegistry();
    registry.register("personal", new LocalBackend("personal", db.pool));
    expect(() => registry.register("personal", new LocalBackend("personal", db.pool))).toThrow(/already registered/);
  });
});
