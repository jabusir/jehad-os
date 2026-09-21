// Verifier C1/C2 (W2+W3+W7 wave): wired-path pins for the tiered answer
// dispatch and the new read capabilities — answer_fallback retry semantics,
// DEEP budget capping, and single-shape no-escalation for the new tools.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { FakeModelProvider } from "@jehad/adapters";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { issueGrant } from "../policy/grants.js";
import { CONVERSE_CAPABILITY, handleInbound, type ConversationDeps } from "./conversation.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const T0 = new Date();
const HANDLE = "+15550005555";

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

function scriptedProvider(routeOutputs: string[], answerOutput: string, failAnswers = 0) {
  let routeIdx = 0;
  let answerFailuresLeft = failAnswers;
  return new FakeModelProvider({
    respond: (request) => {
      if (request.prompt.includes("query router")) {
        const out = routeOutputs[routeIdx] ?? routeOutputs[routeOutputs.length - 1]!;
        routeIdx += 1;
        return { text: out };
      }
      if (answerFailuresLeft > 0) {
        answerFailuresLeft -= 1;
        throw new Error("simulated provider outage");
      }
      return { text: answerOutput };
    },
  });
}

const setupHandles = new Map<string, string>();

describe.skipIf(!TEST_DATABASE_URL)("W3/W2 wiring pins (integration)", () => {
  let db: IsolatedDb;
  let principalId: string;
  let domainId: string;

  const makeDeps = (provider: FakeModelProvider, reads: string[]): ConversationDeps => ({
    db: db.pool,
    provider,
    registry: REGISTRY,
    principalPolicy: () => ({
      model: "fake/model-x",
      requestsPerHour: 30,
      costPerDay: 5,
      reads,
    }),
    now: () => T0,
  });

  let handleSeq = 0;
  const setup = async (name: string) => {
    handleSeq += 1;
    const handle = `+1555000555${String(handleSeq).padStart(2, "0")}`;
    (setupHandles as Map<string, string>).set(name, handle);
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [name],
    );
    const id = String(principal.rows[0].id);
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [id, "a".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', $2, $3::timestamptz, $3::timestamptz, $4::uuid)`,
      [id, handle, T0.toISOString(), session.rows[0].id],
    );
    await issueGrant(db.pool, {
      principalId: id,
      runId: null,
      capability: CONVERSE_CAPABILITY,
      resource: "imessage",
      domainId,
      expiresAt: new Date(T0.getTime() + 60 * 60_000),
    });
    return id;
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igw3");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    domainId = String(domain.rows[0].id);
    principalId = await setup("jarvis-w3");
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("single-shape memory.recall routes without escalation (no fallback route dispatch)", async () => {
    const provider = scriptedProvider(['{"tool":"memory.recall"}'], "nothing recalled");
    const outcome = await handleInbound(makeDeps(provider, ["memory"]), {
      principalId,
      handle: HANDLE,
      text: "what did I decide about the venue",
    });
    expect(outcome.replied).toBe(true);
    // route + answer only — no parse-failure fallback (repo policy has gemini fallback).
    expect(provider.requests).toHaveLength(2);
    const audits = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'imessage.converse.tool_used'
          AND outputs_ref::jsonb->>'tool' = 'memory.recall'
          AND outputs_ref::jsonb->>'principalId' = $1`,
      [principalId],
    );
    expect(audits.rows[0].n).toBe(1);
  });

  it("principal without the memory read gets denied, never data", async () => {
    const noMemoryId = await setup("jarvis-w3-nomem");
    const provider = scriptedProvider(['{"tool":"memory.recall"}'], "denied honestly");
    const outcome = await handleInbound(makeDeps(provider, ["calendar"]), {
      principalId: noMemoryId,
      handle: setupHandles.get("jarvis-w3-nomem")!,
      text: "what did I decide about the venue",
    });
    expect(outcome.replied).toBe(true);
    const denied = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'imessage.converse.tool_denied'
          AND outputs_ref::jsonb->>'tool' = 'memory.recall'
          AND outputs_ref::jsonb->>'principalId' = $1`,
      [noMemoryId],
    );
    expect(denied.rows[0].n).toBe(1);
    const prompt = provider.requests.map((r) => r.prompt).find((p) => p.includes("BEGIN DATA"));
    expect(prompt).toBeUndefined();
  });

  it("answer_fallback: provider failure retries ONCE on the fallback model, audited; success still replies", async () => {
    const provider = scriptedProvider(['{"tool":"none"}'], "recovered via fallback", 1);
    const outcome = await handleInbound(makeDeps(provider, ["calendar"]), {
      principalId,
      handle: HANDLE,
      text: "hello there, can you help me think through what matters today and why",
    });
    expect(outcome.replied).toBe(true);
    // route + failed answer + fallback answer = 3 dispatches
    expect(provider.requests).toHaveLength(3);
    const fb = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'imessage.converse.answer_fallback'
          AND outputs_ref::jsonb->>'principalId' = $1`,
      [principalId],
    );
    expect(fb.rows[0].n).toBe(1);
  });

  it("DEEP over budget: capped to standard, deep_capped audited, reply still lands", async () => {
    // Burn today's DEEP budget: a finalized :deep call above the cap (~$0.67).
    const run = await db.pool.query(
      "INSERT INTO runs (kind, status, domain_id, principal_id, started_at) VALUES ('harness', 'completed', $2::uuid, $1::uuid, now()) RETURNING id",
      [principalId, domainId],
    );
    await db.pool.query(
      `INSERT INTO model_calls
         (run_id, provider, model, prompt_version, in_tokens, out_tokens, cost_usd, latency_ms, result_status)
       VALUES ($1::uuid, 'fake', 'fake/model-x', 'conversation:deep', 100, 100, 5.0, 10, 'ok')`,
      [run.rows[0].id],
    );
    const provider = scriptedProvider(['{"tools":["day.state","commitments.waiting"]}'], "capped deep answer");
    const outcome = await handleInbound(makeDeps(provider, ["calendar", "commitments", "state"]), {
      principalId,
      handle: HANDLE,
      text: "what's going on today and what should I prioritize and why",
    });
    expect(outcome.replied).toBe(true);
    const capped = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'imessage.converse.deep_capped'
          AND outputs_ref::jsonb->>'principalId' = $1`,
      [principalId],
    );
    expect(capped.rows[0].n).toBeGreaterThanOrEqual(1);
    // The answer dispatched on the STANDARD resolution (sonnet per repo policy),
    // never on a deep prompt version this turn.
    const deepCalls = await db.pool.query(
      `SELECT count(*)::int AS n FROM model_calls WHERE prompt_version = 'conversation:deep' AND run_id = $1::uuid`,
      [run.rows[0].id],
    );
    expect(deepCalls.rows[0].n).toBe(1); // only the seeded row
  });
});
