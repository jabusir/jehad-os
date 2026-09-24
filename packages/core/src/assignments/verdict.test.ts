// D3 verifier-core integration tests: the verifier result envelope
// (parseVerifierResult), the structural verdict application
// (applyVerifierVerdict), the verifier gates at mint time
// (createAssignment), evidence provenance (metadata.assignmentId), and the
// 027 verifier completion gate (up/down/up reversibility included).
// Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { createOutcome, transitionOutcome } from "@jehad/core";
import {
  AssignmentError,
  completeAssignment,
  createAssignment,
  transitionAssignment,
} from "./service.js";
import { applyVerifierVerdict, parseVerifierResult } from "./verdict.js";
import { setCriterionStatus } from "../outcomes/service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const ACTOR = "system:verifier-test";

describe.skipIf(!TEST_DATABASE_URL)("verifier verdict core (D3 integration)", () => {
  let db: IsolatedDb;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "d3verifiercore");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'verifier-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const exec = {
    query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]),
  };

  async function seedOutcome(): Promise<string> {
    const created = await createOutcome(exec, {
      principalId,
      title: "Verify the Acme findings",
      directive: "Independent verification of the research assignment's claims.",
      criteria: [
        { criterion: "Claim A holds up", verificationMethod: { kind: "owner_judgment" } },
        { criterion: "Claim B holds up", verificationMethod: { kind: "owner_judgment" } },
      ],
    }, { now: NOW, actor: ACTOR });
    return created.outcome.id;
  }

  const builderResult = {
    summary: "Acme findings summary.",
    artifact: { title: "Acme findings", body: "Grounded synthesis." },
    citations: [{ ref: "ev-1" }, { ref: "ev-2" }],
    costUsd: 0,
  };

  /** The real builder path: mint → run → succeed with two citations. */
  async function mintBuilder(outcomeId: string) {
    const created = await createAssignment(
      db.pool,
      { outcomeId, principalId, role: "research", task: "Research Acme", context: "ctx", successCriteria: ["grounded"], budgetUsd: 1 },
      { now: NOW, actor: ACTOR },
    );
    await transitionAssignment(db.pool, created.assignment.id, "running", { now: NOW, actor: ACTOR });
    const done = await completeAssignment(
      db.pool,
      { assignmentId: created.assignment.id, result: builderResult, runId: null, domainId: "personal" },
      { now: NOW, actor: ACTOR },
    );
    return done.assignment;
  }

  /** The real verifier path: mint (bound to the builder) → run → succeed. */
  async function mintVerifier(outcomeId: string, verifiesAssignmentId: string) {
    const created = await createAssignment(
      db.pool,
      { outcomeId, principalId, role: "verifier", task: "Verify Acme", context: "ctx", successCriteria: ["every verdict grounded"], budgetUsd: 1, verifiesAssignmentId },
      { now: NOW, actor: ACTOR },
    );
    await transitionAssignment(db.pool, created.assignment.id, "running", { now: NOW, actor: ACTOR });
    const done = await completeAssignment(
      db.pool,
      {
        assignmentId: created.assignment.id,
        result: {
          summary: "Checked against the builder's citations.",
          artifact: { title: "Verification", body: "Independent check." },
          citations: [{ ref: "verifier-note-1" }],
          costUsd: 0,
        },
        runId: null,
        domainId: "personal",
      },
      { now: NOW, actor: ACTOR },
    );
    return done.assignment;
  }

  const confirmed = (ordinal: number, citationIds: readonly number[]) => ({
    ordinal,
    verdict: "confirmed",
    reasoning: "grounded in the builder's citations",
    citation_ids: [...citationIds],
  });

  function q(sql: string, params: readonly unknown[] = []): { rows: Array<Record<string, unknown>> } {
    return db.pool.query(sql, params) as unknown as { rows: Array<Record<string, unknown>> };
  }

  // ------------------------------------------------------------ parse

  describe("parseVerifierResult", () => {
    it("parses the snake_case worker envelope (happy path)", () => {
      const parsed = parseVerifierResult({
        summary: "  Both claims verified.  ",
        verdicts: [
          { ordinal: 1, verdict: "confirmed", reasoning: "cited", citation_ids: [1, 2] },
          { ordinal: 2, verdict: "uncertain", reasoning: "no source", citation_ids: [] },
        ],
        confidence: 0.8,
        open_questions: ["what about the addendum?"],
      });
      expect(parsed).toEqual({
        summary: "Both claims verified.",
        verdicts: [
          { ordinal: 1, verdict: "confirmed", reasoning: "cited", citationIds: [1, 2] },
          { ordinal: 2, verdict: "uncertain", reasoning: "no source", citationIds: [] },
        ],
        confidence: 0.8,
        openQuestions: ["what about the addendum?"],
      });
    });

    it("rejects a bad verdict word (fail closed)", () => {
      expect(() =>
        parseVerifierResult({
          summary: "s",
          verdicts: [{ ordinal: 1, verdict: "mostly_true", reasoning: "r", citation_ids: [1] }],
        }),
      ).toThrow(AssignmentError);
    });

    it("lets a confirmation without citation_ids pass parse — the ≥1 rule lives in apply", () => {
      const parsed = parseVerifierResult({
        summary: "s",
        verdicts: [{ ordinal: 1, verdict: "confirmed", reasoning: "r" }],
      });
      expect(parsed.verdicts[0]!.citationIds).toEqual([]);
    });

    it("rejects malformed/oversized envelopes (fail closed)", () => {
      const good = { summary: "s", verdicts: [confirmed(1, [1])] };
      const cases: readonly unknown[] = [
        "nope",
        null,
        { ...good, summary: "" },
        { ...good, summary: "x".repeat(501) },
        { ...good, verdicts: [] },
        { ...good, verdicts: Array.from({ length: 11 }, (_, i) => confirmed(i + 1, [1])) },
        { ...good, verdicts: [{ ordinal: 0, verdict: "confirmed", reasoning: "r" }] },
        { ...good, verdicts: [{ ordinal: 1.5, verdict: "confirmed", reasoning: "r" }] },
        { ...good, verdicts: [confirmed(1, [1]), confirmed(1, [1])] }, // duplicate ordinals
        { ...good, verdicts: [{ ordinal: 1, verdict: "confirmed", reasoning: "" }] },
        { ...good, verdicts: [{ ordinal: 1, verdict: "confirmed", reasoning: "x".repeat(501) }] },
        { ...good, verdicts: [{ ordinal: 1, verdict: "confirmed", reasoning: "r", citation_ids: [0] }] },
        { ...good, verdicts: [{ ordinal: 1, verdict: "confirmed", reasoning: "r", citation_ids: [1.5] }] },
        { ...good, verdicts: [{ ordinal: 1, verdict: "confirmed", reasoning: "r", citation_ids: "1" }] },
        { ...good, confidence: 1.5 },
        { ...good, open_questions: Array.from({ length: 6 }, () => "q") },
        { ...good, open_questions: ["x".repeat(201)] },
        { ...good, open_questions: ["   "] },
      ];
      for (const bad of cases) {
        expect(() => parseVerifierResult(bad)).toThrow(AssignmentError);
      }
    });
  });

  // -------------------------------------------------------- application

  describe("applyVerifierVerdict", () => {
    it("happy path: confirmations verify criteria with the verifier's id, overall pass", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const verifier = await mintVerifier(outcomeId, builder.id);
      const result = {
        summary: "Both confirmed.",
        verdicts: [confirmed(1, [1, 2]), confirmed(2, [2])],
        confidence: 0.9,
      };
      const applied = await applyVerifierVerdict(
        db.pool,
        { verifierAssignmentId: verifier.id, outcomeId, result: parseVerifierResult(result) },
        { now: NOW, actor: ACTOR },
      );
      expect(applied).toEqual({ applied: 2, overall: "pass" });
      const criteria = await q(
        `SELECT ordinal, status, verified_by_assignment_id FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal`,
        [outcomeId],
      );
      expect(criteria.rows).toHaveLength(2);
      for (const row of criteria.rows) {
        expect(row.status).toBe("verified");
        expect(String(row.verified_by_assignment_id)).toBe(verifier.id);
      }
      const audits = await q(`SELECT outputs_ref FROM audit_log WHERE action = 'assignment.verdict_applied'`);
      const last = String(audits.rows.at(-1)!.outputs_ref);
      expect(last).toContain(outcomeId);
      expect(last).toContain(verifier.id);
      expect(last).toContain('"overall":"pass"');
      expect(last).not.toContain("grounded in"); // metadata-only: no reasoning
    });

    it("refuted → criterion failed, overall fail", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const verifier = await mintVerifier(outcomeId, builder.id);
      const applied = await applyVerifierVerdict(
        db.pool,
        {
          verifierAssignmentId: verifier.id,
          outcomeId,
          result: parseVerifierResult({
            summary: "s",
            verdicts: [confirmed(1, [1]), { ordinal: 2, verdict: "refuted", reasoning: "contradicted", citation_ids: [] }],
          }),
        },
        { now: NOW, actor: ACTOR },
      );
      expect(applied.overall).toBe("fail");
      const rows = await q(
        `SELECT ordinal, status FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal`,
        [outcomeId],
      );
      expect(rows.rows.map((r) => r.status)).toEqual(["verified", "failed"]);
    });

    it("uncertain → criterion unverified, overall partial", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const verifier = await mintVerifier(outcomeId, builder.id);
      const applied = await applyVerifierVerdict(
        db.pool,
        {
          verifierAssignmentId: verifier.id,
          outcomeId,
          result: parseVerifierResult({
            summary: "s",
            verdicts: [confirmed(1, [1]), { ordinal: 2, verdict: "uncertain", reasoning: "cannot tell", citation_ids: [] }],
          }),
        },
        { now: NOW, actor: ACTOR },
      );
      expect(applied.overall).toBe("partial");
      const rows = await q(
        `SELECT ordinal, status FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal`,
        [outcomeId],
      );
      expect(rows.rows.map((r) => r.status)).toEqual(["verified", "unverified"]);
    });
  });

  // ------------------------------------------------------- structural

  describe("applyVerifierVerdict structural (fail closed)", () => {
    it("rejects a research assignment in the verifier seat", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      await expect(
        applyVerifierVerdict(
          db.pool,
          { verifierAssignmentId: builder.id, outcomeId, result: parseVerifierResult({ summary: "s", verdicts: [confirmed(1, [1]), confirmed(2, [1])] }) },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/not verifier/);
    });

    it("rejects self-verification (verifies_assignment_id = its own id)", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const verifier = await mintVerifier(outcomeId, builder.id);
      await db.pool.query(`UPDATE assignments SET verifies_assignment_id = id WHERE id = $1::uuid`, [verifier.id]);
      await expect(
        applyVerifierVerdict(
          db.pool,
          { verifierAssignmentId: verifier.id, outcomeId, result: parseVerifierResult({ summary: "s", verdicts: [confirmed(1, [1]), confirmed(2, [1])] }) },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/self-verify/);
    });

    it("rejects a verifier whose verified assignment is another verifier", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const verifier = await mintVerifier(outcomeId, builder.id);
      const second = await mintVerifier(outcomeId, builder.id);
      await db.pool.query(`UPDATE assignments SET verifies_assignment_id = $2::uuid WHERE id = $1::uuid`, [second.id, verifier.id]);
      await expect(
        applyVerifierVerdict(
          db.pool,
          { verifierAssignmentId: second.id, outcomeId, result: parseVerifierResult({ summary: "s", verdicts: [confirmed(1, [1]), confirmed(2, [1])] }) },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/not research/);
    });

    it("rejects a confirmation citing an out-of-range citationId", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const verifier = await mintVerifier(outcomeId, builder.id);
      await expect(
        applyVerifierVerdict(
          db.pool,
          { verifierAssignmentId: verifier.id, outcomeId, result: parseVerifierResult({ summary: "s", verdicts: [confirmed(1, [99]), confirmed(2, [1])] }) },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/valid citation/);
    });

    it("rejects verdicts that miss a criterion ordinal", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const verifier = await mintVerifier(outcomeId, builder.id);
      await expect(
        applyVerifierVerdict(
          db.pool,
          { verifierAssignmentId: verifier.id, outcomeId, result: parseVerifierResult({ summary: "s", verdicts: [confirmed(1, [1])] }) },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/exactly cover/);
    });

    it("rejects an extra ordinal the criteria set does not have", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const verifier = await mintVerifier(outcomeId, builder.id);
      await expect(
        applyVerifierVerdict(
          db.pool,
          { verifierAssignmentId: verifier.id, outcomeId, result: parseVerifierResult({ summary: "s", verdicts: [confirmed(1, [1]), confirmed(2, [1]), confirmed(3, [1])] }) },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/exactly cover/);
    });

    it("rejects a verifier that is not succeeded", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const created = await createAssignment(
        db.pool,
        { outcomeId, principalId, role: "verifier", task: "queued verifier", context: "ctx", successCriteria: ["g"], budgetUsd: 1, verifiesAssignmentId: builder.id },
        { now: NOW, actor: ACTOR },
      );
      await expect(
        applyVerifierVerdict(
          db.pool,
          { verifierAssignmentId: created.assignment.id, outcomeId, result: parseVerifierResult({ summary: "s", verdicts: [confirmed(1, [1]), confirmed(2, [1])] }) },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/not succeeded/);
    });
  });

  // ------------------------------------------------- mint-time gates

  describe("createAssignment verifier gates", () => {
    it("verifier without verifiesAssignmentId throws", async () => {
      const outcomeId = await seedOutcome();
      await expect(
        createAssignment(
          db.pool,
          { outcomeId, principalId, role: "verifier", task: "t", context: "c", successCriteria: ["g"], budgetUsd: 1 },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/requires verifiesAssignmentId/);
    });

    it("verifier pointing at a research assignment that is not succeeded throws", async () => {
      const outcomeId = await seedOutcome();
      const queued = await createAssignment(
        db.pool,
        { outcomeId, principalId, role: "research", task: "not done yet", context: "c", successCriteria: ["g"], budgetUsd: 1 },
        { now: NOW, actor: ACTOR },
      );
      await expect(
        createAssignment(
          db.pool,
          { outcomeId, principalId, role: "verifier", task: "t", context: "c", successCriteria: ["g"], budgetUsd: 1, verifiesAssignmentId: queued.assignment.id },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/not succeeded/);
    });

    it("verifier verifying a verifier throws", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const verifier = await mintVerifier(outcomeId, builder.id);
      await expect(
        createAssignment(
          db.pool,
          { outcomeId, principalId, role: "verifier", task: "t", context: "c", successCriteria: ["g"], budgetUsd: 1, verifiesAssignmentId: verifier.id },
          { now: NOW, actor: ACTOR },
        ),
      ).rejects.toThrow(/builders don't self-verify/);
    });
  });

  // --------------------------------------------------- provenance

  describe("completeAssignment evidence provenance", () => {
    it("evidence rows carry metadata->>'assignmentId' of the producing assignment", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      const rows = await q(
        `SELECT source_ref, metadata->>'assignmentId' AS aid FROM evidence WHERE metadata->>'assignmentId' = $1 ORDER BY source_ref`,
        [builder.id],
      );
      expect(rows.rows).toHaveLength(2); // ev-1, ev-2
      for (const row of rows.rows) {
        expect(row.source_ref).toMatch(/^ev-/);
      }
    });
  });

  // ------------------------------------------------- 027 migration gate

  describe("027 verifier completion gate", () => {
    it("refuses verifying → completed while worker-verified criteria lack a succeeded verifier with evidence", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      for (const s of ["queued", "running", "verifying"] as const) {
        await transitionOutcome(exec, outcomeId, s, {}, { now: NOW, actor: ACTOR });
      }
      // A WORKER-verified criterion (attribution points at an assignment)
      // demands the verifier paper trail — that is the gate's whole point.
      await setCriterionStatus(exec, outcomeId, 1, "verified", {
        now: NOW, actor: ACTOR, verifiedByAssignmentId: builder.id,
      });
      const ev = await db.pool.query(
        `INSERT INTO evidence (domain_id, source_type, source_ref, claim, observed_at)
         SELECT id, 'manual', $1, 'criterion met', $2::timestamptz FROM domains WHERE key = 'personal' RETURNING id`,
        [`manual-${randomUUID()}`, NOW.toISOString()],
      );
      await setCriterionStatus(exec, outcomeId, 2, "verified", {
        now: NOW, actor: ACTOR, evidenceRef: String(ev.rows[0]!.id),
      });
      await expect(
        db.pool.query(`UPDATE outcomes SET status = 'completed' WHERE id = $1::uuid`, [outcomeId]),
      ).rejects.toThrow(/verifier/);
      const status = await q(`SELECT status FROM outcomes WHERE id = $1::uuid`, [outcomeId]);
      expect(status.rows[0]!.status).toBe("verifying");
    });

    it("owner-verified criteria (evidence_ref) complete without a verifier — owner judgment needs no worker paper trail", async () => {
      const outcomeId = await seedOutcome();
      for (const s of ["queued", "running", "verifying"] as const) {
        await transitionOutcome(exec, outcomeId, s, {}, { now: NOW, actor: ACTOR });
      }
      for (const ordinal of [1, 2]) {
        const ev = await db.pool.query(
          `INSERT INTO evidence (domain_id, source_type, source_ref, claim, observed_at)
           SELECT id, 'manual', $1, 'owner verified', $2::timestamptz FROM domains WHERE key = 'personal' RETURNING id`,
          [`manual-${randomUUID()}`, NOW.toISOString()],
        );
        await setCriterionStatus(exec, outcomeId, ordinal, "verified", {
          now: NOW, actor: ACTOR, evidenceRef: String(ev.rows[0]!.id),
        });
      }
      await db.pool.query(`UPDATE outcomes SET status = 'completed' WHERE id = $1::uuid`, [outcomeId]);
      const status = await q(`SELECT status FROM outcomes WHERE id = $1::uuid`, [outcomeId]);
      expect(status.rows[0]!.status).toBe("completed");
    });

    it("passes once a succeeded verifier with its own evidence exists", async () => {
      const outcomeId = await seedOutcome();
      const builder = await mintBuilder(outcomeId);
      for (const s of ["queued", "running", "verifying"] as const) {
        await transitionOutcome(exec, outcomeId, s, {}, { now: NOW, actor: ACTOR });
      }
      const verifier = await mintVerifier(outcomeId, builder.id);
      const evidence = await q(
        `SELECT count(*)::int AS n FROM evidence WHERE metadata->>'assignmentId' = $1`,
        [verifier.id],
      );
      expect(Number(evidence.rows[0]!.n)).toBeGreaterThanOrEqual(1);
      await applyVerifierVerdict(
        db.pool,
        {
          verifierAssignmentId: verifier.id,
          outcomeId,
          result: parseVerifierResult({ summary: "s", verdicts: [confirmed(1, [1]), confirmed(2, [2])] }),
        },
        { now: NOW, actor: ACTOR },
      );
      await db.pool.query(`UPDATE outcomes SET status = 'completed' WHERE id = $1::uuid`, [outcomeId]);
      const status = await q(`SELECT status FROM outcomes WHERE id = $1::uuid`, [outcomeId]);
      expect(status.rows[0]!.status).toBe("completed");
    });

    it("down/up reversibility: trigger + deferred FK drop and return cleanly", async () => {
      const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
      const forward = await readFile(path.join(dir, "027_verifier_gate.sql"), "utf8");
      const down = await readFile(path.join(dir, "027_verifier_gate.down.sql"), "utf8");
      await db.pool.query(down);
      const afterDown = await q(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'outcomes_verifier_gate'`,
      );
      expect(Number(afterDown.rows[0]!.n)).toBe(0);
      const fkAfterDown = await q(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'outcome_criteria_verified_by_fk'`,
      );
      expect(Number(fkAfterDown.rows[0]!.n)).toBe(0);
      await db.pool.query(forward);
      const afterUp = await q(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'outcomes_verifier_gate'`,
      );
      expect(Number(afterUp.rows[0]!.n)).toBe(1);
      const fkAfterUp = await q(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'outcome_criteria_verified_by_fk'`,
      );
      expect(Number(fkAfterUp.rows[0]!.n)).toBe(1);
    });
  });
});
