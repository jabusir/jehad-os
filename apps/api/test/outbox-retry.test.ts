// Outbox retry/backoff (state-verifier defect S2) — integration suite on a
// per-file isolated database. Pins the full retry lifecycle: failed row
// becomes requeue-eligible only once its exponential backoff window has
// elapsed, exhaustion is permanent, replay safety holds across retries, and
// every boundary (first-backoff, doubling, cap, maxAttempts, limit) is exact.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { acceptEvent, validateEventIngest, type EventEnvelope } from "@jehad/core";
import {
  DEFAULT_OUTBOX_RETRY_POLICY,
  drainOutbox,
  exhaustedOutboxRows,
  outboxBackoffMs,
  requeueFailed,
} from "../src/outbox";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Fixed clock base; every boundary test derives `now` from this. */
const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (msAfterT0: number): Date => new Date(T0.getTime() + msAfterT0);

/** Tight policy: backoff 1s → 2s → 4s…, maxAttempts 3. */
const P_FAST = { maxAttempts: 3, backoffBaseMs: 1_000, backoffCapMs: 30_000 };
/** Cap-binding policy: 1s → 2s → 4s… capped at 3s, maxAttempts 10. */
const P_CAPPED = { maxAttempts: 10, backoffBaseMs: 1_000, backoffCapMs: 3_000 };
/** Exhaustion policy for the two-strikes test. */
const P_TWO = { maxAttempts: 2, backoffBaseMs: 1_000, backoffCapMs: 30_000 };

