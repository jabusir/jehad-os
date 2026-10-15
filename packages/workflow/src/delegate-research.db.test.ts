// Delegation intake seam tests (mission-execution v1) against an isolated
// migrated database: the ONE canonical create+dispatch path's research plan
// minting (software-composed, never an LLM), fail-closed mode validation,
// the active-outcome policy cap, and submissionId idempotency. Needs
// PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../tests/isolated-db.js";
import {
  createAndDispatchOutcome,
  researchPlanFor,
  type CreateAndDispatchOutcomeInput,
  type DelegationMode,
  type OutcomeDispatchPort,
} from "./delegate-shared.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const OPTS = { now: NOW, actor: "system:delegate-test" };

describe.skipIf(!TEST_DATABASE_URL)("delegate intake: research mode (mission-execution v1)", () => {
  let db: IsolatedDb;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "resintake");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'delegate-research-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    // The cap counts ALL active outcomes for the principal — keep tests isolated.
    await db.pool.query(
      `UPDATE outcomes SET status = 'failed', failure_reason = 'test teardown'
        WHERE status NOT IN ('completed', 'failed', 'cancelled') AND created_by = 'josctl'`,
    );
  });

  const exec = {
    query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]),
  };

  const POLICY = {
    enabled: true,
    maxActivePerPrincipal: 3,
    defaultBudgetUsd: 5,
    defaultDeadlineDays: 14,
  };

  function countingDispatch(): {
    calls: Array<{ name: string; payload: { outcomeId: string; ref: string } }>;
    port: OutcomeDispatchPort;
  } {
    const calls: Array<{ name: string; payload: { outcomeId: string; ref: string } }> = [];
    let n = 0;
    return {
      calls,
      port: {
        start: async (name, payload) => {
          calls.push({ name, payload });
          n += 1;
          return { runId: `run-${n}` };
        },
      },
    };
  }

  function baseInput(overrides: Partial<CreateAndDispatchOutcomeInput> = {}): CreateAndDispatchOutcomeInput {
    return {
      principalId,
      principalName: "delegate-research-owner",
      policy: POLICY,
      goal: "Vendor data residency",
      directive: "Find how VendorX handles data residency for EU customers",
      criteria: ["the residency answer cites a primary source"],
      submissionId: randomUUID(),
      ...overrides,
    };
  }

  async function outcomeCount(): Promise<number> {
    const rows = await db.pool.query(`SELECT count(*)::int AS n FROM outcomes`);
    return Number((rows.rows[0] as { n: number }).n);
  }

  async function activeOutcomeCount(): Promise<number> {
    const rows = await db.pool.query(
      `SELECT count(*)::int AS n FROM outcomes WHERE status NOT IN ('completed', 'failed', 'cancelled')`,
    );
    return Number((rows.rows[0] as { n: number }).n);
  }

  it("mode 'research' mints the runnable plan and dispatches exactly once", async () => {
    const dispatch = countingDispatch();
    const input = baseInput({ mode: "research" });
    const result = await createAndDispatchOutcome(exec, dispatch.port, input, OPTS);
    expect(result.alreadyRequested).toBe(false);
    expect(result.runId).toBe("run-1");
    expect(result.outcome.status).toBe("accepted");
    expect(result.criteria).toHaveLength(1);
    expect(result.outcome.plan).toEqual([
      { assign: { role: "research", task: "Find how VendorX handles data residency for EU customers" } },
    ]);
    expect(dispatch.calls).toEqual([
      { name: "outcome-executor", payload: { outcomeId: result.outcome.id, ref: result.outcome.ref } },
    ]);
  });

  it("researchPlanFor bounds a >200-char directive to 199 chars + a trailing ellipsis", () => {
    const long = "Residency".repeat(30); // 270 chars
    const plan = researchPlanFor(long);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.assign.role).toBe("research");
    const task = plan[0]!.assign.task;
    expect(task).toHaveLength(200);
    expect(task).toBe(`${long.slice(0, 199)}…`);
    expect(task.endsWith("…")).toBe(true);
    // At the bound: unchanged. Below it: verbatim.
    const exact = "d".repeat(200);
    expect(researchPlanFor(exact)[0]!.assign.task).toBe(exact);
    expect(researchPlanFor("short directive")[0]!.assign.task).toBe("short directive");
  });

  it("research mode stores the bounded plan for a long directive (created row deep-equals researchPlanFor)", async () => {
    const dispatch = countingDispatch();
    const directive = "Research the VendorX data residency posture carefully. ".repeat(5).trimEnd();
    expect(directive.length).toBeGreaterThan(200);
    const result = await createAndDispatchOutcome(
      exec, dispatch.port, baseInput({ mode: "research", directive }), OPTS,
    );
    expect(result.outcome.plan).toEqual(researchPlanFor(directive));
    const task = (result.outcome.plan[0] as { assign: { task: string } }).assign.task;
    expect(task).toHaveLength(200);
  });

  it("unsupported mode fails closed BEFORE creating anything", async () => {
    const dispatch = countingDispatch();
    const before = await outcomeCount();
    const unsupported = "analyze" as unknown as DelegationMode;
    await expect(
      createAndDispatchOutcome(exec, dispatch.port, baseInput({ mode: unsupported }), OPTS),
    ).rejects.toThrow(/not executable/);
    expect(await outcomeCount()).toBe(before);
    expect(dispatch.calls).toHaveLength(0);
  });

  it("absent mode → legacy owner-executed mission with an empty plan", async () => {
    const dispatch = countingDispatch();
    const result = await createAndDispatchOutcome(exec, dispatch.port, baseInput(), OPTS);
    expect(result.alreadyRequested).toBe(false);
    expect(result.outcome.plan).toEqual([]);
    expect(dispatch.calls).toHaveLength(1);
  });

  it("policy cap (maxActivePerPrincipal) still applies to research delegations", async () => {
    const dispatch = countingDispatch();
    const capPolicy = { ...POLICY, maxActivePerPrincipal: 1 };
    const first = await createAndDispatchOutcome(
      exec, dispatch.port, baseInput({ mode: "research", policy: capPolicy }), OPTS,
    );
    expect(first.alreadyRequested).toBe(false);
    await expect(
      createAndDispatchOutcome(
        exec, dispatch.port,
        baseInput({ mode: "research", policy: capPolicy, submissionId: randomUUID() }),
        OPTS,
      ),
    ).rejects.toThrow(/policy cap/);
    expect(await activeOutcomeCount()).toBe(1);
    expect(dispatch.calls).toHaveLength(1);
  });

  it("duplicate submissionId is idempotent: same outcome, alreadyRequested, no second dispatch", async () => {
    const dispatch = countingDispatch();
    const submissionId = randomUUID();
    const first = await createAndDispatchOutcome(
      exec, dispatch.port, baseInput({ mode: "research", submissionId }), OPTS,
    );
    const second = await createAndDispatchOutcome(
      exec, dispatch.port, baseInput({ mode: "research", submissionId }), OPTS,
    );
    expect(second.alreadyRequested).toBe(true);
    expect(second.outcome.id).toBe(first.outcome.id);
    expect(second.runId).toBeNull();
    expect(second.criteria).toEqual([]);
    expect(await activeOutcomeCount()).toBe(1);
    expect(dispatch.calls).toHaveLength(1);
  });
});
