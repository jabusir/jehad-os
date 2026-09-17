// egressGatedModelProvider integration tests (R1/T15): the gated provider
// resolves storage_mode from the real `domains` table and denies on unknown
// domains — fail closed. Needs PostgreSQL 16; skipped unless TEST_DATABASE_URL
// is set. Uses an isolated per-file database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { EgressDenialError, ModelEgressPolicyRegistry, egressGatedModelProvider } from "./index.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("egressGatedModelProvider storage-mode enforcement (integration)", () => {
  let db: IsolatedDb;
  const dispatched: string[] = [];
  const provider = {
    id: "openrouter",
    async complete() {
      dispatched.push("openrouter");
      return { text: "ok" };
    },
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "egress");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    // A non-local domain (employer-archive style): seeded domains are all
    // `local`, so add the mode this test exercises.
    await db.pool.query(
      `INSERT INTO domains (key, name, sensitivity, retention_class, storage_mode)
       VALUES ('workarchive', 'Work Archive', 'work', 'default', 'opaque')`,
    );
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const registry = new ModelEgressPolicyRegistry([
    {
      id: "personal-normal",
      domainId: "personal",
      sensitivity: "normal",
      allowedProviders: ["openrouter"],
      allowRemote: false,
      requireRedaction: false,
    },
    {
      id: "workarchive-normal",
      domainId: "workarchive",
      sensitivity: "normal",
      allowedProviders: ["openrouter"],
      allowRemote: false,
      requireRedaction: false,
    },
  ]);

  it("R1 regression: a non-local domain is denied even though the request names no storageMode", async () => {
    // Before R1 the gated provider never passed storageMode, so this request
    // was ALLOWED under allowRemote=false (fail-open). The provider must not
    // be invoked now.
    const gated = egressGatedModelProvider(provider, registry, db.pool);
    const before = dispatched.length;
    await expect(
      gated.complete({ domainId: "workarchive", sensitivity: "normal", provider: "openrouter", model: "m", prompt: "p" }),
    ).rejects.toMatchObject({ name: "EgressDenialError", audit: { reason: "remote_content_forbidden" } });
    expect(dispatched).toHaveLength(before);
  });

  it("R1 regression: an unknown domain denies fail-closed", async () => {
    const gated = egressGatedModelProvider(provider, registry, db.pool);
    const before = dispatched.length;
    await expect(
      gated.complete({ domainId: "ghost", sensitivity: "normal", provider: "openrouter", model: "m", prompt: "p" }),
    ).rejects.toMatchObject({ name: "EgressDenialError", audit: { reason: "unknown_domain" } });
    expect(dispatched).toHaveLength(before);
  });

  it("a local domain still dispatches", async () => {
    const gated = egressGatedModelProvider(provider, registry, db.pool);
    const before = dispatched.length;
    const result = await gated.complete({ domainId: "personal", sensitivity: "normal", provider: "openrouter", model: "m", prompt: "p" });
    expect(result.text).toBe("ok");
    expect(dispatched).toHaveLength(before + 1);
  });

  it("flipping a domain to non-local at runtime flips the decision (no cached opt-out)", async () => {
    await db.pool.query("UPDATE domains SET storage_mode = 'remote' WHERE key = 'personal'");
    const gated = egressGatedModelProvider(provider, registry, db.pool);
    try {
      await expect(
        gated.complete({ domainId: "personal", sensitivity: "normal", provider: "openrouter", model: "m", prompt: "p" }),
      ).rejects.toBeInstanceOf(EgressDenialError);
    } finally {
      await db.pool.query("UPDATE domains SET storage_mode = 'local' WHERE key = 'personal'");
    }
  });
});
