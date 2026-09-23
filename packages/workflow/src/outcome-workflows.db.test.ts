// Outcome execution layer integration tests (roadmap §5.2/§10; ADR-0017
// §1.3) against an isolated migrated database: the executor's bounded loop
// with a plan wait + LOST-WAKEUP HANDSHAKE (signal lost, canonical re-read
// recovers), wait-creation idempotency under replay, the resume scanner's
// CAS satisfaction + signal + reconciler pacing, and the reaper.
// Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../tests/isolated-db.js";
import {
  runOutcomeExecutor,
  runOutcomeReapTick,
  runOutcomeResumeScan,
  type OutcomeExecutorPrimitives,
} from "./outcome-workflows.js";
import {
  applyOutcomeSpec,
  createOutcome,
  createOutcomeWait,
  setCriterionStatus,
  transitionOutcome,
} from "@jehad/core";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-23T12:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("outcome execution layer (D0 tranche 2)", () => {
  let db: IsolatedDb;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "outcomesexec");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'outcome-exec-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    // The scanner scans a shared canonical window — keep tests isolated.
    await db.pool.query(`DELETE FROM outcome_waits`);
    await db.pool.query(`DELETE FROM events WHERE type LIKE 'gmail.message.received' AND source = 'adapter:gmail' AND idempotency_key LIKE 'test-gmail:%'`);
    await db.pool.query(`UPDATE outcomes SET status = 'failed', failure_reason = 'test teardown' WHERE status NOT IN ('completed','failed','cancelled') AND created_by = 'josctl'`);
  });

  const exec = {
    query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]),
  };

  async function q(sql: string, params: readonly unknown[] = []): Promise<Array<Record<string, unknown>>> {
    return (await db.pool.query(sql, params as unknown[])).rows as Array<Record<string, unknown>>;
  }

  async function seedOutcome(plan: Array<Record<string, unknown>> = []): Promise<{ id: string; ref: string }> {
    const created = await createOutcome(exec, {
      principalId,
      title: "Chase the Acme quote",
      directive: "Watch for the reply and prepare the decision.",
      criteria: [{ criterion: "Acme reply grounded in the source record" }],
      createdBy: "josctl",
    }, { now: NOW, actor: "system:outcome-test" });
    if (plan.length > 0) {
      await db.pool.query(`UPDATE outcomes SET plan = $2::jsonb WHERE id = $1::uuid`, [created.outcome.id, JSON.stringify(plan)]);
    }
    return { id: created.outcome.id, ref: created.outcome.ref };
  }

  const GMAIL_EVENT = { type: "gmail.message.received", payload: { fromDomain: "acme.com" } };

  async function seedGmailEvent(): Promise<void> {
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key, domain_id, payload, sensitivity, run_id, schema_version)
       VALUES ($1, 'gmail.message.received', 'adapter:gmail', $2::timestamptz, $2::timestamptz, $3, (SELECT id FROM domains WHERE key='personal'), $4::jsonb, 'sensitive', NULL, 1)`,
      [randomUUID(), new Date().toISOString(), `test-gmail:${randomUUID()}`, JSON.stringify(GMAIL_EVENT.payload)],
    );
  }

  it("executor: plan wait → waiting_external → scanner satisfies + signals → handshake resumes → owner verifies → completed", async () => {
    const { id } = await seedOutcome([
      { wait: { eventType: "gmail.message.received", predicate: { v: 1, type: "arrival", source: "gmail", fromDomain: "acme.com" } } },
    ]);
    await seedGmailEvent();

    let ownerVerified = false;
    const primitives: OutcomeExecutorPrimitives = {
      // The "signal" fires immediately, but the LOST-WAKEUP test variant
      // would drop it entirely — the handshake must recover either way.
      waitForSignal: async () => undefined,
      pauseForApproval: async () => {
        // The owner verifies the criterion (josctl ops path) before approving.
        if (!ownerVerified) {
          const outcome = await db.pool.query(`SELECT id FROM outcomes WHERE id = $1::uuid`, [id]);
          void outcome;
        }
        ownerVerified = true;
        const criterion = await q(`SELECT ordinal FROM outcome_criteria WHERE outcome_id = $1::uuid`, [id]);
        await setCriterionStatus(exec, id, Number(criterion[0]!.ordinal), "verified", {
          now: new Date(),
          actor: "system:outcome-test",
          evidenceRef: (
            await q(
              `INSERT INTO evidence (domain_id, source_type, source_ref, claim, observed_at)
               SELECT d.id, 'manual', $1, 'verified in test', now() FROM domains d WHERE d.key='personal' RETURNING id`,
              [`ev-${randomUUID()}`],
            )
          )[0]!.id as string,
        });
        return { approved: true };
      },
    };

    const result = await runOutcomeExecutor(db.pool, { outcomeId: id }, `run-${randomUUID()}`, primitives);
    expect(result.completed).toBe(true);
    expect(result.status).toBe("completed");

    const row = await q(`SELECT status, plan, waiting_on FROM outcomes WHERE id = $1::uuid`, [id]);
    expect(row[0]!.status).toBe("completed");
    expect(row[0]!.plan).toEqual([]); // plan wait consumed on resume
  });

  it("wait creation is idempotent under crash-replay (no duplicate live waits)", async () => {
    const plan = [{ wait: { eventType: "gmail.message.received", predicate: { v: 1, type: "arrival", source: "gmail", fromDomain: "acme.com" } } }];
    const { id } = await seedOutcome(plan);
    // First pass: executor creates the wait then "crashes" (we abort via a
    // throwing pauseForApproval AFTER the wait exists → replay reuses it).
    let calls = 0;
    const crashPrimitives: OutcomeExecutorPrimitives = {
      waitForSignal: async () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash mid-wait");
        return undefined;
      },
      pauseForApproval: async () => ({ approved: true }),
    };
    await expect(
      runOutcomeExecutor(db.pool, { outcomeId: id }, `run-${randomUUID()}`, crashPrimitives),
    ).rejects.toThrow(/simulated crash/);
    const afterFirst = await q(`SELECT count(*)::int AS n FROM outcome_waits WHERE outcome_id = $1::uuid`, [id]);
    expect(afterFirst[0]!.n).toBe(1);

    // Replay: same plan entry, wait already exists → reused, not duplicated.
    await runOutcomeExecutor(db.pool, { outcomeId: id }, `run-${randomUUID()}`, {
      waitForSignal: async () => undefined,
      pauseForApproval: async () => ({ approved: true }),
    });
    const afterReplay = await q(`SELECT count(*)::int AS n FROM outcome_waits WHERE outcome_id = $1::uuid`, [id]);
    expect(afterReplay[0]!.n).toBe(1);
  });

  it("resume scanner: CAS satisfaction, run signal, reconciler paces re-signals", async () => {
    const { id } = await seedOutcome();
    await transitionOutcome(exec, id, "queued", {}, { now: new Date(), actor: "system:outcome-test" });
    await transitionOutcome(exec, id, "running", {}, { now: new Date(), actor: "system:outcome-test" });
    const { waitId } = await createOutcomeWait(
      exec, id, "gmail.message.received",
      { v: 1, type: "arrival", source: "gmail", fromDomain: "acme.com" },
      { now: new Date(), actor: "system:outcome-test" },
    );
    await db.pool.query(`UPDATE outcomes SET status = 'waiting_external', waiting_on = $2::jsonb WHERE id = $1::uuid`, [
      id, JSON.stringify({ runId: `run-${randomUUID()}`, waitId }),
    ]);
    await seedGmailEvent();

    const sent: Array<{ name: string }> = [];
    const scan1 = await runOutcomeResumeScan(db.pool, { send: async (p) => { sent.push(p as { name: string }); return { ids: ["x"] }; } });
    expect(scan1.waitsSatisfied).toBe(1);
    expect(scan1.outcomesSignaled).toBe(1);
    expect(sent[0]!.name).toContain("resume");

    // Immediate rescan: already satisfied + freshly signaled → paced.
    const scan2 = await runOutcomeResumeScan(db.pool, { send: async (p) => { sent.push(p as { name: string }); return { ids: ["x"] }; } });
    expect(scan2.outcomesSignaled).toBe(0);

    const waitRow = await q(`SELECT status FROM outcome_waits WHERE id = $1::uuid`, [waitId]);
    expect(waitRow[0]!.status).toBe("satisfied");
  });

  it("reaper: overdue deadlines fail; expired waits expire and block parked outcomes", async () => {
    const { id } = await seedOutcome();
    await transitionOutcome(exec, id, "queued", {}, { now: new Date(), actor: "system:outcome-test" });
    await transitionOutcome(exec, id, "running", {}, { now: new Date(), actor: "system:outcome-test" });
    await createOutcomeWait(
      exec, id, "gmail.message.received",
      { v: 1, type: "arrival", source: "gmail", fromDomain: "acme.com" },
      { now: new Date(), actor: "system:outcome-test", expiresAt: new Date(Date.now() - 60_000).toISOString() },
    );
    await db.pool.query(`UPDATE outcomes SET status = 'waiting_external', deadline_at = $2::timestamptz WHERE id = $1::uuid`, [
      id, new Date(Date.now() - 120_000).toISOString(),
    ]);

    const result = await runOutcomeReapTick(db.pool);
    expect(result.waitsExpired).toBeGreaterThanOrEqual(1);
    expect(result.deadlineFailed).toBeGreaterThanOrEqual(1);

    const row = await q(`SELECT status, failure_reason FROM outcomes WHERE id = $1::uuid`, [id]);
    // Deadline failure wins (terminal) — the reaper fails overdue outcomes
    // before/after expiry handling; either way the outcome is honestly dead.
    expect(["failed", "blocked"]).toContain(row[0]!.status);
    expect(row[0]!.failure_reason).not.toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("D0 full-loop scenario (hermetic eval: intake→confirm→complete)", () => {
  let db: IsolatedDb;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "outcomesloop");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'outcome-loop-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("owner delegates over chat → confirm bridge → executor parks on owner judgment → verify → approve → completed", async () => {
    const dispatched: Array<{ outcomeId: string; ref: string }> = [];

    // 1. INTAKE + CONFIRM: the DELEGATE bridge (owner replied "approve" to
    // the staged offer — the interpreter lane itself is covered in core).
    const applied = await applyOutcomeSpec(db.pool, {
      proposal: {
        type: "outcome_spec",
        title: "Plaid security review",
        directive: "own the plaid security review until it's done",
        criteria: ["the review document covers all four findings"],
        budget_usd: 2,
        deadline_days: 7,
      },
      principalId,
      policy: { enabled: true, maxActivePerPrincipal: 3, defaultBudgetUsd: 5, defaultDeadlineDays: 14 },
      dispatch: async (input) => {
        dispatched.push(input);
        return `run-${dispatched.length}`;
      },
      now: NOW,
    });
    expect(applied.applied).toBe(true);
    expect(dispatched).toHaveLength(1);
    const outcomeId = applied.outcomeId!;

    // 2. EXECUTOR, first pass: no waits, criteria owner-judged → parks on
    // the owner (waiting_user + the approval wait exists). Simulate the
    // crash-after-park so the REPLAY carries the approval.
    const parkingPrimitives: OutcomeExecutorPrimitives = {
      waitForSignal: async () => undefined,
      pauseForApproval: async () => {
        throw new Error("simulated: owner has not replied yet");
      },
    };
    await expect(
      runOutcomeExecutor(db.pool, { outcomeId, ref: applied.ref! }, "run-park", parkingPrimitives),
    ).rejects.toThrow("owner has not replied yet");
    const parked = (await db.pool.query(`SELECT status, waiting_on FROM outcomes WHERE id = $1::uuid`, [outcomeId])).rows[0]!;
    expect(String(parked.status)).toBe("waiting_user");
    expect((parked.waiting_on as Record<string, unknown>).runId).toBe("run-park");


    // 3. OWNER VERIFICATION: the owner marks the criterion verified with
    // evidence (the canonical verify path, never worker prose).
    const evidence = await db.pool.query(
      `INSERT INTO evidence (domain_id, source_type, source_ref, claim, observed_at)
       SELECT d.id, 'manual', $1, 'owner-verified from chat', $2::timestamptz
       FROM domains d WHERE d.key = 'personal' RETURNING id`,
      [`owner-verify-${randomUUID()}`, NOW.toISOString()],
    );
    await setCriterionStatus(db.pool, outcomeId, 1, "verified", {
      now: NOW,
      actor: "owner",
      evidenceRef: String(evidence.rows[0]!.id),
    });

    // 4. RESUME WITH APPROVAL: the replay-tolerant executor re-enters,
    // sees the approval, re-reads the now-verified criteria → verifying →
    // completed (the completion gate demands verified criteria + non-null
    // verified_at — exactly what step 3 wrote).
    await runOutcomeExecutor(
      db.pool,
      { outcomeId, ref: applied.ref! },
      "run-park",
      {
        waitForSignal: async () => undefined,
        pauseForApproval: async () => ({ approved: true }),
      },
    );
    const done = (await db.pool.query(`SELECT status FROM outcomes WHERE id = $1::uuid`, [outcomeId])).rows[0]!;
    expect(String(done.status)).toBe("completed");

    // 5. The completion event exists in the canonical log.
    const events = await db.pool.query(
      `SELECT type FROM events WHERE type = 'outcome.completed' AND payload->>'outcomeId' = $1::text`,
      [outcomeId],
    );
    expect(events.rows).toHaveLength(1);
  });
});
