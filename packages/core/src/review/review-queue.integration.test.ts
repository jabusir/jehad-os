// Review queue service integration tests (M5C): pending promotions +
// escalations listing, batch approve (completes the promotion), reject
// (discards). Needs PostgreSQL 16; skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { acceptEvent } from "../events/store.js";
import { promoteCandidate } from "../promotion/pipeline.js";
import { approvePromotions, listReviewQueue, rejectPromotion } from "./review-queue.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("review queue service (integration)", () => {
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
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m5creview");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function queueSemanticCandidate(statement: string): Promise<string> {
    const accepted = await acceptEvent(db.pool, {
      type: "capture.recorded",
      schemaVersion: 1,
      source: "cli.capture",
      externalId: `review-test-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      payload: { statement },
      runId: null,
    });
    const inserted = await db.pool.query(
      // The table has no confidence column (data-model §5.9): the seam
      // contract's confidence serializes as payload.confidence.
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

  it("lists pending promotions and escalations together; approve completes, reject discards", async () => {
    const first = await queueSemanticCandidate("Jehad works best in the morning");
    const second = await queueSemanticCandidate("Jehad prefers dark IDE themes");

    // An escalation rides alongside the queue (runs need a principal).
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    const run = await db.pool.query(
      `INSERT INTO runs (kind, principal_id, status, domain_id)
       SELECT 'workflow', $1, 'blocked', d.id FROM domains d WHERE d.key = 'personal'
       RETURNING id`,
      [principal.rows[0].id],
    );
    const escalation = await db.pool.query(
      `INSERT INTO escalations (run_id, reason, urgency, consequence_of_waiting, est_human_minutes)
       VALUES ($1::uuid, 'ambiguous_requirements', 'high', 'blocked deploy', 10)
       RETURNING id`,
      [run.rows[0].id],
    );
    const escalationId = String(escalation.rows[0].id);

    const queue = await listReviewQueue(db.pool);
    expect(queue.promotions.map((p) => p.id)).toEqual([first, second]);
    expect(queue.promotions[0]).toMatchObject({
      domainKey: "personal",
      proposedClass: "semantic",
      assertionKind: "model_inferred",
      confidence: 0.9,
    });
    expect(queue.escalations).toHaveLength(1);
    expect(queue.escalations[0]).toMatchObject({
      id: escalationId,
      reason: "ambiguous_requirements",
      urgency: "high",
      status: "pending",
    });

    // Reject the first: discarded, nothing canonical, reviewer recorded.
    const rejection = await rejectPromotion(db.pool, first, {
      rejectedBy: "jehad",
      note: "stale observation",
    });
    expect(rejection).toMatchObject({ candidateId: first, status: "rejected" });
    const rejectedRow = (
      await db.pool.query("SELECT status, gate_result FROM memory_candidates WHERE id = $1::uuid", [first])
    ).rows[0];
    expect(rejectedRow.status).toBe("rejected");
    expect((rejectedRow.gate_result as Record<string, unknown>).review).toMatchObject({
      rejectedBy: "jehad",
      note: "stale observation",
    });
    const rejectedClaims = await db.pool.query(
      "SELECT count(*)::int AS n FROM evidence WHERE metadata->>'candidateId' = $1",
      [first],
    );
    expect(rejectedClaims.rows[0].n).toBe(0);

    // Batch approve the second: completes the promotion + canonical write.
    const outcomes = await approvePromotions(db.pool, [second], {
      egressRegistry: registry,
      approvedBy: "jehad",
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ candidateId: second, action: "promoted" });
    const claim = (
      await db.pool.query("SELECT * FROM evidence WHERE metadata->>'candidateId' = $1", [second])
    ).rows[0];
    expect(claim.claim).toBe("Jehad prefers dark IDE themes");
    expect((claim.metadata as Record<string, unknown>).verified).toBe(false);
    const event = (
      await db.pool.query(
        `SELECT * FROM events WHERE type = 'memory.promoted' AND payload->>'candidateId' = $1`,
        [second],
      )
    ).rows[0];
    expect((event.payload as Record<string, unknown>).review).toMatchObject({ approvedBy: "jehad" });

    // Queue drains for promotions; escalations stay pending until their own
    // resolution path (workflow lane) acts.
    const drained = await listReviewQueue(db.pool);
    expect(drained.promotions).toHaveLength(0);
    expect(drained.escalations).toHaveLength(1);
  });

  it("rejecting a candidate that is not in_review throws", async () => {
    const queued = await queueSemanticCandidate("Jehad drinks too much coffee");
    await rejectPromotion(db.pool, queued, { rejectedBy: "jehad" });
    await expect(rejectPromotion(db.pool, queued, { rejectedBy: "jehad" })).rejects.toThrow(/not in_review/);
  });
});
