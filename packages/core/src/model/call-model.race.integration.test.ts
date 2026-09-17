// callModel budget-race probe (Wave 5 final-gate follow-up): barrier-
// synchronized parallel calls against a nearly-exhausted hard cap must admit
// exactly ONE dispatch — the reservation protocol (pg_advisory_xact_lock +
// headroom-holding 'reserved' row) closes the check-then-insert race the
// verifier proved ($3.99 spend on a $1.00 cap). Also covers the crash
// window: a process dying between reserve and finalize leaves a 'reserved'
// row that staleReservations() finds for ops.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeModelProvider } from "@jehad/adapters";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { MODEL_CALL_RESULT_STATUSES, ModelBudgetExceededError, callModel } from "./call-model.js";
import { type ModelBudget, staleReservations } from "./budget.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe.skipIf(!TEST_DATABASE_URL)("callModel budget race (integration)", () => {
  let db: IsolatedDb;
  let runId: string;

  const registry = new ModelEgressPolicyRegistry([
    {
      id: "personal-normal-fake",
      domainId: "personal",
      sensitivity: "normal",
      allowedProviders: ["fake"],
      allowRemote: false,
      requireRedaction: false,
    },
  ]);

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "modelrace");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name, credential_hash) VALUES ('user', 'race-test', NULL) RETURNING id`,
    );
    const run = await db.pool.query(
      `INSERT INTO runs (kind, status, domain_id, principal_id)
       VALUES ('workflow', 'running', $1, $2) RETURNING id`,
      [domain.rows[0]!.id, principal.rows[0]!.id],
    );
    runId = String(run.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const baseRequest = {
    domainId: "personal",
    sensitivity: "normal" as const,
    provider: "fake",
    model: "fake-model-v1",
    prompt: "race probe",
  };

  async function seedSpend(usd: number): Promise<void> {
    await db.pool.query(
      `INSERT INTO model_calls (run_id, provider, model, in_tokens, out_tokens, cost_usd, latency_ms, result_status)
       VALUES ($1, 'fake', 'fake-model-v1', 0, 0, $2, 0, 'ok')`,
      [runId, usd],
    );
  }

  async function monthSpend(): Promise<number> {
    const result = await db.pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM model_calls WHERE created_at >= date_trunc('month', now())`,
    );
    return Number(result.rows[0]!.spent);
  }

  async function reservedRowCount(): Promise<number> {
    const result = await db.pool.query(`SELECT count(*)::int AS n FROM model_calls WHERE result_status = 'reserved'`);
    return Number(result.rows[0]!.n);
  }

  async function auditCount(action: string): Promise<number> {
    const result = await db.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = $1`, [action]);
    return Number(result.rows[0]!.n);
  }

  it("the verifier probe: 3 barrier-synchronized $1.00 calls, hard cap $1.00, spend $0.99 → exactly ONE dispatches", async () => {
    const budget: ModelBudget = { softUsd: 0.5, hardUsd: 1 };
    await seedSpend(0.99);

    // Winner's dispatch blocks until released, so losers are denied while
    // the reservation is genuinely in flight.
    const dispatchStarted = deferred();
    const releaseDispatch = deferred();
    const provider = new FakeModelProvider({
      respond: () => {
        dispatchStarted.resolve();
        return releaseDispatch.promise.then(() => ({
          text: "winner output",
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 1.0 },
        }));
      },
    });
    const deps = { db: db.pool, provider, registry, budget };

    // Barrier: all three racers enter callModel in the same tick. Settled-
    // handlers attach synchronously so denials never look unhandled.
    const gate = deferred();
    const racers = [0, 1, 2].map(() => gate.promise.then(() => callModel(deps, { ...baseRequest, runId })));
    const settledPromise = Promise.allSettled(racers);
    gate.resolve();

    // Wait for the single dispatch to start, then probe mid-flight state.
    await dispatchStarted.promise;
    expect(await reservedRowCount()).toBe(1);
    const inFlightReservation = await db.pool.query(
      `SELECT cost_usd FROM model_calls WHERE result_status = 'reserved'`,
    );
    expect(Number(inFlightReservation.rows[0]!.cost_usd)).toBeGreaterThanOrEqual(0.01);

    // A 4th call while the winner is in flight must also be denied —
    // the committed reservation holds the remaining headroom.
    await expect(callModel(deps, { ...baseRequest, runId })).rejects.toBeInstanceOf(ModelBudgetExceededError);

    releaseDispatch.resolve();
    const settled = await settledPromise;
    const winner = settled.filter((s) => s.status === "fulfilled");
    const denied = settled.filter((s) => s.status === "rejected");

    expect(winner).toHaveLength(1);
    expect(denied).toHaveLength(2);
    for (const outcome of denied) {
      expect(outcome.reason).toBeInstanceOf(ModelBudgetExceededError);
    }
    expect(provider.requests).toHaveLength(1);

    // Final spend: $0.99 seeded + one $1.00 call — no overshoot beyond the
    // hard cap + one in-flight call's cost.
    expect(await monthSpend()).toBe(1.99);
    expect(await reservedRowCount()).toBe(0);

    // Ledger truthfulness: exactly two rows total (seed + winner); the two
    // denied racers and the mid-flight probe recorded no spend, no row.
    const rows = await db.pool.query(`SELECT result_status, cost_usd FROM model_calls ORDER BY created_at, id`);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.at(-1)).toMatchObject({ result_status: "ok_budget_warning" });
    expect(Number(rows.rows.at(-1)!.cost_usd)).toBe(1);

    // Denials audited: 2 racers + 1 mid-flight probe.
    expect(await auditCount("model.budget.denied")).toBe(3);
  });

  it("conservative admission: even far under the cap, a concurrent racer is denied while a reservation is in flight", async () => {
    // No seeded spend, hard cap $10 — cost is unknowable pre-dispatch, so an
    // outstanding reservation holds ALL remaining headroom and admits no
    // second in-flight call. Documented trade-off of the reservation protocol.
    const budget: ModelBudget = { softUsd: 5, hardUsd: 10 };
    const dispatchStarted = deferred();
    const releaseDispatch = deferred();
    const provider = new FakeModelProvider({
      respond: () => {
        dispatchStarted.resolve();
        return releaseDispatch.promise.then(() => ({
          text: "first output",
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        }));
      },
    });
    const deps = { db: db.pool, provider, registry, budget };

    const gate = deferred();
    const racers = [0, 1].map(() => gate.promise.then(() => callModel(deps, { ...baseRequest, runId })));
    const settledPromise = Promise.allSettled(racers);
    gate.resolve();

    await dispatchStarted.promise;
    releaseDispatch.resolve();
    const settled = await settledPromise;

    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
  });

  it("crash between reserve and finalize (direct SQL): a 'reserved' row remains and staleReservations finds it", async () => {
    const inserted = await db.pool.query(
      `INSERT INTO model_calls (run_id, provider, model, in_tokens, out_tokens, cost_usd, latency_ms, result_status)
       VALUES ($1, 'fake', 'fake-model-v1', 0, 0, 0.42, 0, 'reserved') RETURNING id::text AS id`,
      [runId],
    );
    const id = String(inserted.rows[0]!.id);

    // Fresh reservation: not stale at a 60s threshold.
    expect(await staleReservations(db.pool, { olderThanMs: 60_000 })).toHaveLength(0);

    // Backdate it 10 minutes — found at a 5-minute threshold, not at 15.
    await db.pool.query(`UPDATE model_calls SET created_at = now() - interval '10 minutes' WHERE id = $1::uuid`, [id]);

    const stale5 = await staleReservations(db.pool, { olderThanMs: 5 * 60_000 });
    expect(stale5).toHaveLength(1);
    expect(stale5[0]).toMatchObject({
      id,
      runId,
      provider: "fake",
      model: "fake-model-v1",
      reservedUsd: 0.42,
    });
    expect(typeof stale5[0]!.createdAt).toBe("string");

    expect(await staleReservations(db.pool, { olderThanMs: 15 * 60_000 })).toHaveLength(0);

    // Invalid thresholds fail loudly.
    await expect(staleReservations(db.pool, { olderThanMs: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(staleReservations(db.pool, { olderThanMs: Number.NaN })).rejects.toBeInstanceOf(RangeError);

    // Cleanup so the ledger ends this file with no outstanding reservation.
    await db.pool.query(`DELETE FROM model_calls WHERE id = $1::uuid`, [id]);
  });

  it("MODEL_CALL_RESULT_STATUSES includes the 'reserved' lifecycle status", () => {
    expect(MODEL_CALL_RESULT_STATUSES).toEqual(["reserved", "ok", "ok_budget_warning", "error"]);
  });
});
