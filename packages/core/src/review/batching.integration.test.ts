// Review batching integration tests (M6C): the raise→list→batch→approve/
// reject→resolve round-trip against isolated Postgres. Batching is the
// attention-conservation rule (plan §13): bounded sessions, urgency-sorted.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { acceptEvent } from "../events/store.js";
import { raiseEscalation, resolveEscalation } from "../escalations/service.js";
import { promoteCandidate } from "../promotion/pipeline.js";
import { approvePromotion, listReviewQueue, rejectPromotion } from "./review-queue.js";
import { batchPendingReview, listBatch } from "./batching.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("review batching (integration)", () => {
  let db: IsolatedDb;

  const registry = new ModelEgressPolicyRegistry([
    {
      id: "personal-normal",
      domainId: "personal",
      sensitivity: "normal",
      allowedProviders: ["openrouter"],
      allowRemote: false,
      requireRedaction: false,
    },
  ]);

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m6batch");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  let runCounter = 0;

  async function createRun(): Promise<string> {
    runCounter += 1;
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    const run = await db.pool.query(
      `INSERT INTO runs (kind, principal_id, status, domain_id)
       SELECT 'workflow', $1, $2, d.id FROM domains d WHERE d.key = 'personal'
       RETURNING id`,
      [principal.rows[0].id, `blocked-${runCounter}`],
    );
    return String(run.rows[0].id);
  }

  async function queueSemanticCandidate(statement: string): Promise<string> {
    const accepted = await acceptEvent(db.pool, {
      type: "capture.recorded",
      schemaVersion: 1,
      source: "cli.capture",
      externalId: `batch-test-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      payload: { statement },
      runId: null,
    });
    const inserted = await db.pool.query(
      `INSERT INTO memory_candidates (domain_id, proposed_class, assertion_kind, payload, provenance)
       SELECT d.id, 'semantic', 'model_inferred', $1::jsonb, $2::jsonb
       FROM domains d WHERE d.key = 'personal'
       RETURNING id`,
      [
        JSON.stringify({ statement, confidence: 0.9 }),
        JSON.stringify({
          sourceEventId: accepted.envelope.id,
          runId: null,
          model: "test-model",
          promptVersion: "p1",
        }),
      ],
    );
    const id = String(inserted.rows[0].id);
    const outcome = await promoteCandidate(db.pool, id, { egressRegistry: registry });
    expect(outcome.action).toBe("in_review");
    return id;
  }

  it("raise → list → batch → approve/reject → resolve round-trip", async () => {
    const runId = await createRun();
    const candidateA = await queueSemanticCandidate("Jehad prefers morning deep work");
    const candidateB = await queueSemanticCandidate("Jehad favors vim keybindings");

    const raised = await raiseEscalation(db.pool, {
      runId,
      reason: "approval_required",
      urgency: "high",
      estHumanMinutes: 10,
    });

    // List: the queue carries both lanes in one attention pass.
    const queue = await listReviewQueue(db.pool);
    expect(queue.promotions.map((p) => p.id)).toContain(candidateA);
    expect(queue.promotions.map((p) => p.id)).toContain(candidateB);
    expect(queue.escalations.map((e) => e.id)).toContain(raised.escalation.id);

    // Batch: one bounded review session.
    const batch = await batchPendingReview(db.pool, { maxBatch: 10 });
    expect(batch.escalations.map((e) => e.id)).toContain(raised.escalation.id);
    expect(batch.candidates.map((c) => c.id).sort()).toEqual([candidateA, candidateB].sort());
    const listed = await listBatch(db.pool);
    expect(listed.escalations.map((e) => e.id)).toContain(raised.escalation.id);
    expect(listed.candidates).toHaveLength(2);

    // Complete the session: approve one, reject one, resolve the escalation.
    const approved = await approvePromotion(db.pool, candidateA, {
      egressRegistry: registry,
      approvedBy: "jehad",
    });
    expect(approved.action).toBe("promoted");
    const rejected = await rejectPromotion(db.pool, candidateB, { rejectedBy: "jehad" });
    expect(rejected.status).toBe("rejected");
    const resolved = await resolveEscalation(db.pool, raised.escalation.id, {
      resolution: "approved the plan",
    });
    expect(resolved.escalation.status).toBe("resolved");
    expect(resolved.closedHumanWaits).toBe(1);

    // Session drains.
    const drained = await listBatch(db.pool);
    expect(drained.escalations).toHaveLength(0);
    expect(drained.candidates).toHaveLength(0);
    const queueAfter = await listReviewQueue(db.pool);
    expect(queueAfter.promotions).toHaveLength(0);
    expect(queueAfter.escalations).toHaveLength(0);

    // Provenance landed: raised + resolved events for the escalation.
    const events = await db.pool.query(
      "SELECT type, source, run_id FROM events WHERE run_id = $1::uuid ORDER BY type",
      [runId],
    );
    const types = events.rows.map((r) => String(r.type));
    expect(types).toContain("escalation.raised");
    expect(types).toContain("escalation.resolved");
    for (const row of events.rows) expect(row.source).toBe("internal");
  });

  it("batching respects maxBatch and urgency ordering (urgency desc, est_human_minutes asc)", async () => {
    const low = await raiseEscalation(db.pool, {
      runId: await createRun(),
      reason: "missing_external_information",
      urgency: "low",
      estHumanMinutes: 5,
    });
    const highSlow = await raiseEscalation(db.pool, {
      runId: await createRun(),
      reason: "architecture_decision",
      urgency: "high",
      estHumanMinutes: 60,
    });
    const highQuick = await raiseEscalation(db.pool, {
      runId: await createRun(),
      reason: "ambiguous_requirements",
      urgency: "high",
      estHumanMinutes: 10,
    });
    const blocker = await raiseEscalation(db.pool, {
      runId: await createRun(),
      reason: "system_failure",
      urgency: "blocker",
      estHumanMinutes: 30,
    });
    const unranked = await raiseEscalation(db.pool, {
      runId: await createRun(),
      reason: "missing_credentials",
    });

    // maxBatch: only the two most urgent join this session.
    const batch = await batchPendingReview(db.pool, { maxBatch: 2 });
    expect(batch.escalations.map((e) => e.id)).toEqual([
      blocker.escalation.id,
      highQuick.escalation.id, // same-rank tie broken by est_human_minutes asc
    ]);

    // The rest stay pending; the batch listing shows exactly what was batched.
    const statuses = await db.pool.query(
      "SELECT status, count(*)::int AS n FROM escalations GROUP BY status",
    );
    const byStatus = new Map(statuses.rows.map((r) => [String(r.status), Number(r.n)]));
    expect(byStatus.get("batched")).toBe(2);
    expect(byStatus.get("pending")).toBe(3);
    const listed = await listBatch(db.pool);
    expect(listed.escalations.map((e) => e.id)).toEqual([
      blocker.escalation.id,
      highQuick.escalation.id,
    ]);

    // Next session pulls the remainder in order; unknown urgency ranks last.
    const next = await batchPendingReview(db.pool, { maxBatch: 10 });
    expect(next.escalations.map((e) => e.id)).toEqual([
      highSlow.escalation.id,
      low.escalation.id,
      unranked.escalation.id,
    ]);
    const all = await listBatch(db.pool);
    expect(all.escalations).toHaveLength(5);
  });

  it("batching again with nothing pending yields an empty escalation lane", async () => {
    const before = await batchPendingReview(db.pool);
    expect(before.escalations).toHaveLength(0);
    expect(before.candidates).toHaveLength(0);
  });
});
