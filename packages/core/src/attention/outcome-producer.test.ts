// Outcome attention producer integration tests (W1; ADR-0018 §4, w1-contract
// "Producer seam"): the transitionOutcome hook's map — waiting_user/blocked/
// failed open items, completed/cancelled open NOTHING, leaving a held state
// resolves producer-side, reopen preserves first_raised_at, repeated
// identical transitions are no-ops — against an isolated migrated database.
//
// GUARD: the producer imports the attention kernel (./service.ts — Lane B)
// and the DB needs migration 029 (attention_items). Until that lane merges,
// the file skips without executing (the module graph cannot load at all);
// post-merge it runs against the REAL kernel — no mocks, no stubs.
// Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// Lane B's kernel file — its presence is the merge gate for this suite.
const KERNEL_PRESENT = existsSync(fileURLToPath(new URL("./service.ts", import.meta.url)));

const ACTOR = "system:producer-test";
const T1 = new Date("2026-06-15T18:00:00.000Z"); // 11:00 PT — inside delivery hours
const T2 = new Date("2026-06-15T19:00:00.000Z");
const T3 = new Date("2026-06-15T20:00:00.000Z");

type OutcomesModule = typeof import("../outcomes/service.js");

describe.skipIf(!TEST_DATABASE_URL || !KERNEL_PRESENT)(
  "outcome attention producer (W1, ADR-0018 §4)",
  () => {
    let db: IsolatedDb;
    let principalId: string;
    let outcomes: OutcomesModule;

    beforeAll(async () => {
      db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w1prodatt");
      await migrateUp(db.pool);
      await seedDomains(db.pool);
      const row = await db.pool.query(
        `INSERT INTO principals (type, name) VALUES ('user', 'producer-owner') RETURNING id`,
      );
      principalId = String(row.rows[0]!.id);
      // Module load both arms the producer (resolver registration) and is
      // exercised THROUGH the transitionOutcome hook — the producer is never
      // called directly here, exactly as in production.
      await import("./outcome-producer.js");
      outcomes = await import("../outcomes/service.js");
    });

    afterAll(async () => {
      await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
    });

    const exec = {
      query: (sql: string, params: readonly unknown[] = []) =>
        db.pool.query(sql, params as unknown[]),
    };

    function q(sql: string, params: readonly unknown[] = []): { rows: Array<Record<string, unknown>> } {
      return db.pool.query(sql, params) as unknown as { rows: Array<Record<string, unknown>> };
    }

    async function seedOutcome(title = "Chase the Acme quote"): Promise<{ id: string; ref: string }> {
      const created = await outcomes.createOutcome(
        exec,
        {
          principalId,
          title,
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
        `SELECT * FROM attention_items WHERE source_type = 'outcome' AND source_object_id = $1
         ORDER BY kind ASC`,
        [outcomeId],
      );
      return result.rows;
    }

    it("waiting_user opens exactly one outcome.ready item and enqueues its delivery", async () => {
      const { id, ref } = await seedOutcome();
      await toRunning(id);

      const done = await outcomes.transitionOutcome(exec, id, "waiting_user", {}, { now: T1, actor: ACTOR });
      expect(done.changed).toBe(true);

      const rows = await itemsFor(id);
      expect(rows).toHaveLength(1);
      const item = rows[0]!;
      expect(item["kind"]).toBe("outcome.ready");
      expect(item["fingerprint"]).toBe(`outcome:${id}:ready`);
      expect(item["state"]).toBe("open");
      expect(item["level"]).toBe("inbox");
      expect(item["safety_class"]).toBe("none");
      expect(item["title"]).toBe("Chase the Acme quote — ready for your judgment");
      expect(item["why_it_matters"]).toBe("Delegated work needs your decision to continue.");
      expect(item["evidence_refs"]).toEqual([{ type: "outcome", id: ref }]);
      expect(item["actions"]).toEqual([
        { key: "outcome.open", args: { ref } },
        { key: "attention.resolve" },
      ]);
      expect(item["occurrences"]).toBe(1);
      expect(item["change_fingerprint"]).toBe(`${id}:waiting_user:${T1.toISOString()}`);
      expect(item["resolved_at"]).toBeNull();

      // Delivery seam fired (salience passes midday): one auto-approved
      // attention notification pointing at the item, attempt stamped.
      const notifications = await q(
        `SELECT kind, status, source_type, source_id, payload FROM notifications WHERE source_id = $1`,
        [String(item["id"])],
      );
      expect(notifications.rows).toHaveLength(1);
      expect(notifications.rows[0]!["kind"]).toBe("attention");
      expect(notifications.rows[0]!["status"]).toBe("approved");
      expect(notifications.rows[0]!["source_type"]).toBe("attention");
      const attempts = await q(`SELECT delivery_attempts FROM attention_items WHERE id = $1::uuid`, [
        String(item["id"]),
      ]);
      expect(Number(attempts.rows[0]!["delivery_attempts"])).toBe(1);

      // ids/counts-only event payload contract (invariant 8).
      const opened = await q(
        `SELECT payload FROM events WHERE type = 'attention.item.opened'`,
      );
      expect(opened.rows).toHaveLength(1);
      expect(JSON.stringify(opened.rows[0]!["payload"])).not.toContain("Acme");
    });

    it("repeated identical transition is a no-op (early return, no bump, no re-delivery)", async () => {
      const { id } = await seedOutcome();
      await toRunning(id);
      await outcomes.transitionOutcome(exec, id, "waiting_user", {}, { now: T1, actor: ACTOR });
      const before = await itemsFor(id);

      const repeat = await outcomes.transitionOutcome(exec, id, "waiting_user", {}, { now: T2, actor: ACTOR });
      expect(repeat.changed).toBe(false);

      const after = await itemsFor(id);
      expect(after).toHaveLength(1);
      expect(after[0]!["occurrences"]).toBe(1);
      expect(after[0]!["change_fingerprint"]).toBe(before[0]!["change_fingerprint"]);
      expect(String(after[0]!["updated_at"])).toBe(String(before[0]!["updated_at"]));
      // No second push for this outcome (the file shares one isolated db —
      // scope the count to this outcome's item rows).
      const notifications = await q(
        `SELECT 1 FROM notifications n JOIN attention_items ai ON ai.id = n.source_id::uuid
         WHERE n.kind = 'attention' AND ai.source_object_id = $1`,
        [id],
      );
      expect(notifications.rows).toHaveLength(1);
    });

    it("waiting_user → running resolves the held item producer-side", async () => {
      const { id } = await seedOutcome();
      await toRunning(id);
      await outcomes.transitionOutcome(exec, id, "waiting_user", {}, { now: T1, actor: ACTOR });

      await outcomes.transitionOutcome(exec, id, "running", {}, { now: T2, actor: ACTOR });

      const rows = await itemsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["state"]).toBe("resolved");
      expect(rows[0]!["resolved_by"]).toBe("producer");
      expect(rows[0]!["resolution_reason"]).toBe("outcome_running");
      expect(rows[0]!["resolved_at"]).not.toBeNull();
    });

    it("running → waiting_user again REOPENS the same row (occurrences 2, fresh fingerprint, first_raised_at preserved)", async () => {
      const { id } = await seedOutcome();
      await toRunning(id);
      await outcomes.transitionOutcome(exec, id, "waiting_user", {}, { now: T1, actor: ACTOR });
      const original = (await itemsFor(id))[0]!;
      await outcomes.transitionOutcome(exec, id, "running", {}, { now: T2, actor: ACTOR });
      await outcomes.transitionOutcome(exec, id, "waiting_user", {}, { now: T3, actor: ACTOR });

      const rows = await itemsFor(id);
      expect(rows).toHaveLength(1);
      const reopened = rows[0]!;
      expect(String(reopened["id"])).toBe(String(original["id"])); // same row, not a second
      expect(reopened["state"]).toBe("open");
      expect(reopened["occurrences"]).toBe(2);
      expect(reopened["change_fingerprint"]).toBe(`${id}:waiting_user:${T3.toISOString()}`);
      expect(reopened["change_fingerprint"]).not.toBe(original["change_fingerprint"]);
      expect(reopened["first_raised_at"]).toEqual(original["first_raised_at"]);
      expect(reopened["resolved_at"]).toBeNull();
      expect(reopened["resolved_by"]).toBeNull();
    });

    it("waiting_user → blocked resolves the ready item and opens the blocked item; unblock resolves it", async () => {
      const { id } = await seedOutcome();
      await toRunning(id);
      await outcomes.transitionOutcome(exec, id, "waiting_user", {}, { now: T1, actor: ACTOR });

      await outcomes.transitionOutcome(exec, id, "blocked", {}, { now: T2, actor: ACTOR });

      const rows = await itemsFor(id);
      expect(rows).toHaveLength(2);
      const ready = rows.find((r) => r["kind"] === "outcome.ready")!;
      const blocked = rows.find((r) => r["kind"] === "outcome.blocked")!;
      expect(ready["state"]).toBe("resolved");
      expect(ready["resolved_by"]).toBe("producer");
      expect(ready["resolution_reason"]).toBe("outcome_blocked");
      expect(blocked["state"]).toBe("open");
      expect(blocked["fingerprint"]).toBe(`outcome:${id}:blocked`);
      expect(blocked["title"]).toBe("Chase the Acme quote — blocked");
      expect(blocked["why_it_matters"]).toBe("Delegated work is blocked and needs your attention.");

      // Unblock (blocked → running): the held blocked item resolves.
      await outcomes.transitionOutcome(exec, id, "running", {}, { now: T3, actor: ACTOR });
      const after = await itemsFor(id);
      expect(after.find((r) => r["kind"] === "outcome.blocked")!["state"]).toBe("resolved");
      expect(after.find((r) => r["kind"] === "outcome.blocked")!["resolution_reason"]).toBe("outcome_running");
    });

    it("failed opens its item and nothing ever auto-resolves it", async () => {
      const { id } = await seedOutcome();
      await toRunning(id);
      await outcomes.transitionOutcome(exec, id, "failed", {}, { now: T1, actor: ACTOR });

      const rows = await itemsFor(id);
      expect(rows).toHaveLength(1);
      const failed = rows[0]!;
      expect(failed["kind"]).toBe("outcome.failed");
      expect(failed["fingerprint"]).toBe(`outcome:${id}:failed`);
      expect(failed["state"]).toBe("open");
      expect(failed["title"]).toBe("Chase the Acme quote — failed");
      expect(failed["why_it_matters"]).toBe("Delegated work failed.");
      expect(failed["resolved_at"]).toBeNull();
      expect(failed["resolved_by"]).toBeNull(); // owner-ack only — no producer/liveness auto-resolve
    });

    it("completed and cancelled open NO item (ADR-0018 §1.2)", async () => {
      // completed: criteria must clear the completion gate first.
      const a = await seedOutcome("Complete me");
      await toRunning(a.id);
      await outcomes.setCriterionStatus(exec, a.id, 1, "waived_by_owner", { now: T2, actor: ACTOR });
      await outcomes.transitionOutcome(exec, a.id, "verifying", {}, { now: T2, actor: ACTOR });
      await outcomes.transitionOutcome(exec, a.id, "completed", {}, { now: T2, actor: ACTOR });
      expect(await itemsFor(a.id)).toHaveLength(0);

      const b = await seedOutcome("Cancel me");
      await toRunning(b.id);
      await outcomes.transitionOutcome(exec, b.id, "cancelled", {}, { now: T3, actor: ACTOR });
      expect(await itemsFor(b.id)).toHaveLength(0);
    });
  },
);
