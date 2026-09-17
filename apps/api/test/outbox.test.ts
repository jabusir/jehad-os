// Outbox dispatcher — integration suite against a per-file isolated database.
// Covers plan §15 M2 acceptance: "replay of outbox is safe" — dispatch is
// at-least-once, the dispatcher marks dispatched_at, re-claim is safe, and
// handlers being idempotent yields no duplicate semantic effects.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { acceptEvent, validateEventIngest, type EventEnvelope } from "@jehad/core";
import { drainOutbox } from "../src/outbox";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("outbox dispatcher (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "apiobx");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function acceptCapture(text: string): Promise<EventEnvelope> {
    const validated = validateEventIngest({
      type: "capture.recorded",
      schemaVersion: 1,
      source: "cli.capture",
      externalId: randomUUID(),
      occurredAt: new Date().toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      payload: { text },
    });
    if (!validated.ok) throw new Error("invalid fixture");
    const result = await acceptEvent(db.pool, validated.value);
    expect(result.accepted).toBe(true);
    return result.envelope;
  }

  /** Idempotent handler, as every outbox consumer must be (plan §8). */
  function idempotentHandler() {
    const calls: string[] = [];
    const effects: string[] = [];
    const applied = new Set<string>();
    const handler = async (envelope: EventEnvelope): Promise<void> => {
      calls.push(envelope.id);
      if (!applied.has(envelope.id)) {
        applied.add(envelope.id);
        effects.push(envelope.id);
      }
    };
    return { handler, calls, effects };
  }

  async function outboxState(eventId: string) {
    const result = await db.pool.query<{
      status: string;
      attempts: number;
      dispatched_at: Date | null;
      last_error: string | null;
    }>("SELECT status, attempts, dispatched_at, last_error FROM outbox WHERE event_id = $1", [eventId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no outbox row for ${eventId}`);
    return row;
  }

  async function resetToPending(eventId: string): Promise<void> {
    await db.pool.query("UPDATE outbox SET status = 'pending', dispatched_at = NULL WHERE event_id = $1", [
      eventId,
    ]);
  }

  it("claims pending, dispatches, and marks dispatched_at", async () => {
    const a = await acceptCapture("dispatch me");
    const b = await acceptCapture("and me");
    const { handler } = idempotentHandler();

    const result = await drainOutbox(db.pool, handler);
    expect(result.claimed).toBeGreaterThanOrEqual(2);
    expect(result.dispatched).toBe(result.claimed);
    expect(result.failed).toBe(0);

    for (const envelope of [a, b]) {
      const state = await outboxState(envelope.id);
      expect(state.status).toBe("dispatched");
      expect(state.dispatched_at).not.toBeNull();
      expect(state.attempts).toBe(1);
    }
  });

  it("drains nothing once everything is dispatched", async () => {
    const { handler } = idempotentHandler();
    const result = await drainOutbox(db.pool, handler);
    expect(result).toEqual({ requeued: 0, claimed: 0, dispatched: 0, failed: 0 });
  });

  it("replay: re-dispatching is safe — handler re-runs, semantic effects stay single", async () => {
    const event = await acceptCapture("replay candidate");
    const { handler, calls, effects } = idempotentHandler();

    const first = await drainOutbox(db.pool, handler);
    expect(first.dispatched).toBe(1);
    expect(calls).toEqual([event.id]);
    expect(effects).toEqual([event.id]);
    expect((await outboxState(event.id)).status).toBe("dispatched");

    // Replay: the row returns to pending (operator reset, crashed dispatcher,
    // or at-least-once overlap) and is dispatched AGAIN.
    await resetToPending(event.id);
    const second = await drainOutbox(db.pool, handler);
    expect(second).toEqual({ requeued: 0, claimed: 1, dispatched: 1, failed: 0 });

    expect(calls).toEqual([event.id, event.id]); // delivered twice…
    expect(effects).toEqual([event.id]); // …but exactly one semantic effect
    const state = await outboxState(event.id);
    expect(state.status).toBe("dispatched");
    expect(state.attempts).toBe(2);
  });

  it("records handler failure as status=failed with last_error, then retries successfully", async () => {
    const event = await acceptCapture("fail once");
    let failNext = true;
    const { effects } = idempotentHandler();
    const flakyHandler = async (envelope: EventEnvelope): Promise<void> => {
      if (failNext) {
        failNext = false;
        throw new Error("downstream unavailable");
      }
      if (!effects.includes(envelope.id)) effects.push(envelope.id);
    };

    const failed = await drainOutbox(db.pool, flakyHandler);
    expect(failed).toEqual({ requeued: 0, claimed: 1, dispatched: 0, failed: 1 });
    const state = await outboxState(event.id);
    expect(state.status).toBe("failed");
    expect(state.last_error).toBe("downstream unavailable");
    expect(state.dispatched_at).toBeNull();

    await resetToPending(event.id);
    const retried = await drainOutbox(db.pool, flakyHandler);
    expect(retried).toEqual({ requeued: 0, claimed: 1, dispatched: 1, failed: 0 });
    const afterRetry = await outboxState(event.id);
    expect(afterRetry.status).toBe("dispatched");
    expect(afterRetry.last_error).toBeNull(); // R6: success clears the stale error
    expect(effects).toEqual([event.id]);
  });

  it("R6 regression: last_error is control-stripped and capped at 500 chars", async () => {
    const event = await acceptCapture("sanitize me");
    const hostile = async (): Promise<void> => {
      throw new Error(
        `payload=SECRET\u0000\u0007\r\n inject ${"x".repeat(600)}`,
      );
    };
    const result = await drainOutbox(db.pool, hostile);
    expect(result.failed).toBe(1);

    const state = await outboxState(event.id);
    expect(state.last_error).not.toBeNull();
    expect(state.last_error!.length).toBe(500);
    // Control chars (NUL, BEL, CR, LF, tab…) must never reach the column.
    expect(state.last_error).toMatch(/^[\u0020-\u007e]*$/);
    // The cap keeps the leading diagnostic and drops the flood.
    expect(state.last_error!.startsWith("payload=")).toBe(true);
  });

  it("respects the claim limit", async () => {
    await acceptCapture("limit one");
    await acceptCapture("limit two");
    const { handler } = idempotentHandler();
    const result = await drainOutbox(db.pool, handler, { limit: 1 });
    expect(result.claimed).toBe(1);
    expect(result.dispatched).toBe(1);
    // Drain the rest so later assertions start clean.
    await drainOutbox(db.pool, handler);
  });
});
