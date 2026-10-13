// W1.1 findings 2 + 4 — snooze lifecycle and the attention kill switch,
// against the real outcome→attention pipeline (isolated TEST_DATABASE_URL db).
//
// Snooze contract (ADR-0018 §1.2/plan §5.7, W1.1 finding 2):
//   - updated_at is the MUTATION time, never snoozed_until
//   - an expired snooze is needs-you again (Today) and delivery-eligible;
//     the liveness sweep formally wakes it (state → open)
//   - a genuinely CHANGED occurrence while snoozed wakes + delivers
//   - an unchanged occurrence while snoozed stays snoozed and deferred
// Kill-switch contract (W1.1 finding 4): attention.enabled=false stops
// production BEFORE any durable write; canonical outcomes flow unchanged;
// restore=true resumes.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../../packages/db/tests/test-db";
import { createOutcome, transitionOutcome } from "../outcomes/service.js";
import { snoozeAttention, listOpenAttention, livenessSweep, openOrBumpOrReopen } from "./service.js";
import { retryEligibleUndelivered } from "./delivery.js";
import { deliverOutcomeAttentionNow } from "./outcome-producer.js";
import type { AttentionPolicy } from "./policy.js";
import type { AttentionItemRow } from "./types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** 10:00 America/Los_Angeles — outside quiet hours. */
const T0 = new Date("2026-10-12T17:00:00.000Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const ENABLED: AttentionPolicy = { enabled: true, cooldownMinutes: 60 };
const DISABLED: AttentionPolicy = { enabled: false, cooldownMinutes: 60 };

describe.skipIf(!TEST_DATABASE_URL)("W1.1 snooze lifecycle + kill switch (integration)", () => {
  let db: IsolatedDb;
  let principalId: string;
  let exec: Pool;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w11snooze");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "w1.1-owner", credentialHash: sha256Hex("x"),
    });
    principalId = user.id;
    exec = db.pool;
  });

  afterAll(async () => { await dropIsolatedTestDb(TEST_DATABASE_URL!, db); });

  async function makeReady(directive: string): Promise<{ outcomeId: string; itemId: string }> {
    const created = await createOutcome(exec, {
      principalId,
      title: directive,
      directive: "W1.1 snooze-lifecycle acceptance",
      criteria: [{ criterion: "Owner judges success", verificationMethod: { kind: "owner_judgment" } }],
      createdBy: "josctl",
    }, { now: T0, actor: "w1.1" });
    await transitionOutcome(exec, created.outcome.id, "queued", {}, { now: at(1), actor: "w1.1", attentionPolicy: ENABLED });
    await transitionOutcome(exec, created.outcome.id, "running", {}, { now: at(2), actor: "w1.1", attentionPolicy: ENABLED });
    await transitionOutcome(exec, created.outcome.id, "waiting_user", {}, { now: at(3), actor: "w1.1", attentionPolicy: ENABLED });
    const item = await exec.query(
      "SELECT id FROM attention_items WHERE source_object_id = $1 ORDER BY first_raised_at LIMIT 1",
      [created.outcome.id],
    );
    return { outcomeId: created.outcome.id, itemId: String(item.rows[0]!.id) };
  }

  it("snooze stamps updated_at with the MUTATION time, never snoozed_until", async () => {
    const { itemId } = await makeReady("Snooze stamp probe");
    const before = await exec.query("SELECT updated_at FROM attention_items WHERE id = $1::uuid", [itemId]);
    const tMutation = at(10);
    const snoozed = await snoozeAttention(exec, principalId, itemId, 30, { now: tMutation, actor: "w1.1-owner" });
    expect(snoozed!.state).toBe("snoozed");
    expect(snoozed!.snoozedUntil!.getTime()).toBe(at(40).getTime());
    expect(snoozed!.updatedAt.getTime()).toBe(tMutation.getTime());
    expect(snoozed!.updatedAt.getTime()).not.toBe(snoozed!.snoozedUntil!.getTime());
    // and the DB row agrees with the mapped row
    const row = await exec.query("SELECT updated_at FROM attention_items WHERE id = $1::uuid", [itemId]);
    expect(new Date(String(row.rows[0]!.updated_at)).getTime()).toBe(tMutation.getTime());
    expect(before.rows.length).toBe(1);
  });

  it("an expired snooze is needs-you in Today before the sweep, and the sweep wakes it formally", async () => {
    const { itemId } = await makeReady("Expired snooze probe");
    await snoozeAttention(exec, principalId, itemId, 15, { now: at(10), actor: "w1.1-owner" }); // expires at(25)

    // before expiry: not in the default needs-you list
    const beforeExpiry = await listOpenAttention(exec, principalId, { now: at(20) });
    expect(beforeExpiry.find((i) => i.id === itemId)).toBeUndefined();

    // after expiry: needs-you again (even with the row still formally snoozed)
    const afterExpiry = await listOpenAttention(exec, principalId, { now: at(26) });
    expect(afterExpiry.find((i) => i.id === itemId)).toBeDefined();

    // the sweep formally wakes it: state open, snoozed_until cleared
    const sweep = await livenessSweep(exec, { now: at(27) });
    expect(sweep.woken ?? 0).toBeGreaterThanOrEqual(1);
    const row = await exec.query("SELECT state, snoozed_until FROM attention_items WHERE id = $1::uuid", [itemId]);
    expect(String(row.rows[0]!.state)).toBe("open");
    expect(row.rows[0]!.snoozed_until).toBeNull();
  });

  it("an expired snooze becomes delivery-eligible again (retry enqueues)", async () => {
    const { itemId } = await makeReady("Expired snooze delivery probe");
    await snoozeAttention(exec, principalId, itemId, 10, { now: at(10), actor: "w1.1-owner" }); // expires at(20)
    const config = {
      autoApproveKinds: ["attention"],
      escalationMinUrgency: "high",
      defaultTtlMinutes: 240,
    } as const;
    // while snoozed (and the original push still in flight): retry defers
    expect(await retryEligibleUndelivered(exec, { now: at(15), config })).toBe(0);
    // the original push dies unclaimed (TTL lapse), the snooze expires — the
    // item is needs-you with no live push: retry re-enqueues exactly once.
    await exec.query(
      "UPDATE notifications SET expires_at = $2::timestamptz WHERE kind = 'attention' AND source_id = $1",
      [itemId, at(12).toISOString()],
    );
    expect(await retryEligibleUndelivered(exec, { now: at(25), config })).toBe(1);
    expect(await retryEligibleUndelivered(exec, { now: at(26), config })).toBe(0); // now in-flight again
    const attempts = await exec.query("SELECT delivery_attempts FROM attention_items WHERE id = $1::uuid", [itemId]);
    expect(Number(attempts.rows[0]!.delivery_attempts)).toBeGreaterThanOrEqual(2); // initial + retry
  });

  it("a CHANGED occurrence while snoozed wakes the item and delivers; unchanged stays snoozed", async () => {
    const { outcomeId, itemId } = await makeReady("Snoozed-change probe");
    await snoozeAttention(exec, principalId, itemId, 60, { now: at(10), actor: "w1.1-owner" }); // until at(70)

    // unchanged fingerprint at at(20) (still within the snooze window): deferred, stays snoozed
    const unchanged = await openOrBumpOrReopen(exec, {
      principalId, sourceType: "outcome", sourceObjectId: outcomeId,
      fingerprint: `outcome:${outcomeId}:ready`, kind: "outcome.ready", level: "inbox",
      title: "Snoozed-change probe — ready for your judgment",
      summary: "W1.1 snooze-lifecycle acceptance",
      whyItMatters: "Delegated work needs your decision to continue.",
      evidenceRefs: [{ type: "outcome", id: "SNZ" }],
      actions: [{ key: "attention.resolve" }],
      changeFingerprint: `${outcomeId}:waiting_user:${at(3).toISOString()}`, // identical to stored
    }, { now: at(20), actor: "probe" });
    expect(unchanged.action).toBe("bumped");
    expect(unchanged.deliverNow).toBe(false);
    expect(unchanged.item.state).toBe("snoozed");

    // genuinely NEW occurrence at at(30): wakes + delivers (past-snooze gate bypassed by the wake)
    const changed = await openOrBumpOrReopen(exec, {
      principalId, sourceType: "outcome", sourceObjectId: outcomeId,
      fingerprint: `outcome:${outcomeId}:ready`, kind: "outcome.ready", level: "inbox",
      title: "Snoozed-change probe — ready for your judgment",
      summary: "W1.1 snooze-lifecycle acceptance",
      whyItMatters: "Delegated work needs your decision to continue.",
      evidenceRefs: [{ type: "outcome", id: "SNZ" }],
      actions: [{ key: "attention.resolve" }],
      changeFingerprint: `${outcomeId}:waiting_user:${at(30).toISOString()}`, // differs
    }, { now: at(30), actor: "probe" });
    expect(changed.action).toBe("bumped");
    expect(changed.deliverNow).toBe(true);
    expect(changed.item.state).toBe("open");
    expect(changed.item.snoozedUntil).toBeNull();
  });

  it("kill switch OFF: transitions succeed canonically, nothing is produced or enqueued", async () => {
    const created = await createOutcome(exec, {
      principalId, title: "Killed switch probe",
      directive: "Canonical flow continues while attention is disabled.",
      criteria: [{ criterion: "Owner judges success", verificationMethod: { kind: "owner_judgment" } }],
      createdBy: "josctl",
    }, { now: T0, actor: "w1.1" });
    await transitionOutcome(exec, created.outcome.id, "queued", {}, { now: at(1), actor: "w1.1", attentionPolicy: DISABLED });
    await transitionOutcome(exec, created.outcome.id, "running", {}, { now: at(2), actor: "w1.1", attentionPolicy: DISABLED });
    const done = await transitionOutcome(exec, created.outcome.id, "waiting_user", {}, { now: at(3), actor: "w1.1", attentionPolicy: DISABLED });
    expect(done.changed).toBe(true);
    const status = await exec.query("SELECT status FROM outcomes WHERE id = $1::uuid", [created.outcome.id]);
    expect(String(status.rows[0]!.status)).toBe("waiting_user"); // canonical unaffected
    const items = await exec.query(
      "SELECT count(*)::int AS n FROM attention_items WHERE source_object_id = $1", [created.outcome.id],
    );
    expect(Number(items.rows[0]!.n)).toBe(0);
    const notifs = await exec.query(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'attention' AND source_id IN (SELECT id::text FROM attention_items WHERE source_object_id = $1)",
      [created.outcome.id],
    );
    expect(Number(notifs.rows[0]!.n)).toBe(0);
  });

  it("kill switch back ON: production resumes normally", async () => {
    const { itemId } = await makeReady("Resume probe");
    const row = await exec.query(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'attention' AND source_id = $1", [itemId],
    );
    expect(Number(row.rows[0]!.n)).toBe(1); // produced + enqueued with the switch on
  });

  it("an EXISTING row is untouched by the switch (dismiss works with it off)", async () => {
    const { itemId } = await makeReady("Untouched row probe");
    // No production call with a policy here at all: the row's lifecycle
    // controls are independent of the production switch.
    const dismissed = await import("./service.js").then((m) =>
      m.dismissAttention(exec, principalId, itemId, { now: at(50), actor: "w1.1-owner" }));
    expect(dismissed!.state).toBe("dismissed");
  });
});

