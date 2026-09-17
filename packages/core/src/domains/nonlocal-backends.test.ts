// Non-local domain resolution + isolation proof (integration — needs
// TEST_DATABASE_URL; isolated db, six v1 domains + two non-local domain
// rows). Proves the M4 acceptance invariants (cleanup §3; ADR-0010; T15):
//
//   federated fake: exports ONLY the allowed sanitized projection
//     ({pending_reviews: N}, no content);
//   opaque fake: no semantic payload crosses — the personal DB receives
//     nothing but existence/health/capability.
//
// "What would be persisted" is simulated by a received_projection table in
// the personal (isolated) database: everything a backend returned is written
// there, then the table is asserted on.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeFederatedBackend, FakeOpaqueBackend } from "@jehad/adapters";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { loadDomainBackendRegistry } from "./index.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CTX = { principalId: "test-principal", purpose: "attention" };

describe.skipIf(!TEST_DATABASE_URL)("non-local domain isolation (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m4cnonlocal");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    await db.pool.query(
      `INSERT INTO domains (key, name, sensitivity, retention_class, detachable, storage_mode) VALUES
         ('employer-x', 'Employer X', 'work', 'default', true, 'opaque'),
         ('work-fed',   'Federated Partner', 'work', 'default', false, 'federated')`,
    );
    await db.pool.query(`CREATE TABLE received_projection (source text NOT NULL, payload jsonb NOT NULL)`);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function received(source: string): Promise<unknown[]> {
    const result = await db.pool.query(`SELECT payload FROM received_projection WHERE source = $1`, [source]);
    return result.rows.map((row) => row.payload);
  }

  it("opaque fake: nothing but existence/health/capability reaches the personal DB", async () => {
    const opaque = new FakeOpaqueBackend({
      domainKey: "employer-x",
      internalState: {
        project: "Project Falcon",
        pending_reviews: 3,
        decision: { title: "Q4 roadmap", summary: "employer-confidential" },
      },
    });
    const registry = await loadDomainBackendRegistry(db.pool, { backends: { "employer-x": opaque } });
    const backend = registry.resolve("employer-x");
    expect(backend.mode).toBe("opaque");

    // everything the boundary can emit:
    const queryRows = (await backend.query({ kind: "attention.counts" }, CTX)).rows;
    const contextItems = (await backend.context({ purpose: "attention" }, CTX)).items;
    const health = await backend.health();
    const capabilities = await backend.capabilities();

    expect(queryRows).toEqual([]);
    expect(contextItems).toEqual([]);

    // simulate what the personal side would persist
    await db.pool.query(`INSERT INTO received_projection (source, payload) VALUES ('employer-x', $1), ('employer-x', $2)`, [
      JSON.stringify({ kind: "health", ...health }),
      JSON.stringify({ kind: "capabilities", capabilities }),
    ]);

    const persisted = await received("employer-x");
    expect(persisted).toEqual([
      { kind: "health", status: "healthy" },
      { kind: "capabilities", capabilities: [{ name: "domain.exists", available: true }] },
    ]);

    // no semantic payload crossed — scan everything the boundary emitted
    const everything = JSON.stringify({ queryRows, contextItems, health, capabilities, persisted });
    for (const forbidden of ["Falcon", "pending_reviews", "roadmap", "summary", "title", "decision"]) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it("federated fake: exports ONLY the allowed sanitized projection — no content", async () => {
    const federated = new FakeFederatedBackend({
      domainKey: "work-fed",
      reviews: [
        { title: "Confidential: Falcon launch-date decision", summary: "must never cross", pending: true },
        { title: "Confidential: vendor contract renewal", summary: "must never cross", pending: true },
        { title: "Settled: office supplies", summary: "still remote content", pending: false },
      ],
    });
    const registry = await loadDomainBackendRegistry(db.pool, { backends: { "work-fed": federated } });
    const backend = registry.resolve("work-fed");
    expect(backend.mode).toBe("federated");

    const projection = (await backend.query({ kind: "attention.counts" }, CTX)).rows;
    const contextProjection = (await backend.context({ purpose: "attention" }, CTX)).items;
    expect(projection).toEqual([{ pending_reviews: 2 }]);
    expect(contextProjection).toEqual([{ pending_reviews: 2 }]);

    // simulate what the personal side would persist
    for (const row of projection) {
      await db.pool.query(`INSERT INTO received_projection (source, payload) VALUES ('work-fed', $1)`, [JSON.stringify(row)]);
    }
    expect(await received("work-fed")).toEqual([{ pending_reviews: 2 }]);

    const everything = JSON.stringify({ projection, contextProjection, persisted: await received("work-fed") });
    for (const forbidden of ["Confidential", "Falcon", "title", "summary", "vendor", "office supplies"]) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it("local domains resolve alongside the fakes; non-local domains without a backend stay unresolvable", async () => {
    const registry = await loadDomainBackendRegistry(db.pool, { backends: { "work-fed": new FakeFederatedBackend({ domainKey: "work-fed" }) } });
    expect(registry.resolve("personal").mode).toBe("local");
    expect(registry.resolve("work-fed").mode).toBe("federated");
    expect(() => registry.resolve("employer-x")).toThrow(/no DomainBackend registered/); // deny by default
  });
});
