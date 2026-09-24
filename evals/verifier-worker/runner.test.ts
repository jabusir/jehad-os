// D3 verifier-worker golden eval (roadmap D3: verifier prompt-stance + strict
// verdict contract + the pin "builders don't self-verify" — a verdict can
// never mint work, and an honest uncertain never flips a criterion).
//
// Hermetic: fake harness, fake clock, isolated migrated DB. Fixtures in
// ./fixtures.json. Needs PostgreSQL 16 (TEST_DATABASE_URL), like every
// integration-grade eval in this repo. Executor-free by design: this eval
// drives the CORE pieces directly (assignment service + verdict application),
// so it does not depend on the executor's verifier lane.
//
// The verdict envelope ({summary, verdicts, confidence, open_questions}) is
// the verifier's MODEL OUTPUT; the assignment's stored result envelope is the
// service-valid research shape (no citations — the verifier adds no evidence,
// it only judges), and the verdict flows to the criteria only through
// parseVerifierResult → applyVerifierVerdict (fail-closed at application).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db.js";
import {
  createAssignment,
  createOutcome,
  completeAssignment,
  transitionAssignment,
} from "@jehad/core";
import { applyVerifierVerdict, parseVerifierResult } from "../../packages/core/src/assignments/verdict.js";
import type { HarnessCapableAdapter } from "@jehad/adapters";
import { buildVerifierTask } from "../../packages/workflow/src/verifier-stance.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const VERIFIER_SUCCESS_CRITERIA = ["verdicts cover every criterion with grounded citations"];

interface VerifierFixture {
  readonly name: string;
  readonly directive: string;
  readonly criteria: readonly [string, string];
  readonly builderOutput: string;
  readonly verifierOutput: string;
  readonly expect: {
    /** Application must refuse fail-closed; criteria stay pending. */
    readonly rejected?: boolean;
    readonly criteria: readonly string[];
    readonly overall: "pass" | "fail" | "partial";
    readonly evidenceRows?: number;
    readonly extraAssignments: 0;
    readonly openQuestions?: number;
  };
}

const FIXTURES = (JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as {
  cases: VerifierFixture[];
}).cases;

/** Hermetic stand-in for the model harness: start() returns the fixture's
 *  canned output (ok:true, small cost, promptVersion echoed via status). */
const fakeHarness = (text: string): HarnessCapableAdapter => {
  let lastPromptVersion: string | null = null;
  return {
    id: "eval-fake-harness",
    capabilities: () => ["model:call"],
    start: async (spec) => {
      lastPromptVersion = spec.promptVersion;
      return { ok: true, text, costUsd: 0.0005, latencyMs: 5 };
    },
    status: () => ({ runKey: lastPromptVersion ?? "", state: "succeeded", latencyMs: 5 }),
    cancel: async () => ({ cancelled: false, reason: "n/a" }),
    artifacts: async () => ({ text }),
  };
};

