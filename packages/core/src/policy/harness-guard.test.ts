// Harness grant guard tests (E4). The integration suite needs PostgreSQL 16
// (skipped unless TEST_DATABASE_URL) and drives the guard exactly as the
// /harness routes do: harness principals act only through a capability token
// that verifies server-side against capability_grants; users bypass (owner);
// everything else is denied. Every denial must be audited (harness.grant_denied).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashCapabilityToken, mintCapabilityToken } from "@jehad/adapters";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { issueGrant, revokeGrantsForRun } from "./grants.js";
import {
  HARNESS_CAPABILITIES,
  checkHarnessGrant,
  type HarnessGuardDecision,
} from "./harness-guard.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** The claim/delivered seam requirement AFTER the E4-S capability alias. */
const REQUIRED = {
  capabilities: [
    HARNESS_CAPABILITIES.deliverNotifications,
    HARNESS_CAPABILITIES.sendChannelImessage,
  ],
  resource: "notifications",
};

describe.skipIf(!TEST_DATABASE_URL)("harness grant guard (integration)", () => {
  let db: IsolatedDb;
  let harnessId: string;
  let otherHarnessId: string;
  let userId: string;
  let serviceId: string;
  let domainId: string;
  let runId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "e4guard");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    domainId = String(domain.rows[0].id);

    const principal = async (type: string): Promise<string> => {
      const row = await db.pool.query(
        "INSERT INTO principals (type, name) VALUES ($1, $2) RETURNING id",
        [type, `${type}-${randomUUID().slice(0, 8)}`],
      );
      return String(row.rows[0].id);
    };
    harnessId = await principal("harness");
    otherHarnessId = await principal("harness");
    userId = await principal("user");
    serviceId = await principal("service");

    const run = await db.pool.query(
      `INSERT INTO runs (kind, principal_id, status, domain_id)
       VALUES ('harness', $1, 'running', $2) RETURNING id`,
      [harnessId, domainId],
    );
    runId = String(run.rows[0].id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function check(
    context: { principalId?: string; principalType?: string; capabilityToken?: string; now?: () => number },
  ): Promise<HarnessGuardDecision> {
    return checkHarnessGrant(
      db.pool,
      {
        principalName: "openclaw",
        ...context,
      },
      REQUIRED,
    );
  }

  function issue(overrides: Partial<Parameters<typeof issueGrant>[1]> = {}) {
    return issueGrant(db.pool, {
      principalId: harnessId,
      runId,
      capability: HARNESS_CAPABILITIES.deliverNotifications,
      resource: REQUIRED.resource,
      domainId,
      ttlMs: 60 * 60_000,
      ...overrides,
    });
  }

  async function denialReason(decision: HarnessGuardDecision): Promise<string> {
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    return decision.code;
  }

  async function guardDenials(): Promise<string[]> {
    const rows = await db.pool.query(
      "SELECT outputs_ref::jsonb->>'reason' AS reason FROM audit_log WHERE action = 'harness.grant_denied'",
    );
    return rows.rows.map((row) => String(row.reason));
  }

  async function lastDenialOutputs(): Promise<Record<string, unknown>> {
    const rows = await db.pool.query(
      "SELECT outputs_ref::jsonb AS outputs FROM audit_log WHERE action = 'harness.grant_denied' ORDER BY created_at DESC LIMIT 1",
    );
    return rows.rows[0].outputs as Record<string, unknown>;
  }

  it("harness + valid scoped token → allowed with the grant id", async () => {
    const { grant, token } = await issue();
    const decision = await check({ principalId: harnessId, principalType: "harness", capabilityToken: token });
    expect(decision).toEqual({
      allowed: true,
      grantId: grant.id,
      bypass: "grant",
      capability: HARNESS_CAPABILITIES.deliverNotifications,
    });
  });

  it("E4-S alias: a send_channel:imessage grant passes the claim/delivered seam and records WHICH capability matched", async () => {
    const { grant, token } = await issue({ capability: HARNESS_CAPABILITIES.sendChannelImessage });
    const decision = await check({ principalId: harnessId, principalType: "harness", capabilityToken: token });
    expect(decision).toEqual({
      allowed: true,
      grantId: grant.id,
      bypass: "grant",
      capability: HARNESS_CAPABILITIES.sendChannelImessage,
    });
  });

  it("E4-S alias: a capability outside the accepted list still denies (wrong_capability) + audits the list", async () => {
    const outsider = await issue({
      capability: HARNESS_CAPABILITIES.stateSummary,
      resource: "state-summary",
    });
    expect(
      await denialReason(
        await check({ principalId: harnessId, principalType: "harness", capabilityToken: outsider.token }),
      ),
    ).toBe("wrong_capability");
    const outputs = await lastDenialOutputs();
    expect(outputs["capabilities"]).toEqual([...REQUIRED.capabilities]);
    expect(outputs["reason"]).toBe("wrong_capability");
    expect(await guardDenials()).toContain("wrong_capability");
  });

  it("user principal bypasses the grant layer (owner)", async () => {
    const decision = await check({ principalId: userId, principalType: "user" });
    expect(decision).toEqual({ allowed: true, grantId: null, bypass: "owner", capability: null });
  });

  it("service principals are denied everywhere + audited", async () => {
    expect(
      await denialReason(await check({ principalId: serviceId, principalType: "service" })),
    ).toBe("principal_type_forbidden");
    expect(await guardDenials()).toContain("principal_type_forbidden");
  });

  it("harness without a capability token → denied + audited", async () => {
    expect(
      await denialReason(await check({ principalId: harnessId, principalType: "harness" })),
    ).toBe("missing_capability_token");
    expect(await guardDenials()).toContain("missing_capability_token");
  });

  it("forged tokens deny: self-minted (no row), tampered, malformed — all audited", async () => {
    await issue();
    // Self-minted with escalated claims: no row behind its hash.
    const forged = mintCapabilityToken({
      principal: harnessId,
      run_id: runId,
      capability: "admin:everything",
      resource: "*",
      domain: domainId,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(
      await denialReason(
        await check({ principalId: harnessId, principalType: "harness", capabilityToken: forged.token }),
      ),
    ).toBe("unknown_token");
    expect(
      await denialReason(
        await check({ principalId: harnessId, principalType: "harness", capabilityToken: "v1.garbage.AAAA" }),
      ),
    ).toBe("malformed_token");
    expect(await guardDenials()).toContain("unknown_token");
    expect(await guardDenials()).toContain("malformed_token");
  });

  it("a real token cannot cross scope: wrong capability, wrong resource, wrong principal", async () => {
    const readGrant = await issue({
      capability: HARNESS_CAPABILITIES.stateSummary,
      resource: "state-summary",
    });
    // Presenting the read grant at the delivery seam.
    expect(
      await denialReason(
        await check({ principalId: harnessId, principalType: "harness", capabilityToken: readGrant.token }),
      ),
    ).toBe("wrong_capability");

    const otherResource = await issue({ resource: "somewhere-else" });
    expect(
      await denialReason(
        await check({ principalId: harnessId, principalType: "harness", capabilityToken: otherResource.token }),
      ),
    ).toBe("wrong_resource");

    const stranger = await issue({ principalId: otherHarnessId });
    expect(
      await denialReason(
        await check({ principalId: harnessId, principalType: "harness", capabilityToken: stranger.token }),
      ),
    ).toBe("wrong_principal");
  });

  it("expired grant → denied; revoked-by-run grant → denied", async () => {
    const short = await issue({ ttlMs: undefined, expiresAt: new Date(Date.now() + 30_000) });
    expect(
      await denialReason(
        await check({
          principalId: harnessId,
          principalType: "harness",
          capabilityToken: short.token,
          now: () => Date.now() + 31_000,
        }),
      ),
    ).toBe("expired");

    const doomed = await issue();
    await revokeGrantsForRun(db.pool, runId);
    expect(
      await denialReason(
        await check({ principalId: harnessId, principalType: "harness", capabilityToken: doomed.token }),
      ),
    ).toBe("revoked");
    expect(await guardDenials()).toContain("expired");
    expect(await guardDenials()).toContain("revoked");
  });

  it("the stored grant keeps only the token hash (possession secret never persisted)", async () => {
    const { token } = await issue({ principalId: otherHarnessId, runId: null });
    const rows = await db.pool.query(
      "SELECT * FROM capability_grants WHERE token_hash = $1",
      [hashCapabilityToken(token)],
    );
    expect(rows.rows).toHaveLength(1);
    for (const value of Object.values(rows.rows[0]!)) {
      expect(String(value)).not.toContain(token);
    }
  });
});
