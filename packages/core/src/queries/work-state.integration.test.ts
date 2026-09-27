// Shell-trust R1 (docs/plans/shell-trust.md) — the canonical work-state
// projection: collectWorkState / collectWorkOutcomeDetail / the work.status
// read tool / renderWorkSnapshotText. Integration (isolated schema).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { collectWorkOutcomeDetail, collectWorkState, renderWorkSnapshotText } from "./work-state.js";
import { executeReadTool } from "../imessage/read-tools.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-26T18:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("work-state (shell-trust R1, integration)", () => {
  let db: IsolatedDb;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "workst");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const principal = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', 'josctl') RETURNING id",
    );
    principalId = String(principal.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    await db.pool.query("DELETE FROM assignments; DELETE FROM outcome_criteria; DELETE FROM outcomes;");
  });

  async function seedOutcome(input: {
    ref: string;
    title: string;
    status: string;
    deadlineDays?: number | null;
    waitingOn?: string | null;
  }): Promise<string> {
    const deadline =
      input.deadlineDays === undefined || input.deadlineDays === null
        ? null
        : new Date(NOW.getTime() + input.deadlineDays * 86_400_000).toISOString();
    const row = await db.pool.query(
      `INSERT INTO outcomes (id, principal_id, ref, title, directive, status, deadline_at, waiting_on, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'do the thing', $5, $6::timestamptz, $7::jsonb, $8::timestamptz)
       RETURNING id`,
      [
        randomUUID(),
        principalId,
        input.ref,
        input.title,
        input.status,
        deadline,
        input.waitingOn === null ? null : JSON.stringify(input.waitingOn),
        NOW.toISOString(),
      ],
    );
    return String(row.rows[0]!.id);
  }

  async function seedCriterion(outcomeId: string, ordinal: number, status: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO outcome_criteria (id, outcome_id, ordinal, criterion, status, verified_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz)`,
      [
        randomUUID(),
        outcomeId,
        ordinal,
        `criterion ${ordinal}`,
        status,
        status === "verified" ? NOW.toISOString() : null,
      ],
    );
  }

  async function seedAssignment(
    outcomeId: string,
    input: { role: string; status: string; artifactTitle?: string },
  ): Promise<void> {
    await db.pool.query(
      `INSERT INTO assignments (id, outcome_id, principal_id, role, status, input, budget_usd, result)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, '{}'::jsonb, 1,
               $6::jsonb)`,
      [
        randomUUID(),
        outcomeId,
        principalId,
        input.role,
        input.status,
        input.artifactTitle === undefined ? null : JSON.stringify({ artifact: { title: input.artifactTitle } }),
      ],
    );
  }

  it("empty state renders an EXPLICIT empty label — the verifier's ground truth for existence claims", async () => {
    const state = await collectWorkState(db.pool, { principalId, now: NOW });
    expect(state.activeTotal).toBe(0);
    expect(state.active).toEqual([]);
    expect(renderWorkSnapshotText(state)).toBe("NO DELEGATED WORK EXISTS (canonical work state is empty)");
  });

  it("active work renders with ref/title/status/deadline-as-reaper-bound/criteria/assignment", async () => {
    const outcomeId = await seedOutcome({
      ref: "AB2",
      title: "Which financial senders emailed me",
      status: "running",
      deadlineDays: 10,
    });
    await seedCriterion(outcomeId, 1, "verified");
    await seedCriterion(outcomeId, 2, "pending");
    await seedAssignment(outcomeId, { role: "research", status: "succeeded", artifactTitle: "Sender analysis" });

    const state = await collectWorkState(db.pool, { principalId, now: NOW });
    expect(state.activeTotal).toBe(1);
    expect(state.active[0]!.ref).toBe("AB2");
    expect(state.active[0]!.status).toBe("running");
    expect(state.active[0]!.criteriaVerified).toBe(1);
    expect(state.active[0]!.criteriaTotal).toBe(2);
    expect(state.active[0]!.latestAssignment!.status).toBe("succeeded");
    expect(state.active[0]!.latestAssignment!.artifactTitle).toBe("Sender analysis");
    const text = renderWorkSnapshotText(state);
    expect(text).toContain('[AB2] "Which financial senders emailed me" status=running');
    expect(text).toContain("reaper bound, not a promise");
    expect(text).toContain("criteria=1/2 verified");
    expect(text).toContain("artifact: Sender analysis");
  });

  it("principal-scoped: another principal's outcomes are invisible", async () => {
    const other = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', 'other-user') RETURNING id",
    );
    await db.pool.query(
      `INSERT INTO outcomes (id, principal_id, ref, title, directive, status)
       VALUES ($1::uuid, $2::uuid, 'ZZ9', 'their work', 'x', 'running')`,
      [randomUUID(), other.rows[0]!.id],
    );
    const state = await collectWorkState(db.pool, { principalId, now: NOW });
    expect(state.activeTotal).toBe(0);
  });

  it("completed-in-last-24h surfaces; older completions do not", async () => {
    const id = await seedOutcome({ ref: "CD5", title: "old done", status: "completed" });
    await db.pool.query(`UPDATE outcomes SET updated_at = $1::timestamptz WHERE id = $2::uuid`, [
      new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
      id,
    ]);
    await seedOutcome({ ref: "EF7", title: "fresh done", status: "completed" });
    const state = await collectWorkState(db.pool, { principalId, now: NOW });
    expect(state.completedLast24h.map((c) => c.ref)).toEqual(["EF7"]);
  });

  it("work.status read tool: list payload + coverage + ref drill-down + not-found-is-data", async () => {
    await seedOutcome({ ref: "AB2", title: "Research verticals", status: "accepted" });
    const list = await executeReadTool(
      db.pool,
      { tool: "work.status" },
      { principalId, now: () => NOW },
    );
    expect(list.tool).toBe("work.status");
    expect(list.source).toBe("work");
    expect(list.coverage).toContain("reaper bound");
    expect(list.coverage).toContain("not returned ≠ nonexistent");
    const data = list.data as { activeTotal: number; active: { ref: string }[] };
    expect(data.activeTotal).toBe(1);
    expect(data.active[0]!.ref).toBe("AB2");

    const detail = await executeReadTool(
      db.pool,
      { tool: "work.status", ref: "ab2" },
      { principalId, now: () => NOW },
    );
    const detailData = detail.data as { found: boolean; ref?: string };
    expect(detailData.found).toBe(true);
    expect(detailData.ref).toBe("AB2");

    const missing = await executeReadTool(
      db.pool,
      { tool: "work.status", ref: "QQ1" },
      { principalId, now: () => NOW },
    );
    expect((missing.data as { found: boolean }).found).toBe(false);
    expect(missing.coverage).toContain("no outcome with this ref");
  });

  it("collectWorkOutcomeDetail: criteria + assignments listed", async () => {
    const outcomeId = await seedOutcome({ ref: "GH3", title: "Probe", status: "verifying" });
    await seedCriterion(outcomeId, 1, "pending");
    await seedAssignment(outcomeId, { role: "research", status: "succeeded", artifactTitle: "A" });
    await seedAssignment(outcomeId, { role: "verifier", status: "queued" });
    const detail = await collectWorkOutcomeDetail(db.pool, { principalId, ref: "gh3", now: NOW });
    expect(detail.found).toBe(true);
    if (detail.found) {
      expect(detail.criteria).toHaveLength(1);
      expect(detail.assignments.map((a) => a.role)).toEqual(["research", "verifier"]);
    }
  });
});