describe.skipIf(!TEST_DATABASE_URL)("verifier worker golden eval (D3)", () => {
  let db: IsolatedDb;
  let principalId: string;
  let sql: { query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

  const countRows = async (query: string, params: readonly unknown[] = []): Promise<number> => {
    const rows = await sql.query(query, params);
    return Number(rows.rows[0]!.n);
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "d3verifiereval");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'verifier-eval-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
    sql = {
      query: (text: string, values: readonly unknown[] = []) => db.pool.query(text, values as unknown[]),
    };
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  for (const fixture of FIXTURES) {
    it(`golden: ${fixture.name}`, async () => {
      const assignmentsBefore = await countRows(`SELECT count(*)::int AS n FROM assignments`);
      const evidenceBefore = await countRows(
        `SELECT count(*)::int AS n FROM evidence WHERE source_type = 'assignment'`,
      );

      // The outcome carries the OWNER-CONFIRMED criteria set — the pin under
      // every case (verdicts flip statuses, never the set, never mint work).
      const created = await createOutcome(
        sql,
        {
          principalId,
          title: `Eval: ${fixture.name}`,
          directive: fixture.directive,
          criteria: fixture.criteria.map((criterion) => ({ criterion })),
          createdBy: "josctl",
        },
        { now: NOW, actor: "system:eval" },
      );
      const outcomeId = created.outcome.id;
      const deadline = new Date(NOW.getTime() + 30 * 60_000).toISOString();

      // Builder lane: hermetic harness returns the canned builder envelope.
      const builderEnvelope = JSON.parse(fixture.builderOutput) as Record<string, unknown>;
      const builderText = (
        await fakeHarness(fixture.builderOutput).start({
          prompt: "hermetic builder prompt",
          promptVersion: "d3-verifier-eval",
          model: "fake/research-model",
          runId: randomUUID(),
          principalId,
          outcomeId,
          assignmentId: null,
        })
      ).text;
      expect(builderText).toBe(fixture.builderOutput);

      // Builder through the REAL core path: citations land as evidence rows.
      const builder = await createAssignment(
        sql,
        {
          outcomeId,
          principalId,
          role: "research",
          task: fixture.directive,
          context: `Outcome ${created.outcome.ref} context package: [src-1], [src-2] (bounded; untrusted data).`,
          successCriteria: [...fixture.criteria],
          budgetUsd: 0.5,
          deadlineAt: deadline,
        },
        { now: NOW, actor: "system:eval" },
      );
      await transitionAssignment(sql, builder.assignment.id, "running", { now: NOW, actor: "system:eval" });
      const doneBuilder = await completeAssignment(
        sql,
        { assignmentId: builder.assignment.id, result: builderEnvelope, runId: null, domainId: "personal" },
        { now: NOW, actor: "system:eval" },
      );
      expect(doneBuilder.evidenceIds).toHaveLength(2);

      // Verifier lane: minted through the REAL service — role verifier bound
      // to the succeeded builder (structural builder ≠ verifier on mint).
      const verifierTask = buildVerifierTask({
        outcomeRef: created.outcome.ref,
        directive: fixture.directive,
        criteria: fixture.criteria,
        builderTitle: String((builderEnvelope.artifact as Record<string, unknown>).title),
      });
      const verifierText = (
        await fakeHarness(fixture.verifierOutput).start({
          prompt: "hermetic verifier prompt",
          promptVersion: "d3-verifier-eval",
          model: "fake/verifier-model",
          runId: randomUUID(),
          principalId,
          outcomeId,
          assignmentId: null,
        })
      ).text;
      expect(verifierText).toBe(fixture.verifierOutput);
      const verdictEnvelope = JSON.parse(verifierText) as Record<string, unknown>;

      const verifier = await createAssignment(
        sql,
        {
          outcomeId,
          principalId,
          role: "verifier",
          task: verifierTask,
          context: JSON.stringify(doneBuilder.assignment.result),
          successCriteria: VERIFIER_SUCCESS_CRITERIA,
          budgetUsd: 0.5,
          deadlineAt: deadline,
          verifiesAssignmentId: builder.assignment.id,
        },
        { now: NOW, actor: "system:eval" },
      );
      await transitionAssignment(sql, verifier.assignment.id, "running", { now: NOW, actor: "system:eval" });

      // The verdict envelope is the MODEL OUTPUT, not the stored result: the
      // assignment completes with the service-valid envelope shape (no
      // citations — the verifier adds no evidence, it only judges).
      const doneVerifier = await completeAssignment(
        sql,
        {
          assignmentId: verifier.assignment.id,
          result: {
            summary: String(verdictEnvelope.summary),
            artifact: { title: "Verification", body: String(verdictEnvelope.summary) },
            citations: [],
            costUsd: 0,
          },
          runId: null,
          domainId: "personal",
        },
        { now: NOW, actor: "system:eval" },
      );
      expect(String(doneVerifier.assignment.status)).toBe("succeeded");

      // Application: parse (fail-closed) then apply (fail-closed again —
      // grounded confirmations, exact criteria coverage, builder ≠ verifier).
      const parsedVerdict = parseVerifierResult(verdictEnvelope);
      let applied: { readonly applied: number; readonly overall: string } | null = null;
      let applyThrew = false;
      try {
        applied = await applyVerifierVerdict(
          sql,
          { verifierAssignmentId: verifier.assignment.id, outcomeId, result: parsedVerdict },
          { now: NOW, actor: "system:eval:verifier" },
        );
      } catch {
        applyThrew = true;
      }

      // ------------------------------------------------------- assertions

      // Exactly builder + verifier for the outcome — application never mints.
      const assignmentsForOutcome = await db.pool.query(
        `SELECT id, role, status FROM assignments WHERE outcome_id = $1::uuid ORDER BY created_at`,
        [outcomeId],
      );
      expect(assignmentsForOutcome.rows).toHaveLength(2);
      const verifierRow = assignmentsForOutcome.rows.find((r) => r.role === "verifier")!;

      if (fixture.expect.rejected === true) {
        // Fail-closed at application; the assignment itself is succeeded —
        // the verdict simply never reached the criteria.
        expect(applyThrew).toBe(true);
        expect(applied).toBeNull();
      } else {
        expect(applyThrew).toBe(false);
        expect(applied).not.toBeNull();
        expect(applied!.overall).toBe(fixture.expect.overall);
      }
      expect(String(verifierRow.status)).toBe("succeeded");

      // Criteria statuses exact; verified rows carry the verifier's id.
      const criteriaRows = await db.pool.query(
        `SELECT ordinal, status, verified_by_assignment_id FROM outcome_criteria
          WHERE outcome_id = $1::uuid ORDER BY ordinal`,
        [outcomeId],
      );
      expect(criteriaRows.rows.map((r) => String(r.status))).toEqual(fixture.expect.criteria);
      for (const [i, row] of criteriaRows.rows.entries()) {
        if (fixture.expect.criteria[i] === "verified") {
          expect(String(row.verified_by_assignment_id)).toBe(String(verifierRow.id));
        }
      }

      // Overall semantics recomputed from DB criteria statuses.
      const overall = fixture.expect.criteria.every((s) => s === "verified")
        ? "pass"
        : fixture.expect.criteria.includes("failed")
          ? "fail"
          : "partial";
      expect(overall).toBe(fixture.expect.overall);

      // Evidence delta: the builder's citations only — verdicts never land
      // evidence of their own.
      const evidenceAfter = await countRows(
        `SELECT count(*)::int AS n FROM evidence WHERE source_type = 'assignment'`,
      );
      expect(evidenceAfter - evidenceBefore).toBe(fixture.expect.evidenceRows ?? 2);

      // Count-pinned across the WHOLE table: builder + verifier, no thirds
      // (the injection case's "create a follow-up assignment" never mints).
      const assignmentsAfter = await countRows(`SELECT count(*)::int AS n FROM assignments`);
      expect(assignmentsAfter - assignmentsBefore).toBe(2 + fixture.expect.extraAssignments);

      if (fixture.expect.openQuestions !== undefined) {
        expect(parsedVerdict.openQuestions.length).toBe(fixture.expect.openQuestions);
      }
    });
  }
});
