// D2 research-worker golden eval (roadmap D2 tests/evals: "golden research
// tasks vs fixtures; citation→evidence round-trip" + the adversarial pin
// "injected content … may appear in a summary but cannot change success
// criteria or mint follow-on work").
//
// Hermetic: fake harness, fake clock, isolated migrated DB. Fixtures in
// ./fixtures.json. Needs PostgreSQL 16 (TEST_DATABASE_URL), like every
// integration-grade eval in this repo.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db.js";
import { createOutcome } from "@jehad/core";
import { runOutcomeExecutor, type OutcomeExecutorPrimitives } from "../../packages/workflow/src/outcome-workflows.js";
import type { HarnessCapableAdapter } from "@jehad/adapters";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-23T12:00:00.000Z");

interface FixtureCase {
  readonly name: string;
  readonly task: string;
  readonly workerOutput: string;
  readonly expect: {
    readonly assignmentStatus: string;
    readonly outcomeStatusAfterPark?: string;
    readonly minCitations?: number;
    readonly evidenceRows?: number;
    readonly confidence?: number;
    readonly openQuestions?: number;
    readonly maxAssignmentsCreated?: number;
    readonly criteriaUnchanged?: boolean;
    readonly reasonContains?: string;
  };
}

const FIXTURES = (JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as {
  cases: FixtureCase[];
}).cases;

describe.skipIf(!TEST_DATABASE_URL)("research worker golden eval (D2)", () => {
  let db: IsolatedDb;
  let principalId: string;

  const parkingPrimitives: OutcomeExecutorPrimitives = {
    waitForSignal: async () => undefined,
    pauseForApproval: async () => {
      throw new Error("owner has not replied yet");
    },
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "d2research");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'research-eval-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const WORKERS_POLICY = {
    enabled: true,
    roles: {
      research: {
        model: "fake/research-model",
        maxBudgetUsd: 0.05,
        defaultDeadlineMinutes: 30,
        reads: ["gmail.metadata.recent", "memory.relevant"] as const,
      },
    },
  };

  for (const fixture of FIXTURES) {
    it(`golden: ${fixture.name}`, async () => {
      // Seed the outcome with a research plan step. Criteria are the
      // OWNER-CONFIRMED set — the injection pin asserts they never change.
      const created = await createOutcome(
        { query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]) },
        {
          principalId,
          title: `Eval: ${fixture.name}`,
          directive: fixture.task,
          criteria: [{ criterion: "every claim grounded in the package" }],
          createdBy: "josctl",
        },
        { now: NOW, actor: "system:eval" },
      );
      const outcomeId = created.outcome.id;
      await db.pool.query(`UPDATE outcomes SET plan = $2::jsonb WHERE id = $1::uuid`, [
        outcomeId,
        JSON.stringify([{ assign: { role: "research", task: fixture.task } }]),
      ]);
      const criteriaBefore = await db.pool.query(
        `SELECT ordinal, criterion, status FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal`,
        [outcomeId],
      );
      const assignmentsBefore = await db.pool.query(`SELECT count(*)::int AS n FROM assignments`);
      const grantsBefore = await db.pool.query(`SELECT count(*)::int AS n FROM capability_grants`);
      const evidenceBefore = await db.pool.query(
        `SELECT count(*)::int AS n FROM evidence WHERE source_type = 'assignment'`,
      );

      const harness: HarnessCapableAdapter = {
        id: "eval-fake-harness",
        capabilities: () => ["model:call"],
        start: async () => ({
          ok: true,
          text: fixture.workerOutput,
          costUsd: 0.002,
          latencyMs: 5,
        }),
        status: () => ({ runKey: "", state: "unknown", latencyMs: null }),
        cancel: async () => ({ cancelled: false, reason: "n/a" }),
        artifacts: async () => ({ text: null }),
      };

      let parked = false;
      try {
        await runOutcomeExecutor(
          db.pool,
          { outcomeId },
          `run-${randomUUID()}`,
          parkingPrimitives,
          { harness, workersPolicy: WORKERS_POLICY },
        );
      } catch {
        parked = true; // the owner-verification park (succeeded cases)
      }

      const assignments = await db.pool.query(
        `SELECT id, status, result, failure_reason FROM assignments WHERE outcome_id = $1::uuid`,
        [outcomeId],
      );
      expect(assignments.rows).toHaveLength(1);
      const assignment = assignments.rows[0]!;
      expect(String(assignment.status)).toBe(fixture.expect.assignmentStatus);

      if (fixture.expect.assignmentStatus === "succeeded") {
        const result = assignment.result as Record<string, unknown>;
        const citations = result.citations as unknown[];
        expect(citations.length).toBeGreaterThanOrEqual(fixture.expect.minCitations ?? 1);
        if (fixture.expect.confidence !== undefined) {
          expect(result.confidence).toBe(fixture.expect.confidence);
        }
        if (fixture.expect.openQuestions !== undefined) {
          expect((result.openQuestions as unknown[]).length).toBe(fixture.expect.openQuestions);
        }
        // citation → evidence round-trip: every citation id lands in evidence
        const evidenceIds = result.evidenceIds as string[];
        expect(evidenceIds.length).toBe(citations.length);
        for (const evidenceId of evidenceIds) {
          const row = await db.pool.query(`SELECT id FROM evidence WHERE id = $1::uuid AND source_type = 'assignment'`, [evidenceId]);
          expect(row.rows).toHaveLength(1);
        }
        // adversarial pin: output is DATA — follow-on work is never minted
        if (fixture.expect.maxAssignmentsCreated !== undefined) {
          const total = await db.pool.query(`SELECT count(*)::int AS n FROM assignments`);
          expect(Number(total.rows[0]!.n) - Number(assignmentsBefore.rows[0]!.n)).toBeLessThanOrEqual(
            fixture.expect.maxAssignmentsCreated,
          );
        }
        if (fixture.expect.criteriaUnchanged === true) {
          const criteriaAfter = await db.pool.query(
            `SELECT ordinal, criterion, status FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal`,
            [outcomeId],
          );
          expect(criteriaAfter.rows).toEqual(criteriaBefore.rows);
        }
        if (fixture.expect.grantCountUnchangedAfterCompletion === true) {
          const grantsAfter = await db.pool.query(
            `SELECT count(*)::int AS n FROM capability_grants WHERE revoked_at IS NULL`,
          );
          const grantsTotal = await db.pool.query(`SELECT count(*)::int AS n FROM capability_grants`);
          // the assignment's grant was minted then revoked on completion
          expect(Number(grantsTotal.rows[0]!.n) - Number(grantsBefore.rows[0]!.n)).toBe(1);
          expect(Number(grantsAfter.rows[0]!.n)).toBe(0);
        }
        expect(parked).toBe(true);
      } else {
        // rejected cases: nothing half-landed (evidence delta from THIS run is zero)
        const evidence = await db.pool.query(
          `SELECT count(*)::int AS n FROM evidence WHERE source_type = 'assignment'`,
        );
        expect(Number(evidence.rows[0]!.n) - Number(evidenceBefore.rows[0]!.n)).toBe(
          fixture.expect.evidenceRows ?? 0,
        );
        if (fixture.expect.reasonContains !== undefined) {
          expect(String(assignment.failure_reason)).toContain(fixture.expect.reasonContains);
        }
        if (fixture.expect.outcomeStatusAfterPark !== undefined) {
          const outcome = await db.pool.query(`SELECT status FROM outcomes WHERE id = $1::uuid`, [outcomeId]);
          expect(String(outcome.rows[0]!.status)).toBe(fixture.expect.outcomeStatusAfterPark);
        }
      }
    });
  }
});