describe.skipIf(!TEST_DATABASE_URL)("outbox retry/backoff (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "apobxr");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  /**
   * Sweep after every test: any non-dispatched row becomes inert
   * (attempts 0 + far-future updated_at) so a test that fails mid-way
   * can't leak eligible/exhausted rows into later tests. Even when a test
   * fails, vitest still runs this hook — cleanup is guaranteed.
   */
  afterEach(async () => {
    await db.pool.query(
      "UPDATE outbox SET status = 'failed', attempts = 0, last_error = NULL, updated_at = '2099-01-01T00:00:00Z' WHERE status <> 'dispatched'",
    );
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

  /** Idempotent handler (plan §8): semantic effects keyed on envelope.id. */
  function idempotentHandler(failFor = new Set<string>()) {
    const calls: string[] = [];
    const effects: string[] = [];
    const applied = new Set<string>();
    const handler = async (envelope: EventEnvelope): Promise<void> => {
      calls.push(envelope.id);
      if (failFor.has(envelope.id)) {
        throw new Error("downstream unavailable");
      }
      if (!applied.has(envelope.id)) {
        applied.add(envelope.id);
        effects.push(envelope.id);
      }
    };
    return { handler, calls, effects, failFor };
  }

  async function outboxState(eventId: string) {
    const result = await db.pool.query<{
      status: string;
      attempts: number;
      last_error: string | null;
      dispatched_at: Date | null;
      updated_at: Date;
    }>(
      "SELECT status, attempts, last_error, dispatched_at, updated_at FROM outbox WHERE event_id = $1",
      [eventId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no outbox row for ${eventId}`);
    return row;
  }

  async function setRow(
    eventId: string,
    patch: { status?: string; attempts?: number; updatedAt?: Date },
  ): Promise<void> {
    await db.pool.query(
      `UPDATE outbox SET
         status = COALESCE($2, status),
         attempts = COALESCE($3, attempts),
         updated_at = COALESCE($4, updated_at)
       WHERE event_id = $1`,
      [eventId, patch.status ?? null, patch.attempts ?? null, patch.updatedAt?.toISOString() ?? null],
    );
  }

  it("backoff formula: base × 2^(attempts-1), capped (pure function)", () => {
    expect(outboxBackoffMs(1)).toBe(30_000);
    expect(outboxBackoffMs(2)).toBe(60_000);
    expect(outboxBackoffMs(4)).toBe(240_000);
    // 30s × 2^6 = 32min > 15min cap
    expect(outboxBackoffMs(7)).toBe(900_000);
    expect(outboxBackoffMs(20)).toBe(900_000);
    expect(DEFAULT_OUTBOX_RETRY_POLICY.maxAttempts).toBe(5);
  });

  it("fail → too early → 0 requeued; exact backoff boundary → requeued → drain succeeds", async () => {
    const event = await acceptCapture("retry lifecycle");
    const { handler, calls, effects, failFor } = idempotentHandler(new Set([/* set below */]));

    failFor.add(event.id);
    const failed = await drainOutbox(db.pool, handler);
    expect(failed).toEqual({ requeued: 0, claimed: 1, dispatched: 0, failed: 1 });
    let state = await outboxState(event.id);
    expect(state.status).toBe("failed");
    expect(state.attempts).toBe(1);
    expect(state.last_error).toBe("downstream unavailable");

    await setRow(event.id, { updatedAt: T0 });

    // 1ms before the window closes: nothing moves.
    const early = await requeueFailed(db.pool, { policy: P_FAST, now: at(999) });
    expect(early.requeued).toBe(0);
    state = await outboxState(event.id);
    expect(state.status).toBe("failed");
    expect(state.last_error).toBe("downstream unavailable"); // forensics intact

    // Exactly at the boundary (elapsed >= backoff): eligible.
    const onTime = await requeueFailed(db.pool, { policy: P_FAST, now: at(1_000) });
    expect(onTime.requeued).toBe(1);
    state = await outboxState(event.id);
    expect(state.status).toBe("pending");
    expect(state.last_error).toBe("downstream unavailable"); // retained on retry

    failFor.clear();
    const retried = await drainOutbox(db.pool, handler, { requeue: true, retryPolicy: P_FAST, now: at(60_000) });
    expect(retried).toEqual({ requeued: 0, claimed: 1, dispatched: 1, failed: 0 });
    state = await outboxState(event.id);
    expect(state.status).toBe("dispatched");
    expect(state.attempts).toBe(2);
    expect(state.dispatched_at).not.toBeNull();
    expect(state.last_error).toBeNull(); // success clears the stale error

    // At-least-once across retries: delivered twice, one semantic effect.
    expect(calls).toEqual([event.id, event.id]);
    expect(effects).toEqual([event.id]);
  });

  it("second failure doubles the backoff window", async () => {
    const event = await acceptCapture("fail twice");
    const { handler } = idempotentHandler(new Set([event.id]));

    await drainOutbox(db.pool, handler);
    expect((await outboxState(event.id)).attempts).toBe(1);

    await setRow(event.id, { updatedAt: T0 });
    const first = await requeueFailed(db.pool, { policy: P_FAST, now: at(1_000) });
    expect(first.requeued).toBe(1);
    await drainOutbox(db.pool, handler);
    expect((await outboxState(event.id)).attempts).toBe(2);

    await setRow(event.id, { updatedAt: at(10_000) });
    // attempts=2 → backoff 2s: 1.999s elapsed is too early.
    const early = await requeueFailed(db.pool, { policy: P_FAST, now: at(11_999) });
    expect(early.requeued).toBe(0);
    const onTime = await requeueFailed(db.pool, { policy: P_FAST, now: at(12_000) });
    expect(onTime.requeued).toBe(1);
    expect((await outboxState(event.id)).status).toBe("pending");

  });

  it("drainOutbox({requeue:true}) requeues and dispatches in one pass", async () => {
    const event = await acceptCapture("combined pass");
    const { handler, failFor } = idempotentHandler(new Set([event.id]));

    await drainOutbox(db.pool, handler);
    await setRow(event.id, { updatedAt: T0 });
    failFor.clear();

    const result = await drainOutbox(db.pool, handler, {
      requeue: true,
      retryPolicy: P_FAST,
      now: at(120_000),
    });
    expect(result).toEqual({ requeued: 1, claimed: 1, dispatched: 1, failed: 0 });
    const state = await outboxState(event.id);
    expect(state.status).toBe("dispatched");
    expect(state.attempts).toBe(2);
  });

  it("exhausted rows stay failed forever and surface in exhaustedOutboxRows", async () => {
    const older = await acceptCapture("exhausted older");
    const newer = await acceptCapture("exhausted newer");
    const { handler } = idempotentHandler(new Set([older.id, newer.id]));

    await drainOutbox(db.pool, handler); // attempt 1 → failed
    await setRow(older.id, { updatedAt: T0 });
    await setRow(newer.id, { updatedAt: T0 });
    await requeueFailed(db.pool, { policy: P_TWO, now: at(60_000) });
    await drainOutbox(db.pool, handler); // attempt 2 → failed (exhausted)
    for (const id of [older.id, newer.id]) {
      const state = await outboxState(id);
      expect(state.status).toBe("failed");
      expect(state.attempts).toBe(2);
      expect(state.last_error).toBe("downstream unavailable");
    }

    // Even infinitely far in the future: maxAttempts reached → never requeued.
    await setRow(older.id, { updatedAt: T0 });
    await setRow(newer.id, { updatedAt: T0 });
    const never = await requeueFailed(db.pool, {
      policy: P_TWO,
      now: at(365 * 24 * 3600 * 1000),
    });
    expect(never.requeued).toBe(0);

    // Alerting helper: oldest-first, limit-exact, attempts/last_error intact.
    await setRow(older.id, { updatedAt: at(2_000) });
    await setRow(newer.id, { updatedAt: at(1_000) });
    const exhausted = await exhaustedOutboxRows(db.pool, { policy: P_TWO });
    expect(exhausted.map((row) => row.eventId)).toEqual([newer.id, older.id]);
    expect(exhausted[0]).toMatchObject({
      attempts: 2,
      lastError: "downstream unavailable",
    });
    expect(exhausted[0].updatedAt).toEqual(at(1_000));

    const limited = await exhaustedOutboxRows(db.pool, { policy: P_TWO, limit: 1 });
    expect(limited.map((row) => row.eventId)).toEqual([newer.id]);

    // "Exhausted" is policy-relative: 2 attempts < default maxAttempts 5.
    const byDefault = await exhaustedOutboxRows(db.pool, { limit: 1000 });
    expect(byDefault.map((row) => row.eventId)).not.toContain(older.id);
    expect(byDefault.map((row) => row.eventId)).not.toContain(newer.id);

  });

  it("backoff cap binds exactly", async () => {
    const event = await acceptCapture("capped backoff");
    // attempts=3 → raw 1s × 2^2 = 4s, capped at 3s.
    await setRow(event.id, { status: "failed", attempts: 3, updatedAt: T0 });

    const early = await requeueFailed(db.pool, { policy: P_CAPPED, now: at(2_999) });
    expect(early.requeued).toBe(0);
    const onTime = await requeueFailed(db.pool, { policy: P_CAPPED, now: at(3_000) });
    expect(onTime.requeued).toBe(1);
    expect((await outboxState(event.id)).status).toBe("pending");

  });

  it("default policy boundaries are exact (30s first, 240s at attempts=4)", async () => {
    const first = await acceptCapture("default backoff first");
    await setRow(first.id, { status: "failed", attempts: 1, updatedAt: T0 });
    expect((await requeueFailed(db.pool, { now: at(29_999) })).requeued).toBe(0);
    expect((await requeueFailed(db.pool, { now: at(30_000) })).requeued).toBe(1);

    const fourth = await acceptCapture("default backoff fourth");
    // 30s × 2^3 = 240s (still under the 15min cap).
    await setRow(fourth.id, { status: "failed", attempts: 4, updatedAt: T0 });
    expect((await requeueFailed(db.pool, { now: at(239_999) })).requeued).toBe(0);
    expect((await requeueFailed(db.pool, { now: at(240_000) })).requeued).toBe(1);
  });

  it("requeue touches only failed rows — dispatched and pending are untouched", async () => {
    const dispatched = await acceptCapture("already out");
    const { handler } = idempotentHandler();
    await drainOutbox(db.pool, handler);
    expect((await outboxState(dispatched.id)).status).toBe("dispatched");

    const pending = await acceptCapture("never drained");
    const failed = await acceptCapture("failed and stale");
    await setRow(failed.id, { status: "failed", attempts: 1, updatedAt: at(0) });

    const result = await requeueFailed(db.pool, { now: at(10 * 60_000) });
    expect(result.requeued).toBe(1); // only `failed`
    expect((await outboxState(dispatched.id)).status).toBe("dispatched");
    const pendingState = await outboxState(pending.id);
    expect(pendingState.status).toBe("pending");
    expect(pendingState.attempts).toBe(0);
    expect((await outboxState(failed.id)).status).toBe("pending");

    await drainOutbox(db.pool, handler); // clean the pending rows
  });
});
