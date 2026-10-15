// Research-ready attention copy (mission-execution v1): the outcome producer
// refines waiting_user copy when canonical evidence shows a SUCCEEDED research
// assignment carrying a result ("— research ready" / "Jehad OS finished the
// research. Review the result."), keeps the legacy parked copy otherwise, and
// blocked copy carries the canonical failureReason (truncated past 200 chars
// with a trailing ellipsis).
//
// Runs through transitionOutcome only (the producer is never called directly,
// exactly as in production); delivery enqueue is best-effort post-commit and
// hermetic against the isolated db. Needs PostgreSQL 16 — skipped unless
// TEST_DATABASE_URL is set.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// Lane B's kernel file — its presence is the merge gate for this suite.
const KERNEL_PRESENT = existsSync(fileURLToPath(new URL("./service.ts", import.meta.url)));

const ACTOR = "system:research-copy-test";
const T1 = new Date("2026-10-15T18:00:00.000Z");
const TITLE = "Chase the Acme quote";

type OutcomesModule = typeof import("../outcomes/service.js");
type AssignmentsModule = typeof import("../assignments/service.js");

describe.skipIf(!TEST_DATABASE_URL || !KERNEL_PRESENT)(
  "outcome producer research-ready copy (mission-execution v1)",
  () => {
    let db: IsolatedDb;
    let principalId: string;
    let outcomes: OutcomesModule;
    let assignments: AssignmentsModule;

    beforeAll(async () => {
      db = await createIsolatedTestDb(TEST_DATABASE_URL!, "prodcopy");
      await migrateUp(db.pool);
      await seedDomains(db.pool);
      const row = await db.pool.query(
        `INSERT INTO principals (type, name) VALUES ('user', 'research-copy-owner') RETURNING id`,
      );
      principalId = String(row.rows[0]!.id);
      // Module load arms the producer (resolver registration); the producer
      // is exercised THROUGH the transitionOutcome hook only.
      await import("./outcome-producer.js");
      outcomes = await import("../outcomes/service.js");
      assignments = await import("../assignments/service.js");
    });

    afterAll(async () => {
      await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
    });

    const exec = {
      query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]),
    };

    function q(sql: string, params: readonly unknown[] = []): { rows: Array<Record<string, unknown>> } {
      return db.pool.query(sql, params) as unknown as { rows: Array<Record<string, unknown>> };
    }

    async function seedOutcome(): Promise<{ id: string; ref: string }> {
      const created = await outcomes.createOutcome(
        exec,
        {
          principalId,
          title: TITLE,
          directive: "Keep track of the packaging quote and get everything ready when they reply.",
          criteria: [{ criterion: "Owner judges the outcome achieved" }],
          createdBy: "conversation",
        },
        { now: T1, actor: ACTOR },
      );
      return { id: created.outcome.id, ref: created.outcome.ref };
    }

    /** Drive an accepted outcome to `running` (the pre-attention state). */
    async function toRunning(id: string): Promise<void> {
      await outcomes.transitionOutcome(exec, id, "queued", {}, { now: T1, actor: ACTOR });
      await outcomes.transitionOutcome(exec, id, "running", {}, { now: T1, actor: ACTOR });
    }

    async function itemsFor(outcomeId: string): Promise<Array<Record<string, unknown>>> {
      const result = await q(
        `SELECT * FROM attention_items WHERE source_type = 'outcome' AND source_object_id = $1 ORDER BY kind ASC`,
        [outcomeId],
      );
      return result.rows;
    }

    /** Mint → run → complete one succeeded research assignment with a result for the outcome. */
    async function completeResearchAssignment(outcomeId: string): Promise<void> {
      const created = await assignments.createAssignment(
        exec,
        {
          outcomeId,
          principalId,
          role: "research",
          task: "Research the quote state",
          context: "ctx",
          successCriteria: ["grounded"],
          budgetUsd: 1,
        },
        { now: T1, actor: ACTOR },
      );
      await assignments.transitionAssignment(exec, created.assignment.id, "running", { now: T1, actor: ACTOR });
      await assignments.completeAssignment(
        exec,
        {
          assignmentId: created.assignment.id,
          result: {
            summary: "The quote is pending finance sign-off.",
            artifact: { title: "Quote state", body: "Grounded synthesis." },
            citations: [],
            costUsd: 0.002,
          },
          runId: null,
          domainId: "personal",
        },
        { now: T1, actor: ACTOR },
      );
    }

    it("waiting_user with a succeeded research assignment says 'research ready', not 'parked'", async () => {
      const { id } = await seedOutcome();
      await toRunning(id);
      await completeResearchAssignment(id);

      const done = await outcomes.transitionOutcome(exec, id, "waiting_user", {}, { now: T1, actor: ACTOR });
      expect(done.changed).toBe(true);

      const rows = await itemsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["kind"]).toBe("outcome.ready");
      expect(rows[0]!["title"]).toBe(`${TITLE} — research ready`);
      expect(rows[0]!["why_it_matters"]).toBe("Jehad OS finished the research. Review the result.");
    });

    it("waiting_user without any assignment keeps the legacy parked copy", async () => {
      const { id } = await seedOutcome();
      await toRunning(id);
      await outcomes.transitionOutcome(exec, id, "waiting_user", {}, { now: T1, actor: ACTOR });

      const rows = await itemsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["kind"]).toBe("outcome.ready");
      expect(rows[0]!["title"]).toBe(TITLE);
      expect(rows[0]!["why_it_matters"]).toBe(
        "Parked with you — the system can't do this one itself yet. Mark it done when it happens, or say it didn't.",
      );
    });

    it("blocked copy carries the canonical failureReason", async () => {
      const { id } = await seedOutcome();
      await toRunning(id);
      await outcomes.transitionOutcome(
        exec,
        id,
        "blocked",
        { failureReason: "worker role 'research' is not enabled by policy" },
        { now: T1, actor: ACTOR },
      );

      const rows = await itemsFor(id);
      const blocked = rows.find((r) => r["kind"] === "outcome.blocked")!;
      expect(blocked["title"]).toBe(`${TITLE} — blocked`);
      expect(blocked["why_it_matters"]).toBe("Blocked: worker role 'research' is not enabled by policy");
    });

    it("a failureReason over 200 chars is truncated with a trailing ellipsis", async () => {
      const { id } = await seedOutcome();
      await toRunning(id);
      const reason =
        "worker role 'research' is not enabled by policy"
        + " and the deadline passed while nobody was watching the queue"
        + "!".repeat(100);
      expect(reason.length).toBeGreaterThan(200);
      await outcomes.transitionOutcome(exec, id, "blocked", { failureReason: reason }, { now: T1, actor: ACTOR });

      const rows = await itemsFor(id);
      const blocked = rows.find((r) => r["kind"] === "outcome.blocked")!;
      expect(blocked["why_it_matters"]).toBe(`Blocked: ${reason.slice(0, 197)}…`);
    });
  },
);
