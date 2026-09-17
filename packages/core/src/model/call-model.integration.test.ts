// callModel integration tests (plan §15 M5 acceptance): fake provider
// through the FULL path — egress check → budget → dispatch → model_calls
// ledger — against a real, isolated Postgres. Hermetic by construction: the
// only provider is the in-memory fake (plan §13); no network, no key.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeModelProvider } from "@jehad/adapters";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { EgressPolicyError, ModelEgressPolicyRegistry } from "../egress/index.js";
import { MissingRunError, ModelBudgetExceededError, callModel } from "./call-model.js";
import type { ModelBudget } from "./budget.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("callModel (integration)", () => {
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

  const budget: ModelBudget = { softUsd: 5, hardUsd: 10 };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "modelcalls");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name, credential_hash) VALUES ('user', 'm5a-test', NULL) RETURNING id`,
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
    prompt: "extract commitments",
  };

  function fakeProvider() {
    return new FakeModelProvider({
      respond: {
        text: "deterministic extraction output",
        usage: { inputTokens: 120, outputTokens: 45, costUsd: 0.0025 },
      },
    });
  }

  async function modelCallRows(): Promise<Record<string, unknown>[]> {
    const result = await db.pool.query("SELECT * FROM model_calls ORDER BY created_at, id");
    return result.rows;
  }

  async function auditRows(action: string): Promise<Record<string, unknown>[]> {
    const result = await db.pool.query("SELECT * FROM audit_log WHERE action = $1", [action]);
    return result.rows;
  }

  /** Seeds prior spend into the ledger (calendar month — the caps window). */
  async function seedSpend(usd: number): Promise<void> {
    await db.pool.query(
      `INSERT INTO model_calls (run_id, provider, model, in_tokens, out_tokens, cost_usd, latency_ms, result_status)
       VALUES ($1, 'fake', 'fake-model-v1', 0, 0, $2, 0, 'ok')`,
      [runId, usd],
    );
  }

  it("happy path: gate passes → dispatch → ledger row with tokens/cost/latency/status", async () => {
    const provider = fakeProvider();
    const outcome = await callModel({ db: db.pool, provider, registry, budget }, {
      ...baseRequest,
      runId,
      promptVersion: "commitment-extract@1",
    });

    expect(outcome.resultStatus).toBe("ok");
    expect(outcome.costUsd).toBe(0.0025);
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    expect(provider.requests).toHaveLength(1);

    const rows = await modelCallRows();
    const row = rows.find((r) => r.result_status === "ok");
    expect(row).toMatchObject({
      run_id: runId,
      provider: "fake",
      model: "fake-model-v1",
      prompt_version: "commitment-extract@1",
      in_tokens: 120,
      out_tokens: 45,
      cost_usd: "0.0025",
      result_status: "ok",
    });
    expect(Number(row!.latency_ms)).toBeGreaterThanOrEqual(0);
  });

  it("egress denial → NO dispatch, NO model_calls row, audited (T12)", async () => {
    const provider = fakeProvider();
    const before = (await modelCallRows()).length;

    await expect(
      callModel({ db: db.pool, provider, registry, budget }, { ...baseRequest, sensitivity: "secret", runId }),
    ).rejects.toMatchObject({
      name: "EgressDenialError",
      audit: { reason: "secret_never_in_model_context" },
    });

    expect(provider.requests).toHaveLength(0);
    expect((await modelCallRows()).length).toBe(before);
    const audits = await auditRows("model.egress.denied");
    expect(audits).toHaveLength(1);
    expect(String(audits[0]!.inputs_ref)).toContain("secret_never_in_model_context");
  });

  it("provider-not-allowed egress denial is audited too", async () => {
    const provider = fakeProvider();
    await expect(
      callModel({ db: db.pool, provider, registry, budget }, { ...baseRequest, domainId: "finance", runId }),
    ).rejects.toMatchObject({ name: "EgressDenialError", audit: { reason: "no_matching_rule" } });
    expect(provider.requests).toHaveLength(0);
    expect(await auditRows("model.egress.denied")).toHaveLength(2);
  });

  it("provider pinning: request.provider ≠ provider.id → wiring error, no dispatch, no row", async () => {
    const provider = fakeProvider();
    const before = (await modelCallRows()).length;
    await expect(
      callModel({ db: db.pool, provider, registry, budget }, { ...baseRequest, provider: "other", runId }),
    ).rejects.toBeInstanceOf(EgressPolicyError);
    expect(provider.requests).toHaveLength(0);
    expect((await modelCallRows()).length).toBe(before);
  });

  it("soft cap: call proceeds, result_status ok_budget_warning, warning audited", async () => {
    await seedSpend(6); // soft=5, hard=10 → over soft, under hard
    const provider = fakeProvider();

    const outcome = await callModel({ db: db.pool, provider, registry, budget }, { ...baseRequest, runId });

    expect(outcome.resultStatus).toBe("ok_budget_warning");
    expect(provider.requests).toHaveLength(1);
    const rows = await modelCallRows();
    expect(rows.at(-1)).toMatchObject({ result_status: "ok_budget_warning" });
    expect(await auditRows("model.budget.warning")).toHaveLength(1);
  });

  it("hard cap: denial before dispatch — no new spend row, no dispatch, audited", async () => {
    await seedSpend(4.5); // total now 6 + 4.5 = 10.5 ≥ hard=10
    const provider = fakeProvider();
    const before = (await modelCallRows()).length;

    await expect(
      callModel({ db: db.pool, provider, registry, budget }, { ...baseRequest, runId }),
    ).rejects.toBeInstanceOf(ModelBudgetExceededError);

    expect(provider.requests).toHaveLength(0);
    expect((await modelCallRows()).length).toBe(before);
    const audits = await auditRows("model.budget.denied");
    expect(audits).toHaveLength(1);
    expect(String(audits[0]!.inputs_ref)).toContain('"hardUsd":10');
  });

  it("provider failure after dispatch: honest error row, error rethrown", async () => {
    const provider = new FakeModelProvider({ failWith: new Error("model exploded") });
    const outcome = await callModel({ db: db.pool, provider, registry, budget: { softUsd: 500, hardUsd: 1000 } }, {
      ...baseRequest,
      runId,
    }).catch((err: unknown) => err);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("model exploded");
    expect(provider.requests).toHaveLength(1);
    const rows = await modelCallRows();
    expect(rows.at(-1)).toMatchObject({
      result_status: "error",
      in_tokens: 0,
      out_tokens: 0,
      cost_usd: "0",
    });
    expect(Number(rows.at(-1)!.latency_ms)).toBeGreaterThanOrEqual(0);
  });

  it("missing runId → MissingRunError, nothing dispatched or written", async () => {
    const provider = fakeProvider();
    const before = (await modelCallRows()).length;
    // runId deliberately omitted (it is optional on the port) — the service
    // must reject: the ledger keys every call to a run.
    await expect(callModel({ db: db.pool, provider, registry, budget }, baseRequest)).rejects.toBeInstanceOf(
      MissingRunError,
    );
    expect(provider.requests).toHaveLength(0);
    expect((await modelCallRows()).length).toBe(before);
  });
});
