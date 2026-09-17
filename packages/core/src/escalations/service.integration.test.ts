// Escalation service integration tests (M6C): raise/resolve round-trip,
// six-reason enum enforcement, human_waits intervals, escalation events with
// provenance. Needs PostgreSQL 16; skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  EscalationNotFoundError,
  EscalationInputError,
  InvalidEscalationReasonError,
  InvalidEscalationStatusError,
  raiseEscalation,
  resolveEscalation,
} from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("escalation service (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m6esc");
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

  it("raises: pending row + open human_wait + escalation.raised event with provenance", async () => {
    const runId = await createRun();
    const otherRunId = await createRun();
    const raised = await raiseEscalation(db.pool, {
      runId,
      reason: "ambiguous_requirements",
      urgency: "high",
      consequenceOfWaiting: "deploy stays blocked",
      estHumanMinutes: 15,
      blockedRunIds: [otherRunId],
    });

    expect(raised.escalation).toMatchObject({
      runId,
      reason: "ambiguous_requirements",
      urgency: "high",
      consequenceOfWaiting: "deploy stays blocked",
      estHumanMinutes: 15,
      blockedRunIds: [otherRunId],
      status: "pending",
    });

    const row = (
      await db.pool.query("SELECT * FROM escalations WHERE id = $1::uuid", [raised.escalation.id])
    ).rows[0];
    expect(row.status).toBe("pending");

    // human_waits interval opened for the run, still open.
    const wait = (
      await db.pool.query(
        "SELECT * FROM human_waits WHERE escalation_id = $1::uuid",
        [raised.escalation.id],
      )
    ).rows[0];
    expect(wait).toMatchObject({ run_id: runId, reason: "ambiguous_requirements", resolved_at: null });

    // Event log: internal source, run linked, full raise context as payload.
    const event = (
      await db.pool.query("SELECT * FROM events WHERE id = $1::uuid", [raised.eventId])
    ).rows[0];
    expect(event).toMatchObject({
      type: "escalation.raised",
      source: "internal",
      run_id: runId,
    });
    expect(event.payload).toMatchObject({
      escalationId: raised.escalation.id,
      runId,
      reason: "ambiguous_requirements",
      urgency: "high",
      consequenceOfWaiting: "deploy stays blocked",
      estHumanMinutes: 15,
      blockedRunIds: [otherRunId],
    });
  });

  it("rejects a reason outside the six-cause enum (and writes nothing)", async () => {
    const runId = await createRun();
    await expect(
      raiseEscalation(db.pool, { runId, reason: "boredom" as never }),
    ).rejects.toBeInstanceOf(InvalidEscalationReasonError);
    const count = await db.pool.query(
      "SELECT count(*)::int AS n FROM escalations WHERE run_id = $1::uuid",
      [runId],
    );
    expect(count.rows[0].n).toBe(0);
  });

  it("rejects malformed raise input (bad runId, bad estHumanMinutes, bad blockedRunIds)", async () => {
    await expect(
      raiseEscalation(db.pool, { runId: "not-a-uuid", reason: "system_failure" }),
    ).rejects.toBeInstanceOf(EscalationInputError);
    await expect(
      raiseEscalation(db.pool, {
        runId: randomUUID(),
        reason: "system_failure",
        estHumanMinutes: 2.5,
      }),
    ).rejects.toBeInstanceOf(EscalationInputError);
    await expect(
      raiseEscalation(db.pool, {
        runId: randomUUID(),
        reason: "system_failure",
        blockedRunIds: ["nope"],
      }),
    ).rejects.toBeInstanceOf(EscalationInputError);
  });

  it("resolves: status resolved + escalation.resolved event + open human_waits closed", async () => {
    const runId = await createRun();
    const raised = await raiseEscalation(db.pool, {
      runId,
      reason: "approval_required",
      urgency: "blocker",
    });

    const resolved = await resolveEscalation(db.pool, raised.escalation.id, {
      resolution: "approved the deploy manually",
    });
    expect(resolved.escalation).toMatchObject({ id: raised.escalation.id, status: "resolved" });
    expect(resolved.closedHumanWaits).toBe(1);

    const row = (
      await db.pool.query("SELECT status FROM escalations WHERE id = $1::uuid", [raised.escalation.id])
    ).rows[0];
    expect(row.status).toBe("resolved");

    const wait = (
      await db.pool.query(
        "SELECT resolved_at FROM human_waits WHERE escalation_id = $1::uuid",
        [raised.escalation.id],
      )
    ).rows[0];
    expect(wait.resolved_at).not.toBeNull();

    const event = (
      await db.pool.query("SELECT * FROM events WHERE id = $1::uuid", [resolved.eventId])
    ).rows[0];
    expect(event).toMatchObject({
      type: "escalation.resolved",
      source: "internal",
      run_id: runId,
    });
    expect(event.payload).toMatchObject({
      escalationId: raised.escalation.id,
      runId,
      resolution: "approved the deploy manually",
    });

    // Idempotent event identity: resolving is once-only.
    await expect(
      resolveEscalation(db.pool, raised.escalation.id, { resolution: "again" }),
    ).rejects.toBeInstanceOf(InvalidEscalationStatusError);
  });

  it("resolve closes every open human_waits row for the linked run", async () => {
    const runId = await createRun();
    // A pre-existing open wait on the run, opened outside any escalation.
    await db.pool.query(
      `INSERT INTO human_waits (run_id, started_at, reason) VALUES ($1::uuid, now(), 'manual hold')`,
      [runId],
    );
    const raised = await raiseEscalation(db.pool, { runId, reason: "missing_credentials" });
    const resolved = await resolveEscalation(db.pool, raised.escalation.id, {
      resolution: "rotated the credential",
    });
    expect(resolved.closedHumanWaits).toBe(2);
    const open = await db.pool.query(
      "SELECT count(*)::int AS n FROM human_waits WHERE run_id = $1::uuid AND resolved_at IS NULL",
      [runId],
    );
    expect(open.rows[0].n).toBe(0);
  });

  it("resolve rejects unknown ids, malformed ids, and empty resolutions", async () => {
    const missing = randomUUID();
    await expect(resolveEscalation(db.pool, missing, { resolution: "x" })).rejects.toBeInstanceOf(
      EscalationNotFoundError,
    );
    await expect(
      resolveEscalation(db.pool, "not-a-uuid", { resolution: "x" }),
    ).rejects.toBeInstanceOf(EscalationNotFoundError);
    const runId = await createRun();
    const raised = await raiseEscalation(db.pool, { runId, reason: "system_failure" });
    await expect(
      resolveEscalation(db.pool, raised.escalation.id, { resolution: "   " }),
    ).rejects.toBeInstanceOf(EscalationInputError);
  });

  it("raise rejects an unknown run (FK guarded before any write)", async () => {
    await expect(
      raiseEscalation(db.pool, { runId: randomUUID(), reason: "system_failure" }),
    ).rejects.toThrow(/does not exist/);
  });
});
