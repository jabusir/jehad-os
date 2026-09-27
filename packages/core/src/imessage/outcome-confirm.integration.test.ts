// Shell-trust R2 (docs/plans/shell-trust.md) — the outcome_spec confirm
// token lane, end to end: park mints a calendar-grade token (via the REAL
// cognitive executor), the §22.10.4 shared lane resolves `confirm|cancel
// <TOKEN>` / bare verbs, accepted ≠ dispatched ≠ running is narrated from
// the OBSERVED result, /new never kills a live approval, unknown tokens
// count toward the brute lockout, expired ones never do.
//
// Hermetic: scripted ModelProvider, cognitive-test fixture policy via
// POLICY_YAML_PATH, isolated schema. The hVerb lane is deterministic and
// runs BEFORE the routing switch, so handleInbound exercises it on the
// single path too.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import type { ModelProvider, ModelRequest, ModelResult } from "../adapters/ports/model-provider.js";
import { issueGrant } from "../policy/grants.js";
import { loadRepoPolicy, resetRepoPolicyCache } from "../policy/repo-policy.js";
import { runCognitiveTurn, type CognitiveTurnDeps } from "./cognitive-turn.js";
import { handleInbound } from "./conversation.js";
import {
  confirmOutcomeToken,
  cancelOutcomeToken,
  soleLiveOutcomeParks,
} from "./outcome-confirm.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const FIXTURE_POLICY = new URL("./cognitive-test.policy.yaml", import.meta.url).pathname;
const NOW = new Date("2026-09-26T18:00:00.000Z");

function scriptedProvider(scripts: readonly string[]): {
  provider: ModelProvider;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    requests,
    provider: {
      id: "scripted",
      complete: async (request: ModelRequest): Promise<ModelResult> => {
        requests.push(request);
        const text = scripts[index];
        index += 1;
        if (text === undefined) throw new Error("scripted provider: queue exhausted");
        return { text, usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.001 } };
      },
    },
  };
}

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reads_requested: [],
    operations_requested: [],
    proposal_resolutions: [],
    interpretation: "a one-line reading",
    intent: "chat",
    reply: null,
    ...overrides,
  });
}

const VERIFY_CONSISTENT = '{"verdict":"consistent"}';

