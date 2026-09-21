// Deep-budget guard (W3) — integration against the model_calls ledger.
// Needs PostgreSQL 16; skipped unless TEST_DATABASE_URL is set. Isolated DB.

import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { deepBudgetState, deepPromptVersion } from "./deep-budget.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("deep budget guard (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "deepbudget");
    await migrateUp(db.pool);
    await db.pool.query(`INSERT INTO principals (type, name) VALUES ('user', 'deep-budget-test')`);
    await db.pool.query(
      `INSERT INTO domains (key, name, sensitivity, retention_class)
       VALUES ('deep-budget-test', 'deep-budget-test', 'normal', 'standard')
       ON CONFLICT (key) DO NOTHING`,
    );
    const run = await db.pool.query(
      `INSERT INTO runs (kind, principal_id, status, intent, domain_id, started_at, ended_at, created_at, updated_at)
       SELECT 'harness', p.id, 'completed', 'deep-budget guard test', d.id, $1::timestamptz, $1::timestamptz, $1::timestamptz, $1::timestamptz
         FROM principals p, domains d
        WHERE p.name = 'deep-budget-test' AND d.key = 'deep-budget-test'
       RETURNING id`,
      [new Date("2026-09-21T18:00:00.000Z").toISOString()],
    );
    runId = String(run.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const NOW = new Date("2026-09-21T18:30:00.000Z");
  const ENV = { MODEL_BUDGET_SOFT_USD: "60" }; // cap = 0.5 × 60/30 = $1.00
  let runId: string;

  beforeEach(async () => {
    await db.pool.query("DELETE FROM model_calls");
  });

  it("empty ledger → DEEP allowed, zero spend, cap derived from envelope", async () => {
    const state = await deepBudgetState(db.pool, { now: NOW, env: ENV });
    expect(state).toMatchObject({
      deepCallsToday: 0,
      spentUsd: 0,
      capUsd: 1.0,
      remainingUsd: 1.0,
      allowDeep: true,
      effectiveTier: "deep",
      reason: "within-budget",
    });
  });

  async function insertCall(opts: {
    promptVersion: string;
    costUsd: number;
    status?: string;
    createdAt?: Date;
  }): Promise<void> {
    await db.pool.query(
      `INSERT INTO model_calls
         (run_id, provider, model, prompt_version, in_tokens, out_tokens, cost_usd, latency_ms, result_status, created_at, updated_at)
       VALUES ($5::uuid, 'openrouter', 'a/model', $1, 10, 10, $2, 5, $3, $4::timestamptz, $4::timestamptz)`,
      [opts.promptVersion, opts.costUsd, opts.status ?? "ok", (opts.createdAt ?? NOW).toISOString(), runId],
    );
  }

  it("counts only :deep-suffixed, finalized rows from today (UTC day)", async () => {
    await insertCall({ promptVersion: deepPromptVersion("imessage-converse-v2"), costUsd: 0.4 });
    await insertCall({ promptVersion: deepPromptVersion("imessage-converse-v2"), costUsd: 0.3 });
    // Not counted: unsuffixed STANDARD answer, route pass, reserved rows,
    // yesterday's DEEP call.
    await insertCall({ promptVersion: "imessage-converse-v2", costUsd: 0.9 });
    await insertCall({ promptVersion: "imessage-converse-v3-route", costUsd: 0.1 });
    await insertCall({ promptVersion: deepPromptVersion("imessage-converse-v2"), costUsd: 90, status: "reserved" });
    await insertCall({
      promptVersion: deepPromptVersion("imessage-converse-v2"),
      costUsd: 0.5,
      createdAt: new Date("2026-09-20T23:59:00.000Z"),
    });

    const state = await deepBudgetState(db.pool, { now: NOW, env: ENV });
    expect(state.deepCallsToday).toBe(2);
    expect(state.spentUsd).toBeCloseTo(0.7, 10);
    expect(state.allowDeep).toBe(true);
    expect(state.effectiveTier).toBe("deep");
  });

  it("at/over cap → downgrade to standard via return value, never a throw", async () => {
    await insertCall({ promptVersion: deepPromptVersion("imessage-converse-v2"), costUsd: 1.0 });
    const atCap = await deepBudgetState(db.pool, { now: NOW, env: ENV });
    expect(atCap.allowDeep).toBe(false);
    expect(atCap.effectiveTier).toBe("standard");
    expect(atCap.reason).toBe("daily-deep-cap-exceeded");
    expect(atCap.remainingUsd).toBe(0);

    await insertCall({ promptVersion: deepPromptVersion("imessage-converse-v2"), costUsd: 0.5 });
    const overCap = await deepBudgetState(db.pool, { now: NOW, env: ENV });
    expect(overCap.effectiveTier).toBe("standard");
    expect(overCap.remainingUsd).toBe(0);
    expect(overCap.deepCallsToday).toBe(2);
  });

  it("UTC-day window: a DEEP call before today's boundary does not count", async () => {
    await insertCall({
      promptVersion: deepPromptVersion("imessage-converse-v2"),
      costUsd: 5,
      createdAt: new Date("2026-09-20T23:59:59.000Z"),
    });
    const state = await deepBudgetState(db.pool, { now: NOW, env: ENV });
    expect(state.spentUsd).toBe(0);
    expect(state.allowDeep).toBe(true);
  });

  it("reserved-only ledger counts zero (reservations hold headroom, not cost)", async () => {
    await insertCall({ promptVersion: deepPromptVersion("imessage-converse-v2"), costUsd: 89.9, status: "reserved" });
    const state = await deepBudgetState(db.pool, { now: NOW, env: ENV });
    expect(state.deepCallsToday).toBe(0);
    expect(state.spentUsd).toBe(0);
    expect(state.allowDeep).toBe(true);
  });
});
