// Grant service tests. Unit suites run anywhere with a recording executor;
// the integration suite needs PostgreSQL 16 and is skipped unless
// TEST_DATABASE_URL is set (per-file isolated db, like packages/db).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashCapabilityToken, mintCapabilityToken } from "@jehad/adapters";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import {
  issueGrant,
  revokeGrant,
  revokeGrantsByDomain,
  revokeGrantsForRun,
  verifyGrant,
  type GrantDecision,
  type SqlExecutor,
} from "./grants";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// ---------------------------------------------------------------- unit suite

function recordingDb(
  resultRows: Record<string, unknown>[] = [],
): SqlExecutor & {
  calls: Array<{ text: string; values?: readonly unknown[] }>;
} {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  return {
    calls,
    async query(text: string, values?: readonly unknown[]) {
      calls.push({ text, values });
      return { rows: resultRows };
    },
  };
}

describe("issueGrant input validation (unit)", () => {
  it("requires an explicit expiry", async () => {
    const db = recordingDb();
    await expect(
      issueGrant(db, {
        principalId: "p1",
        runId: null,
        capability: "read_events",
        resource: "events",
        domainId: "d1",
      }),
    ).rejects.toThrow(TypeError);
    expect(db.calls).toHaveLength(0);
  });

  it("rejects expiresAt + ttlMs together and past expiries", async () => {
    const db = recordingDb();
    const base = {
      principalId: "p1",
      runId: null,
      capability: "read_events",
      resource: "events",
      domainId: "d1",
    };
    await expect(
      issueGrant(db, { ...base, expiresAt: new Date(), ttlMs: 1000 }),
    ).rejects.toThrow(TypeError);
    await expect(
      issueGrant(db, { ...base, expiresAt: new Date(Date.now() - 1000) }),
    ).rejects.toThrow(RangeError);
    expect(db.calls).toHaveLength(0);
  });

  it("persists only the token hash — the plaintext token never reaches the db", async () => {
    const rows = [
      {
        id: randomUUID(),
        principal_id: "p1",
        run_id: null,
        capability: "read_events",
        resource: "events",
        domain_id: "d1",
        expires_at: new Date(),
        revoked_at: null,
        token_hash: "h",
      },
    ];
    const db = recordingDb(rows);
    const issued = await issueGrant(db, {
      principalId: "p1",
      runId: null,
      capability: "read_events",
      resource: "events",
      domainId: "d1",
      ttlMs: 60_000,
    });
    const insert = db.calls.find((c) => c.text.startsWith("INSERT INTO capability_grants"));
    expect(insert).toBeDefined();
    // What was persisted is the hash of the minted token — never the token.
    expect(insert!.values).toContain(hashCapabilityToken(issued.token));
    expect(JSON.stringify(insert!.values)).not.toContain(issued.token);
  });
});

// -------------------------------------------------------- integration suite