describe.skipIf(!TEST_DATABASE_URL)("outcome confirm token lane (shell-trust R2, integration)", () => {
  let db: IsolatedDb;
  let josctlId: string;
  let domainId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "outok");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    domainId = String((await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`)).rows[0]!.id);
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', 'josctl') RETURNING id",
    );
    josctlId = String(principal.rows[0]!.id);
    // handleInbound resolves the principal BY PAIRED HANDLE — pair it like
    // the conversation integration suite does.
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [josctlId, "d".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', '+15550000001', $2::timestamptz, $2::timestamptz, $3::uuid)`,
      [josctlId, NOW.toISOString(), session.rows[0]!.id],
    );
    process.env.POLICY_YAML_PATH = FIXTURE_POLICY;
    resetRepoPolicyCache();
  });

  afterAll(async () => {
    delete process.env.POLICY_YAML_PATH;
    resetRepoPolicyCache();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    process.env.POLICY_YAML_PATH = FIXTURE_POLICY;
    resetRepoPolicyCache();
    await db.pool.query(`
      DELETE FROM audit_log;
      DELETE FROM model_calls;
      DELETE FROM assignments; DELETE FROM outcome_criteria; DELETE FROM outcomes;
      DELETE FROM runs;
      DELETE FROM reminders; DELETE FROM feedback; DELETE FROM calibration_items;
      DELETE FROM memory_candidates; DELETE FROM commitments;
      DELETE FROM calendar_events; DELETE FROM interaction_messages; DELETE FROM interaction_threads;
      DELETE FROM events; DELETE FROM outbox; DELETE FROM notifications;
      TRUNCATE interaction_profiles;
    `);
  });

  async function grant(): Promise<void> {
    await issueGrant(db.pool, {
      principalId: josctlId,
      runId: null,
      capability: "imessage:converse",
      resource: "imessage",
      domainId,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      now: () => NOW,
    });
  }

  async function cognitiveTurn(scripts: readonly string[], text: string) {
    const { provider, requests } = scriptedProvider(scripts);
    const registry = new ModelEgressPolicyRegistry([
      {
        id: "personal-normal-scripted",
        domainId: "personal",
        sensitivity: "normal",
        allowedProviders: ["scripted"],
        allowRemote: false,
        requireRedaction: false,
      },
    ]);
    return await runCognitiveTurn(
      { db: db.pool, provider, registry, now: () => NOW },
      { principalId: josctlId, handle: "+15550000001", text },
    );
  }

  /** Delegate via the REAL cognitive executor → returns the minted token. */
  async function delegate(): Promise<string> {
    const outcome = await cognitiveTurn(
      [
        envelope({
          operations_requested: [
            {
              type: "outcome_spec",
              title: "Research verticals",
              directive: "research businesses",
              criteria: ["a written comparison of 3 verticals"],
              budget_usd: null,
              deadline_days: null,
            },
          ],
          intent: "delegation",
        }),
        envelope({ reply: "Staged — confirm when ready." }),
        VERIFY_CONSISTENT,
      ],
      "delegate: research verticals",
    );
    expect(outcome.replied).toBe(true);
    const row = await db.pool.query(
      `SELECT metadata->'pendingProposals' AS p FROM interaction_threads
        WHERE principal_id = $1::uuid AND status = 'active' LIMIT 1`,
      [josctlId],
    );
    const entries = row.rows[0]?.p as { type: string; confirmToken?: string }[] | null;
    const token = entries?.find((e) => e.type === "outcome_spec")?.confirmToken;
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
    return token!;
  }

  async function laneReply(text: string): Promise<{ replied: boolean; reason?: string; content: string | null }> {
    const provider = scriptedProvider([]);
    const registry = new ModelEgressPolicyRegistry([
      {
        id: "personal-normal-scripted",
        domainId: "personal",
        sensitivity: "normal",
        allowedProviders: ["scripted"],
        allowRemote: false,
        requireRedaction: false,
      },
    ]);
    const outcome = await handleInbound(
      {
        db: db.pool,
        provider: provider.provider,
        registry,
        principalPolicy: () => ({
          model: "openai/gpt-4.1",
          requestsPerHour: 60,
          costPerDay: 5.0,
          reads: [],
        }),
        now: () => NOW,
        outcomeDispatcher: async () => "executor-17",
      },
      { principalId: josctlId, handle: "+15550000001", text },
    );
    let content: string | null = null;
    if (outcome.notificationId !== undefined) {
      const row = await db.pool.query(`SELECT payload->>'content' AS c FROM notifications WHERE id = $1::uuid`, [
        outcome.notificationId,
      ]);
      content = typeof row.rows[0]?.["c"] === "string" ? String(row.rows[0]["c"]) : null;
    }
    return { replied: outcome.replied, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}), content };
  }

  it("delegate parks with a calendar-grade token; the ledger detail quotes it to cognition", async () => {
    await grant();
    const token = await delegate();
    // The park audit row carries the token.
    const audits = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log WHERE action = 'operation.outcome_spec.parked'`,
    );
    expect(String(audits.rows[0]?.o?.confirmToken)).toBe(token);
    // No outcome exists yet — staging is not starting.
    const outcomes = await db.pool.query(`SELECT count(*)::int AS n FROM outcomes`);
    expect(Number(outcomes.rows[0]!.n)).toBe(0);
  });

  it("confirm <TOKEN> applies the outcome and narrates accepted + executor-observed state (never 'underway')", async () => {
    await grant();
    const token = await delegate();
    const lane = await laneReply(`confirm ${token}`);
    expect(lane.replied).toBe(true);
    expect(lane.content).toContain("accepted");
    expect(lane.content).toContain("executor picked it up");
    // The outcome exists canonically; the park is consumed.
    const outcomes = await db.pool.query(`SELECT ref, status FROM outcomes`);
    expect(outcomes.rows).toHaveLength(1);
    const parks = await db.pool.query(
      `SELECT metadata->'pendingProposals' AS p FROM interaction_threads WHERE principal_id = $1::uuid`,
      [josctlId],
    );
    expect((parks.rows[0]?.p as unknown[] | null) ?? []).toHaveLength(0);
  });

  it("accepted ≠ dispatched: a dispatcher failure is narrated honestly (saved, not moving)", async () => {
    await grant();
    const token = await delegate();
    const provider = scriptedProvider([]);
    const registry = new ModelEgressPolicyRegistry([
      {
        id: "personal-normal-scripted",
        domainId: "personal",
        sensitivity: "normal",
        allowedProviders: ["scripted"],
        allowRemote: false,
        requireRedaction: false,
      },
    ]);
    const outcome = await handleInbound(
      {
        db: db.pool,
        provider: provider.provider,
        registry,
        principalPolicy: () => ({
          model: "openai/gpt-4.1",
          requestsPerHour: 60,
          costPerDay: 5.0,
          reads: [],
        }),
        now: () => NOW,
        outcomeDispatcher: async () => {
          throw new Error("runtime down");
        },
      },
      { principalId: josctlId, handle: "+15550000001", text: `confirm ${token}` },
    );
    const row = await db.pool.query(`SELECT payload->>'content' AS c FROM notifications WHERE id = $1::uuid`, [
      outcome.notificationId,
    ]);
    const reply = String(row.rows[0]!["c"]);
    expect(reply).toContain("accepted");
    expect(reply).toContain("didn't pick it up");
    // The outcome exists (accepted) — that is ALL that is true.
    const outcomes = await db.pool.query(`SELECT status FROM outcomes`);
    expect(String(outcomes.rows[0]!.status)).toBe("accepted");
  });

  it("post-/new: a live park + token remain resolvable until expiry (conversation context ≠ approval lifetime)", async () => {
    await grant();
    const token = await delegate();
    await laneReply("/new");
    const sole = await soleLiveOutcomeParks(db.pool, { principalId: josctlId, now: new Date(NOW.getTime() + 60_000) });
    expect(sole.kind).toBe("sole");
    const lane = await laneReply(`confirm ${token}`);
    expect(lane.replied).toBe(true);
    expect(lane.content).toContain("accepted");
  });

  it("expired park → honest expired notice, NO bad-ref count", async () => {
    await grant();
    const token = await delegate();
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    const result = await confirmOutcomeToken(db.pool, {
      principalId: josctlId,
      token,
      now: later,
      policyFile: null,
      dispatch: async () => "x",
    });
    expect(result.status).toBe("expired");
    const bad = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'imessage.outcome_token.bad_ref'`,
    );
    expect(Number(bad.rows[0]!.n)).toBe(0);
  });

  it("never-valid token → honest unknown reply + bad-ref count → lockout", async () => {
    await grant();
    const first = await confirmOutcomeToken(db.pool, {
      principalId: josctlId,
      token: "XW1MS",
      now: NOW,
      policyFile: null,
    });
    expect(first.status).toBe("unknown");
    expect(first.reply).toContain("doesn't match");
    const bad = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'imessage.outcome_token.bad_ref'`,
    );
    expect(Number(bad.rows[0]!.n)).toBe(1);

    // Two more unknowns → at cap (3) → the FOURTH call cool-down-notices,
    // the FIFTH silently drops.
    await confirmOutcomeToken(db.pool, { principalId: josctlId, token: "XW1MS", now: new Date(NOW.getTime() + 1000), policyFile: null });
    await confirmOutcomeToken(db.pool, { principalId: josctlId, token: "XW1MS", now: new Date(NOW.getTime() + 2000), policyFile: null });
    const fourth = await confirmOutcomeToken(db.pool, { principalId: josctlId, token: "XW1MS", now: new Date(NOW.getTime() + 3000), policyFile: null });
    expect(fourth.status).toBe("cooldown");
    expect(fourth.reply).not.toBe("");
    const fifth = await confirmOutcomeToken(db.pool, { principalId: josctlId, token: "XW1MS", now: new Date(NOW.getTime() + 4000), policyFile: null });
    expect(fifth.status).toBe("cooldown");
    expect(fifth.reply).toBe("");
  });

  it("cancel <TOKEN> drops the park; nothing ever ran", async () => {
    await grant();
    const token = await delegate();
    const lane = await laneReply(`cancel ${token}`);
    expect(lane.replied).toBe(true);
    expect(lane.content).toContain("cancelled");
    const outcomes = await db.pool.query(`SELECT count(*)::int AS n FROM outcomes`);
    expect(Number(outcomes.rows[0]!.n)).toBe(0);
    const dropped = await cancelOutcomeToken(db.pool, {
      principalId: josctlId,
      token,
      now: NOW,
      policyFile: null,
    });
    expect(dropped.status).toBe("unknown"); // already consumed
  });

  it("bare 'confirm' with one live park resolves it; with two it asks, never guesses", async () => {
    await grant();
    // SOLE: one live park → bare confirm applies it.
    await delegate();
    const sole = await soleLiveOutcomeParks(db.pool, { principalId: josctlId, now: NOW });
    expect(sole.kind).toBe("sole");
    const lane = await laneReply("confirm");
    expect(lane.replied).toBe(true);
    expect(lane.content).toContain("accepted");

    // AMBIGUOUS: two live parks (parked across a /new so both persist) →
    // bare confirm must ask, never guess; an explicit token resolves one.
    await delegate();
    await laneReply("/new");
    await delegate();
    const two = await soleLiveOutcomeParks(db.pool, { principalId: josctlId, now: NOW });
    expect(two.kind).toBe("ambiguous");
    const ambiguous = await laneReply("confirm");
    expect(ambiguous.replied).toBe(true);
    expect(ambiguous.content).toContain("code");
    // Nothing applied by the ambiguous ask.
    const outcomes = await db.pool.query(`SELECT count(*)::int AS n FROM outcomes`);
    expect(Number(outcomes.rows[0]!.n)).toBe(1); // only the first sole apply
  });

  it("principal-scoped: another principal's park is invisible to the token lane", async () => {
    await grant();
    const token = await delegate();
    const other = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', 'someone-else') RETURNING id",
    );
    const result = await confirmOutcomeToken(db.pool, {
      principalId: String(other.rows[0]!.id),
      token,
      now: NOW,
      policyFile: null,
    });
    expect(result.status).toBe("unknown");
  });
});