// W1.1 correction — post-commit delivery observability is best-effort ALL the
// way down: enqueue failure is caught; the audit of that failure is caught
// too (a DB outage must never make a COMMITTED transition appear failed).
// Hermetic — the "DB" throws on every query.
describe("deliverOutcomeAttentionNow never rethrows after canonical truth", () => {
  it("resolves even when both the enqueue and the audit fail", async () => {
    const hostile = {
      query: () => { throw new Error("db unavailable (hostile probe)"); },
    };
    const item = {
      id: "00000000-0000-4000-8000-000000000001",
      principalId: "00000000-0000-4000-8000-000000000002",
      sourceType: "outcome", sourceObjectId: "o1", fingerprint: "outcome:o1:ready",
      kind: "outcome.ready", state: "open", level: "inbox", safetyClass: "none",
      title: "t", summary: "s", whyItMatters: null,
      evidenceRefs: [], actions: [], occurrences: 1, changeFingerprint: null,
      firstRaisedAt: new Date(), updatedAt: new Date(), seenAt: null,
      snoozedUntil: null, snoozeCount: 0, resolvedAt: null, resolvedBy: null,
      resolutionReason: null, lastDeliveredAt: null, deliveryAttempts: 0,
      lastDeliveryAttemptAt: null,
    } as AttentionItemRow;
    await expect(
      deliverOutcomeAttentionNow(hostile as never, item, { now: new Date() }),
    ).resolves.toBeUndefined();
  });
});