describe.skipIf(!TEST_DATABASE_URL)("grant service (integration)", () => {
  let db: IsolatedDb;
  let executor: SqlExecutor;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "coregrants");
    await migrateUp(db.pool);
    executor = db.pool;
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function seedWorld(name: string): Promise<{ principalId: string; domainId: string; runId: string }> {
    const principal = await db.pool.query<{ id: string }>(
      "INSERT INTO principals (type, name, credential_hash) VALUES ('harness', $1, $2) RETURNING id",
      [`harness-${name}`, `hash-${name}-${randomUUID()}`],
    );
    const domain = await db.pool.query<{ id: string }>(
      "INSERT INTO domains (key, name, sensitivity, retention_class) VALUES ($1, $2, 'normal', 'standard') RETURNING id",
      [`key-${name}-${randomUUID().slice(0, 8)}`, name],
    );
    const run = await db.pool.query<{ id: string }>(
      "INSERT INTO runs (kind, principal_id, status, domain_id) VALUES ('workflow', $1, 'running', $2) RETURNING id",
      [principal.rows[0]!.id, domain.rows[0]!.id],
    );
    return {
      principalId: principal.rows[0]!.id,
      domainId: domain.rows[0]!.id,
      runId: run.rows[0]!.id,
    };
  }

  function issue(worker: { principalId: string; runId: string; domainId: string }) {
    return issueGrant(executor, {
      principalId: worker.principalId,
      runId: worker.runId,
      capability: "write_entity:person",
      resource: "entity:person:alice",
      domainId: worker.domainId,
      ttlMs: 60_000,
    });
  }

  function check(token: string, worker: { principalId: string; domainId: string }, overrides: Partial<Parameters<typeof verifyGrant>[2]> = {}) {
    return verifyGrant(executor, token, {
      principalId: worker.principalId,
      capability: "write_entity:person",
      resource: "entity:person:alice",
      domainId: worker.domainId,
      ...overrides,
    });
  }

  const denied = (decision: GrantDecision): string => {
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    return decision.reason;
  };

  it("valid scoped token → allowed", async () => {
    const worker = await seedWorld("valid");
    const { grant, token } = await issue(worker);
    const decision = await check(token, worker);
    expect(decision).toEqual({ allowed: true, grant });
  });

  it("no grant → denied (unknown or malformed token)", async () => {
    const worker = await seedWorld("nogrant");
    // Minted but never issued: no row behind its hash.
    const neverIssued = mintCapabilityToken({
      principal: worker.principalId,
      run_id: worker.runId,
      capability: "write_entity:person",
      resource: "entity:person:alice",
      domain: worker.domainId,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(denied(await check(neverIssued.token, worker))).toBe("unknown_token");
    // A grant row without ITS token proves nothing: a different mint over the
    // same claims has a different hash and does not resolve to the row.
    await issue(worker);
    const other = mintCapabilityToken({
      principal: worker.principalId,
      run_id: worker.runId,
      capability: "write_entity:person",
      resource: "entity:person:alice",
      domain: worker.domainId,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(denied(await check(other.token, worker))).toBe("unknown_token");
    expect(denied(await check("v1.garbage.AAAA", worker))).toBe("malformed_token");
  });

  it("expired grant → denied", async () => {
    const worker = await seedWorld("expired");
    const { token } = await issue(worker);
    const decision = await check(token, worker, { now: () => Date.now() + 61_000 });
    expect(denied(decision)).toBe("expired");
  });

  it("wrong principal → denied", async () => {
    const worker = await seedWorld("principal");
    const stranger = await seedWorld("principal-stranger");
    const { token } = await issue(worker);
    expect(denied(await check(token, stranger))).toBe("wrong_principal");
    expect((await check(token, worker)).allowed).toBe(true);
  });

  it("wrong domain → denied (token unusable outside its domain)", async () => {
    const worker = await seedWorld("domain");
    const elsewhere = await seedWorld("domain-elsewhere");
    const { token } = await issue(worker);
    expect(denied(await check(token, { ...worker, domainId: elsewhere.domainId }))).toBe("wrong_domain");
  });

  it("wrong resource → denied; capability escalation → denied", async () => {
    const worker = await seedWorld("resource");
    const { token } = await issue(worker);
    expect(
      denied(await check(token, worker, { resource: "entity:person:bob" })),
    ).toBe("wrong_resource");
    expect(
      denied(await check(token, worker, { resource: "entity:person:alice/admin" })),
    ).toBe("wrong_resource");
    expect(
      denied(await check(token, worker, { capability: "spend_budget:1000000" })),
    ).toBe("wrong_capability");
  });

  it("revoked grant → denied (revoked_at set)", async () => {
    const worker = await seedWorld("revoked");
    const { grant, token } = await issue(worker);
    const revoked = await revokeGrant(executor, grant.id);
    expect(revoked?.revokedAt).not.toBeNull();
    expect(denied(await check(token, worker))).toBe("revoked");
    // Idempotent.
    expect(await revokeGrant(executor, grant.id)).not.toBeNull();
  });

  it("grants are per-principal+run and revoked at run end", async () => {
    const workerA = await seedWorld("runend-a");
    const workerB = await seedWorld("runend-b");
    const a1 = await issue(workerA);
    const a2 = await issue(workerA);
    const b1 = await issue(workerB);

    expect(a1.grant.principalId).toBe(workerA.principalId);
    expect(a1.grant.runId).toBe(workerA.runId);
    expect(a1.token).not.toBe(a2.token); // one token per grant, never shared

    const count = await revokeGrantsForRun(executor, workerA.runId);
    expect(count).toBe(2);
    expect(denied(await check(a1.token, workerA))).toBe("revoked");
    expect(denied(await check(a2.token, workerA))).toBe("revoked");
    // Another run's grants survive this run's end.
    expect((await check(b1.token, workerB)).allowed).toBe(true);
    // Second sweep is a no-op.
    expect(await revokeGrantsForRun(executor, workerA.runId)).toBe(0);
  });

  it("kill switch: revoke grants by domain (T7), other domains unaffected", async () => {
    const victim = await seedWorld("killswitch");
    const survivor = await seedWorld("killswitch-other");
    const v1 = await issue(victim);
    const v2 = await issue(victim);
    const s = await issue(survivor);

    expect(await revokeGrantsByDomain(executor, victim.domainId)).toBe(2);
    expect(denied(await check(v1.token, victim))).toBe("revoked");
    expect(denied(await check(v2.token, victim))).toBe("revoked");
    expect((await check(s.token, survivor)).allowed).toBe(true);
  });

  it("token claims must match the canonical row (claims_mismatch)", async () => {
    const worker = await seedWorld("mismatch");
    const { grant, token } = await issue(worker);
    // Tampering the token body changes its hash — the row is simply not found.
    const [v, , nonce] = token.split(".") as [string, string, string];
    const forgedBody = Buffer.from(
      JSON.stringify({
        principal: worker.principalId,
        run_id: worker.runId,
        capability: "spend_budget:1000000",
        resource: "entity:person:alice",
        domain: worker.domainId,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf8",
    ).toString("base64url");
    expect(denied(await check(`${v}.${forgedBody}.${nonce}`, worker))).toBe("unknown_token");
    // Defense-in-depth: even if the row were mutated out from under the hash
    // (mint/store bug), presented claims that disagree with the row deny.
    await db.pool.query("UPDATE capability_grants SET resource = 'entity:person:bob' WHERE id = $1", [grant.id]);
    expect(denied(await check(token, worker))).toBe("claims_mismatch");
  });

  it("stores only the token hash — plaintext never persisted in any column", async () => {
    const worker = await seedWorld("storage");
    const { grant, token } = await issue(worker);
    const result = await db.pool.query(
      "SELECT * FROM capability_grants WHERE id = $1",
      [grant.id],
    );
    const row = result.rows[0]!;
    expect(row["token_hash"]).toBe(hashCapabilityToken(token));
    expect(row["token_hash"]).toMatch(/^[0-9a-f]{64}$/);
    for (const [column, value] of Object.entries(row)) {
      void column;
      expect(String(value)).not.toContain(token);
      expect(String(value)).not.toContain(token.split(".")[2]!); // nonce secret
    }
  });
});
