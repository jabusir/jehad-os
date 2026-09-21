// Verifier C1: the rollback path. gateway.context DISABLED (fixture
// policy via POLICY_YAML_PATH) → the legacy single-tool route shape,
// no day.state advertised, no read-set instructions. Own file: the
// 60s policy TTL cache is module-scoped, so the env switch needs a
// fresh module registry.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { FakeModelProvider } from "@jehad/adapters";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { issueGrant } from "../policy/grants.js";
import { CONVERSE_CAPABILITY, handleInbound, type ConversationDeps } from "./conversation.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const T0 = new Date();
const HANDLE = "+15550004444";

const REGISTRY = new ModelEgressPolicyRegistry([
  {
    id: "test-personal-normal",
    domainId: "personal",
    sensitivity: "normal",
    allowedProviders: ["fake"],
    allowRemote: false,
    requireRedaction: false,
  },
]);

describe.skipIf(!TEST_DATABASE_URL)("W1 rollback: context disabled (integration)", () => {
  let db: IsolatedDb;
  let principalId: string;
  let provider: FakeModelProvider;
  let deps: ConversationDeps;

  beforeAll(async () => {
    process.env.POLICY_YAML_PATH = new URL("./context-disabled.fixture.yaml", import.meta.url)
      .pathname;
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igw1off");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', 'jarvis-w1-off') RETURNING id",
    );
    principalId = String(principal.rows[0].id);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [principalId, "f".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', $2, $3::timestamptz, $3::timestamptz, $4::uuid)`,
      [principalId, HANDLE, T0.toISOString(), session.rows[0].id],
    );
    await issueGrant(db.pool, {
      principalId,
      runId: null,
      capability: CONVERSE_CAPABILITY,
      resource: "imessage",
      domainId: String(domain.rows[0].id),
      expiresAt: new Date(T0.getTime() + 60 * 60_000),
    });
    provider = new FakeModelProvider({
      respond: (request) => {
        if (request.prompt.includes("query router")) {
          return { text: '{"tool":"calendar.next"}' };
        }
        return { text: "Next up: nothing scheduled." };
      },
    });
    deps = {
      db: db.pool,
      provider,
      registry: REGISTRY,
      principalPolicy: () => ({
        model: "fake/model-x",
        requestsPerHour: 30,
        costPerDay: 5,
        reads: ["calendar", "commitments", "gmail", "state"],
      }),
      now: () => T0,
    };
  });

  afterAll(async () => {
    delete process.env.POLICY_YAML_PATH;
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("legacy single-tool route shape; no day.state, no read-set instructions; single-tool execution + audit intact", async () => {
    const outcome = await handleInbound(deps, {
      principalId,
      handle: HANDLE,
      text: "whats coming up",
    });
    expect(outcome.replied).toBe(true);

    const routePrompt = provider.requests
      .map((r) => r.prompt)
      .find((p) => p.includes("query router"))!;
    expect(routePrompt).not.toContain("day.state");
    expect(routePrompt).not.toContain('"tools"');

    const audits = await db.pool.query(
      `SELECT outputs_ref::jsonb->>'tool' AS tool FROM audit_log
        WHERE action = 'imessage.converse.tool_used' AND outputs_ref::jsonb->>'principalId' = $1`,
      [principalId],
    );
    expect(audits.rows.map((r) => String(r.tool))).toContain("calendar.next");
  });
});
