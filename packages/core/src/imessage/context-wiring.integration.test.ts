// W1 Context Foundation wiring (docs/plans/jarvis-v1.md §7 W1):
// bounded read-set composition, thread state (referents + lastStance),
// and thread-local "changed my mind" retraction. Hermetic fake provider
// behind the real egress/callModel path; isolated db; the repo-root
// policy.yaml supplies gateway.context (enabled).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { FakeModelProvider } from "@jehad/adapters";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { issueGrant } from "../policy/grants.js";
import { CONVERSE_CAPABILITY, handleInbound, type ConversationDeps } from "./conversation.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const T0 = new Date();
const HANDLE = "+15550003333";

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

describe.skipIf(!TEST_DATABASE_URL)("W1 context wiring (integration)", () => {
  let db: IsolatedDb;
  let principalId: string;
  let provider: FakeModelProvider;
  let deps: ConversationDeps;

  const inbound = (text: string) =>
    handleInbound(deps, { principalId, handle: HANDLE, text });

  const threadMetadata = async () => {
    const row = await db.pool.query(
      "SELECT metadata FROM interaction_threads WHERE principal_id = $1::uuid AND status = 'active'",
      [principalId],
    );
    return (row.rows[0]?.metadata ?? null) as {
      lastStance?: { kind: string; summary: string };
      referents?: { kind: string; ref: string }[];
    } | null;
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igw1");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', 'jarvis-w1') RETURNING id",
    );
    principalId = String(principal.rows[0].id);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [principalId, "e".repeat(64)],
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
          return { text: '{"tools":["commitments.waiting","day.state"]}' };
        }
        return { text: "TODAY — one overdue commitment, two waiting on others." };
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
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("a composite question routes a bounded read set; both tools execute, audit, and land as provenance-labeled blocks", async () => {
    const outcome = await inbound("what's going on and what do I owe?");
    expect(outcome.replied).toBe(true);

    const audits = await db.pool.query(
      `SELECT outputs_ref::jsonb->>'tool' AS tool FROM audit_log
        WHERE action = 'imessage.converse.tool_used' AND outputs_ref::jsonb->>'principalId' = $1`,
      [principalId],
    );
    const tools = audits.rows.map((r) => String(r.tool)).sort();
    expect(tools).toEqual(["commitments.waiting", "day.state"]);

    const answerPrompt = provider.requests
      .map((r) => r.prompt)
      .filter((p) => p.includes("BEGIN DATA"))
      .at(-1)!;
    expect(answerPrompt).toContain("BEGIN DATA");
    expect(answerPrompt).toContain("[source: commitments — tool: commitments.waiting");
    expect(answerPrompt).toContain("[source: state — tool: day.state");
    expect(answerPrompt).toContain("END DATA");
  });

  it("the grounded turn writes thread state: lastStance + read referents", async () => {
    const meta = await threadMetadata();
    expect(meta?.lastStance?.kind).toBe("answer");
    const refs = (meta?.referents ?? []).map((r) => r.ref);
    expect(refs).toContain("commitments.waiting");
    expect(refs).toContain("day.state");
  });

  it("'changed my mind' retracts the thread stance locally — no canonical writes, honest ack", async () => {
    const before = await db.pool.query(
      "SELECT count(*)::int AS n FROM commitments",
    );
    const outcome = await inbound("actually, I changed my mind");
    expect(outcome.replied).toBe(true);

    const reply = await db.pool.query(
      `SELECT count(*)::int AS n FROM notifications
        WHERE kind = 'reply' AND payload->>'content' LIKE 'Changed — I' || chr(39) || 've dropped that%'`,
    );
    expect(reply.rows[0].n).toBe(1);

    const retractAudit = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'imessage.converse.replied'
          AND outputs_ref::jsonb->>'deterministic' = 'conversation-retract'
          AND outputs_ref::jsonb->>'principalId' = $1`,
      [principalId],
    );
    expect(retractAudit.rows[0].n).toBe(1);

    const meta = await threadMetadata();
    expect(meta?.lastStance).toBeUndefined();

    const after = await db.pool.query("SELECT count(*)::int AS n FROM commitments");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
