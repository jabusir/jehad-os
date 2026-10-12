// W1 Lane E — Scenario B service-level acceptance (plan §22 B; ADR-0018).
// Drives the REAL pipeline end to end: createOutcome → transitionOutcome →
// producer hook → attention_items → notifications queue → claim/deliver →
// owner resolution → producer close → reopen — plus the adversarial cases
// (duplicate dispatch, delivery failure, cross-principal, hostile strings,
// expiry-vs-item independence, dismiss/reopen semantics).
//
// Post-merge file: migrations 029/030 (attention_items; notifications
// kind/source widening) and the Lane B/C modules under src/attention/ do not
// exist at base. When the tables or modules are absent the suite SKIPS with
// `W1 tables not present — runs post-merge` — it never creates schema and
// never stubs lane deliverables. Needs PostgreSQL 16; per-file isolated db,
// skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  createOutcome,
  getOutcomeById,
  setCriterionStatus,
  transitionOutcome,
  type CreatedOutcome,
  type OutcomeDb,
  type OutcomeRow,
  type OutcomeStatus,
} from "../outcomes/service.js";
import type { NotificationsConfig } from "../notifications/config.js";
import {
  claimNextApprovedNotification,
  expireOverdueNotifications,
  markDelivered,
} from "../notifications/service.js";
import type {
  AttentionActionRef,
  AttentionEvidenceRef,
  AttentionItemRow,
  AttentionResolvedBy,
  AttentionState,
  OpenAttentionInput,
  OpenAttentionResult,
} from "./types.js";

// ---------------------------------------------------------------- contract seams
// Lane B/C deliverables — imported dynamically at runtime so this file
// compiles (and skips) before the merge. Shapes mirror .review/w1-contract.md
// exactly; any drift is an acceptance failure, not a test bug.

interface AttentionServiceModule {
  openOrBumpOrReopen(db: OutcomeDb, input: OpenAttentionInput, opts: { now: Date; actor: string }): Promise<OpenAttentionResult>;
  resolveAttention(db: OutcomeDb, principalId: string, itemId: string, opts: { now: Date; actor: string; by: AttentionResolvedBy; reason?: string }): Promise<AttentionItemRow | null>;
  dismissAttention(db: OutcomeDb, principalId: string, itemId: string, opts: { now: Date; actor: string }): Promise<AttentionItemRow | null>;
  markSeen(db: OutcomeDb, principalId: string, itemId: string, opts: { now: Date; actor: string }): Promise<AttentionItemRow | null>;
  listOpenAttention(db: OutcomeDb, principalId: string, opts: { now: Date; includeSnoozed?: boolean; limit?: number }): Promise<readonly AttentionItemRow[]>;
}

interface OutcomeProducerModule {
  emitOutcomeAttention(db: OutcomeDb, outcome: OutcomeRow, toStatus: OutcomeStatus, opts: { now: Date; actor: string }): Promise<void>;
}

interface AttentionDeliveryModule {
  enqueueAttentionNotification(db: OutcomeDb, input: { item: AttentionItemRow; now: Date; config?: NotificationsConfig }): Promise<unknown>;
  markDeliveryAttempted(db: OutcomeDb, itemId: string, now: Date): Promise<void>;
  stampAttentionDelivered(db: OutcomeDb, itemId: string, now: Date): Promise<void>;
  retryEligibleUndelivered(db: OutcomeDb, input: { now: Date; config?: NotificationsConfig }): Promise<number>;
}

async function tryImport(specifier: string): Promise<Record<string, unknown> | null> {
  try {
    const mod: unknown = await import(specifier);
    return mod as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asModule<T>(mod: Record<string, unknown> | null, required: readonly string[]): T | null {
  if (mod === null) return null;
  for (const key of required) {
    if (typeof mod[key] !== "function") return null;
  }
  return mod as T;
}

// ---------------------------------------------------------------- readiness probe
// Module top level (before describe registration) so describe.skipIf sees the
// verdict synchronously. A doomed probe drops its isolated db — no leaks.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** 10:00 America/Los_Angeles — outside the 22:00–07:00 PT quiet hours. */
const T0 = new Date("2026-10-06T17:00:00.000Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const ATTENTION_CONFIG = {
  autoApproveKinds: ["attention"],
  escalationMinUrgency: "high",
  defaultTtlMinutes: 240,
} as unknown as NotificationsConfig;

let db: IsolatedDb | null = null;
let attention: AttentionServiceModule | null = null;
let producer: OutcomeProducerModule | null = null;
let delivery: AttentionDeliveryModule | null = null;
let ownerPrincipalId = "";
let owner2PrincipalId = "";
let harnessPrincipalId = "";

if (TEST_DATABASE_URL !== undefined) {
  db = await createIsolatedTestDb(TEST_DATABASE_URL, "w1e2e");
  await migrateUp(db.pool);
  const tables = await db.pool.query(
    "SELECT to_regclass('public.attention_items') AS t",
  );
  const tablesPresent = tables.rows[0]?.["t"] !== null && tables.rows[0]?.["t"] !== undefined;
  const [serviceMod, producerMod, deliveryMod] = await Promise.all([
    tryImport("./service.js"),
    tryImport("./outcome-producer.js"),
    tryImport("./delivery.js"),
  ]);
  attention = asModule<AttentionServiceModule>(serviceMod, [
    "openOrBumpOrReopen", "resolveAttention", "dismissAttention", "markSeen", "listOpenAttention",
  ]);
  producer = asModule<OutcomeProducerModule>(producerMod, ["emitOutcomeAttention"]);
  delivery = asModule<AttentionDeliveryModule>(deliveryMod, [
    "enqueueAttentionNotification", "markDeliveryAttempted", "stampAttentionDelivered", "retryEligibleUndelivered",
  ]);
  const modulesPresent = attention !== null && producer !== null && delivery !== null;
  if (!tablesPresent) {
    await dropIsolatedTestDb(TEST_DATABASE_URL, db);
    db = null;
  } else if (!modulesPresent) {
    await dropIsolatedTestDb(TEST_DATABASE_URL, db);
    db = null;
  }
}

describe.skipIf(db === null)("W1 scenario B — delegated result end to end (integration)", () => {
  beforeAll(async () => {
    if (db === null) return;
    await seedDomains(db.pool);
    const seed = async (name: string, type: string): Promise<string> => {
      const r = await db!.pool.query(
        "INSERT INTO principals (type, name) VALUES ($1, $2) RETURNING id",
        [type, `${name}-${randomUUID().slice(0, 8)}`],
      );
      return String(r.rows[0]!.id);
    };
    ownerPrincipalId = await seed("w1-owner", "user");
    owner2PrincipalId = await seed("w1-owner-2", "user");
    harnessPrincipalId = await seed("w1-edge", "harness");
  });

  afterAll(async () => {
    if (db !== null && TEST_DATABASE_URL !== undefined) {
      await dropIsolatedTestDb(TEST_DATABASE_URL, db);
      db = null;
    }
  });

  // ------------------------------------------------------------ helpers

  function makeOutcome(principalId: string, title: string): Promise<CreatedOutcome> {
    return createOutcome(db!.pool, {
      principalId,
      title,
      directive: "W1 acceptance: do the delegated thing and come back for judgment",
      criteria: [{ criterion: "Outcome achieved, judged by the owner", verificationMethod: { kind: "owner_judgment" } }],
      createdBy: "josctl",
    }, { now: T0, actor: "w1-e2e" });
  }

  async function drive(outcomeId: string, to: OutcomeStatus, minutes: number, actor: string): Promise<void> {
    const result = await transitionOutcome(db!.pool, outcomeId, to, {}, { now: at(minutes), actor });
    expect(result.changed).toBe(true);
  }

  /** accepted → queued → running → waiting_user (all DB-trigger-legal). */
  async function driveToWaitingUser(outcomeId: string): Promise<void> {
    await drive(outcomeId, "queued", 1, "w1-executor");
    await drive(outcomeId, "running", 2, "w1-executor");
    await drive(outcomeId, "waiting_user", 3, "w1-executor");
  }

  interface RawItem {
    id: string;
    principal_id: string;
    source_type: string;
    source_object_id: string;
    fingerprint: string;
    kind: string;
    state: AttentionState;
    level: string;
    safety_class: string;
    title: string;
    summary: string;
    why_it_matters: string | null;
    evidence_refs: AttentionEvidenceRef[];
    actions: AttentionActionRef[];
    occurrences: number;
    change_fingerprint: string | null;
    first_raised_at: string;
    resolved_by: string | null;
    resolution_reason: string | null;
    last_delivered_at: string | null;
    delivery_attempts: number;
    last_delivery_attempt_at: string | null;
  }

  async function itemsFor(outcomeId: string): Promise<RawItem[]> {
    const r = await db!.pool.query(
      "SELECT * FROM attention_items WHERE source_object_id = $1 ORDER BY first_raised_at, id",
      [outcomeId],
    );
    return r.rows as RawItem[];
  }

  /** Asserts exactly one item row exists for the outcome and returns it. */
  async function soleItem(outcomeId: string): Promise<RawItem> {
    const items = await itemsFor(outcomeId);
    expect(items).toHaveLength(1);
    return items[0]!;
  }

  async function eventCount(type: string): Promise<number> {
    const r = await db!.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE type = $1",
      [type],
    );
    return Number(r.rows[0]!.n);
  }

  interface RawNotification { id: string; status: string; payload: Record<string, unknown>; source_id: string; source_type: string }

  async function attentionNotifications(itemId: string): Promise<RawNotification[]> {
    const r = await db!.pool.query(
      "SELECT id, status, payload, source_id, source_type FROM notifications WHERE kind = 'attention' AND source_id = $1 ORDER BY created_at, id",
      [itemId],
    );
    return r.rows as RawNotification[];
  }

  function expectReadyShape(raw: RawItem, outcome: OutcomeRow, waitingSince: Date): void {
    expect(raw.principal_id).toBe(ownerPrincipalId);
    expect(raw.source_type).toBe("outcome");
    expect(raw.kind).toBe("outcome.ready");
    expect(raw.fingerprint).toBe(`outcome:${outcome.id}:ready`);
    expect(raw.level).toBe("inbox");
    expect(raw.safety_class).toBe("none");
    expect(raw.state).toBe("open");
    expect(raw.title).toBe(`${outcome.title} — ready for your judgment`);
    expect(raw.why_it_matters).toBe("Delegated work needs your decision to continue.");
    expect(raw.evidence_refs).toEqual([{ type: "outcome", id: outcome.ref }]);
    expect(raw.actions).toEqual(
      expect.arrayContaining([
        { key: "outcome.open", args: { ref: outcome.ref } },
        { key: "attention.resolve" },
      ]),
    );
    expect(raw.change_fingerprint).toBe(`${outcome.id}:waiting_user:${waitingSince.toISOString()}`);
  }

  function bumpInput(raw: RawItem, outcomeId: string, changeFingerprint: string): OpenAttentionInput {
    return {
      principalId: ownerPrincipalId,
      sourceType: "outcome",
      sourceObjectId: outcomeId,
      fingerprint: `outcome:${outcomeId}:ready`,
      kind: "outcome.ready",
      level: "inbox",
      title: raw.title,
      summary: raw.summary,
      whyItMatters: raw.why_it_matters ?? undefined,
      evidenceRefs: raw.evidence_refs,
      actions: raw.actions,
      changeFingerprint,
    };
  }

  // ------------------------------------------------------------ 1. scenario B

  it("scenario B: open → deliver → owner resolve → producer close → reopen", async () => {
    const { outcome } = await makeOutcome(ownerPrincipalId, "Reconcile the Q3 expense report");
    const openedBefore = await eventCount("attention.item.opened");
    const resolvedBefore = await eventCount("attention.item.resolved");

    await driveToWaitingUser(outcome.id);

    // Exactly one item, exact contract shape.
    const raw = await soleItem(outcome.id);
    expectReadyShape(raw, outcome, at(3));
    expect(raw.occurrences).toBe(1);
    expect(raw.last_delivered_at).toBeNull();

    // The opened event exists (content-free payload contract — ids/counts only).
    expect(await eventCount("attention.item.opened")).toBe(openedBefore + 1);

    // Exactly one attention notification: auto-approved, summary-carrying.
    const notifs = await attentionNotifications(raw.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.source_type).toBe("attention");
    expect(notifs[0]!.status).toBe("approved");
    const content = notifs[0]!.payload["content"];
    expect(typeof content).toBe("string");
    expect(String(content)).toContain(raw.summary);

    // Enqueue accounted a delivery attempt (markDeliveryAttempted at enqueue).
    expect(raw.delivery_attempts).toBe(1);
    expect(raw.last_delivery_attempt_at).not.toBeNull();

    // Simulate the edge: claim → deliver → delivered callback stamps the item
    // (success-only; integrator wires stampAttentionDelivered post-merge).
    const claimed = await claimNextApprovedNotification(db!.pool, { claimedBy: harnessPrincipalId, now: () => at(4) });
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(notifs[0]!.id);
    await markDelivered(db!.pool, claimed!.id, { deliveredBy: harnessPrincipalId, now: () => at(5) });
    await delivery!.stampAttentionDelivered(db!.pool, raw.id, at(5));
    const delivered = await soleItem(outcome.id);
    expect(delivered.last_delivered_at).not.toBeNull();

    // Owner resolves the item; the canonical outcome row is UNTOUCHED.
    const resolved = await attention!.resolveAttention(db!.pool, ownerPrincipalId, raw.id, {
      now: at(6), actor: "w1-owner", by: "owner",
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.state).toBe("resolved");
    expect(resolved!.resolvedBy).toBe("owner");
    expect(await eventCount("attention.item.resolved")).toBe(resolvedBefore + 1);
    const outcomeAfterResolve = await getOutcomeById(db!.pool, outcome.id);
    expect(outcomeAfterResolve!.status).toBe("waiting_user");

    // Leaving waiting_user (75 min later — past the 60 min delivery cooldown):
    // the ready item was ALREADY owner-resolved, so the producer close resolves
    // nothing new — no duplicate opened event, resolved_by stays 'owner'.
    const opensBeforeRun = await eventCount("attention.item.opened");
    await drive(outcome.id, "running", 70, "w1-executor");
    const afterRun = await soleItem(outcome.id);
    expect(afterRun.state).toBe("resolved");
    expect(afterRun.resolved_by).toBe("owner");
    expect(await eventCount("attention.item.opened")).toBe(opensBeforeRun);

    // Re-entering waiting_user REOPENS the same row: occurrences 2,
    // first_raised_at preserved, one new opened event, re-delivery enqueued.
    await drive(outcome.id, "waiting_user", 80, "w1-executor");
    const reopened = await soleItem(outcome.id);
    expect(reopened.id).toBe(raw.id);
    expect(reopened.state).toBe("open");
    expect(reopened.occurrences).toBe(2);
    expect(reopened.first_raised_at).toBe(raw.first_raised_at);
    expect(reopened.change_fingerprint).toBe(`${outcome.id}:waiting_user:${at(80).toISOString()}`);
    expect(await eventCount("attention.item.opened")).toBe(opensBeforeRun + 1);
    expect(await attentionNotifications(raw.id)).toHaveLength(2);
  });

  // -------------------------------------- 2. delivery failure ≠ item failure

  it("expired notification leaves the item open; retry re-enqueues exactly once", async () => {
    const { outcome } = await makeOutcome(ownerPrincipalId, "Book the dentist appointment");
    await driveToWaitingUser(outcome.id);
    const raw = await soleItem(outcome.id);
    const notifs = await attentionNotifications(raw.id);
    expect(notifs).toHaveLength(1);

    // The delivery window lapses: the projection dies, the durable item lives.
    await db!.pool.query(
      "UPDATE notifications SET expires_at = $2::timestamptz WHERE id = $1::uuid",
      [notifs[0]!.id, at(3).toISOString()],
    );
    const expiredIds = await expireOverdueNotifications(db!.pool, { now: at(4) });
    expect(expiredIds).toContain(notifs[0]!.id);
    const afterExpiry = await soleItem(outcome.id);
    expect(afterExpiry.state).toBe("open");
    expect(afterExpiry.last_delivered_at).toBeNull();

    // The liveness retry re-enqueues: open item, no in-flight row, ladder
    // passes → exactly one new notification, attempts accounted.
    const enqueued = await delivery!.retryEligibleUndelivered(db!.pool, { now: at(65), config: ATTENTION_CONFIG });
    expect(enqueued).toBe(1);
    const retried = await soleItem(outcome.id);
    expect(retried.state).toBe("open");
    expect(retried.delivery_attempts).toBe(2);
    const notifsAfter = await attentionNotifications(raw.id);
    expect(notifsAfter).toHaveLength(2);
    expect(notifsAfter.filter((n) => n.status === "approved")).toHaveLength(1);

    // A second retry with an in-flight notification is a no-op (at most one
    // in-flight delivery per item).
    const again = await delivery!.retryEligibleUndelivered(db!.pool, { now: at(66), config: ATTENTION_CONFIG });
    expect(again).toBe(0);
    expect(await attentionNotifications(raw.id)).toHaveLength(2);
  });

  // ------------------------------------------------- 3. duplicate producers

  it("double-dispatch collapses: two actors, one transition → one row, occurrences 1", async () => {
    const { outcome } = await makeOutcome(ownerPrincipalId, "Summarize the plaid thread");
    await drive(outcome.id, "queued", 1, "executor-a");
    await drive(outcome.id, "running", 2, "executor-a");

    // Two "actors" race the same transition; only the CAS winner produces —
    // the loser is a no-op (changed=false ⇒ no event, no producer run).
    const first = await transitionOutcome(db!.pool, outcome.id, "waiting_user", {}, { now: at(3), actor: "executor-a" });
    expect(first.changed).toBe(true);
    const second = await transitionOutcome(db!.pool, outcome.id, "waiting_user", {}, { now: at(4), actor: "executor-b" });
    expect(second.changed).toBe(false);

    const raw = await soleItem(outcome.id);
    expect(raw.occurrences).toBe(1);
    expect(await attentionNotifications(raw.id)).toHaveLength(1);

    // Direct duplicate producer dispatch, same occurrence identity (same
    // `now` ⇒ same change_fingerprint): the 3-branch write collapses into the
    // ONE row (ADR-0018 §1.3); replays count occurrences but identical
    // fingerprints never re-deliver (§1.4, invariant 5).
    const openedBefore = await eventCount("attention.item.opened");
    await producer!.emitOutcomeAttention(db!.pool, first.outcome, "waiting_user", { now: at(3), actor: "replay-a" });
    await producer!.emitOutcomeAttention(db!.pool, first.outcome, "waiting_user", { now: at(3), actor: "replay-b" });
    const collapsed = await soleItem(outcome.id);
    expect(collapsed.occurrences).toBe(3);
    expect(await attentionNotifications(raw.id)).toHaveLength(1);
    expect(await eventCount("attention.item.opened")).toBe(openedBefore);
  });

  // ------------------------------------------------------ 4. cross-principal

  it("a foreign principal cannot list, resolve, dismiss or see the item", async () => {
    const { outcome } = await makeOutcome(ownerPrincipalId, "Private: draft the renewal note");
    await driveToWaitingUser(outcome.id);
    const raw = await soleItem(outcome.id);

    expect(await attention!.listOpenAttention(db!.pool, owner2PrincipalId, { now: at(4) })).toHaveLength(0);
    expect(await attention!.resolveAttention(db!.pool, owner2PrincipalId, raw.id, { now: at(4), actor: "w1-owner-2", by: "owner" })).toBeNull();
    expect(await attention!.dismissAttention(db!.pool, owner2PrincipalId, raw.id, { now: at(4), actor: "w1-owner-2" })).toBeNull();
    expect(await attention!.markSeen(db!.pool, owner2PrincipalId, raw.id, { now: at(4), actor: "w1-owner-2" })).toBeNull();

    // Fail-closed means untouched: not resolved, not even seen.
    const after = await soleItem(outcome.id);
    expect(after.state).toBe("open");
    const seen = await db!.pool.query(
      "SELECT seen_at, resolved_at FROM attention_items WHERE id = $1::uuid",
      [raw.id],
    );
    expect(seen.rows[0]!["seen_at"]).toBeNull();
    expect(seen.rows[0]!["resolved_at"]).toBeNull();
  });

  // ------------------------------------------- 5. completed opens NO new item

  it("completed: zero open attention rows for the outcome and no completion notification", async () => {
    const { outcome } = await makeOutcome(ownerPrincipalId, "File the taxes draft");
    await driveToWaitingUser(outcome.id);
    const raw = await soleItem(outcome.id);
    expect(await attentionNotifications(raw.id)).toHaveLength(1);

    // waiting_user cannot reach completed directly (DB trigger): verifying is
    // the exit, and leaving waiting_user is what producer-closes the item
    // (reason outcome_<toStatus> = outcome_verifying here).
    await setCriterionStatus(db!.pool, outcome.id, 1, "waived_by_owner", { now: at(4), actor: "w1-owner" });
    await drive(outcome.id, "verifying", 5, "w1-executor");
    await drive(outcome.id, "completed", 6, "w1-executor");

    const items = await itemsFor(outcome.id);
    expect(items).toHaveLength(1); // the ready item, auto-resolved by the producer
    expect(items[0]!.state).toBe("resolved");
    expect(items[0]!.resolved_by).toBe("producer");
    expect(items[0]!.resolution_reason).toBe("outcome_verifying");
    const openCount = await db!.pool.query(
      "SELECT count(*)::int AS n FROM attention_items WHERE source_object_id = $1 AND state IN ('open','seen','snoozed')",
      [outcome.id],
    );
    expect(Number(openCount.rows[0]!.n)).toBe(0);
    expect(await attentionNotifications(raw.id)).toHaveLength(1); // no new push
  });

  // ------------------------------- 6. blocked closes on leave; failed stays

  it("blocked item auto-resolves with outcome_<status>; failed item never auto-resolves", async () => {
    // (a) blocked → cancelled: producer closes with reason outcome_cancelled.
    const cancelled = await makeOutcome(ownerPrincipalId, "Reorder the espresso beans");
    await drive(cancelled.outcome.id, "queued", 1, "w1-executor");
    await drive(cancelled.outcome.id, "running", 2, "w1-executor");
    await drive(cancelled.outcome.id, "blocked", 3, "w1-executor");
    const blockedItem = await soleItem(cancelled.outcome.id);
    expect(blockedItem.kind).toBe("outcome.blocked");
    expect(blockedItem.fingerprint).toBe(`outcome:${cancelled.outcome.id}:blocked`);
    expect(blockedItem.why_it_matters).toBe("Delegated work is blocked and needs your attention.");
    await drive(cancelled.outcome.id, "cancelled", 4, "w1-owner");
    const closedBlocked = await soleItem(cancelled.outcome.id);
    expect(closedBlocked.state).toBe("resolved");
    expect(closedBlocked.resolved_by).toBe("producer");
    expect(closedBlocked.resolution_reason).toBe("outcome_cancelled");

    // (b) blocked → failed: the blocked item closes (reason outcome_failed),
    // the FAILED item opens and stays open — owner-ack only, no auto-resolve.
    const failed = await makeOutcome(ownerPrincipalId, "Migrate the photo library");
    await drive(failed.outcome.id, "queued", 1, "w1-executor");
    await drive(failed.outcome.id, "running", 2, "w1-executor");
    await drive(failed.outcome.id, "blocked", 3, "w1-executor");
    await drive(failed.outcome.id, "failed", 4, "w1-executor");
    const items = await itemsFor(failed.outcome.id);
    expect(items).toHaveLength(2);
    const failedItem = items.find((i) => i.kind === "outcome.failed");
    expect(failedItem).toBeDefined();
    expect(failedItem!.state).toBe("open");
    expect(failedItem!.fingerprint).toBe(`outcome:${failed.outcome.id}:failed`);
    expect(failedItem!.why_it_matters).toBe("Delegated work failed.");
    expect(failedItem!.actions).toEqual(
      expect.arrayContaining([
        { key: "outcome.open", args: { ref: failed.outcome.ref } },
        { key: "attention.resolve" },
      ]),
    );
    const blockedSibling = items.find((i) => i.kind === "outcome.blocked");
    expect(blockedSibling).toBeDefined();
    expect(blockedSibling!.state).toBe("resolved");
    expect(blockedSibling!.resolution_reason).toBe("outcome_failed");
  });

  // ---------------------------------------------------- 7. hostile strings

  it("hostile titles are stored raw and intact (render escapes, never store)", async () => {
    const hostile = `<script>alert('x')</script> <img src=x onerror=alert(1)>`;
    const { outcome } = await makeOutcome(ownerPrincipalId, hostile);
    await driveToWaitingUser(outcome.id);
    const raw = await soleItem(outcome.id);
    expect(raw.title).toBe(`${hostile} — ready for your judgment`);
    expect(raw.summary).toContain("<script>alert('x')</script>");
    expect(raw.summary).toContain("<img src=x onerror=alert(1)>");
    const notifs = await attentionNotifications(raw.id);
    expect(notifs).toHaveLength(1);
    expect(String(notifs[0]!.payload["content"])).toContain("<img src=x onerror=alert(1)>");
    // The HTTP leg (GET /ui must contain no raw '<script'/'onerror=') lives in
    // apps/api/src/routes/w1-acceptance.integration.test.ts (Lane D surface).
  });

  // --------------------------------- 8. notification expiry ≠ item resolution

  it("force-expiring the notification does not resolve or mutate the item", async () => {
    const { outcome } = await makeOutcome(ownerPrincipalId, "Renew the passport");
    await driveToWaitingUser(outcome.id);
    const raw = await soleItem(outcome.id);
    const notifs = await attentionNotifications(raw.id);
    expect(notifs).toHaveLength(1);

    await db!.pool.query(
      "UPDATE notifications SET expires_at = $2::timestamptz WHERE id = $1::uuid",
      [notifs[0]!.id, at(3).toISOString()],
    );
    await expireOverdueNotifications(db!.pool, { now: at(30) });

    const after = await soleItem(outcome.id);
    expect(after.state).toBe("open");
    const row = await db!.pool.query(
      "SELECT resolved_at, resolved_by, last_delivered_at FROM attention_items WHERE id = $1::uuid",
      [raw.id],
    );
    expect(row.rows[0]!["resolved_at"]).toBeNull();
    expect(row.rows[0]!["resolved_by"]).toBeNull();
    expect(row.rows[0]!["last_delivered_at"]).toBeNull();
  });

  // ------------------------------------------------ 9. dismiss/reopen semantics

  it("dismiss closes without touching the outcome; closed-row bumps reopen (ratified)", async () => {
    const { outcome } = await makeOutcome(ownerPrincipalId, "Water the office plants log");
    await driveToWaitingUser(outcome.id);
    const raw = await soleItem(outcome.id);
    const identicalFingerprint = `${outcome.id}:waiting_user:${at(3).toISOString()}`;

    const dismissed = await attention!.dismissAttention(db!.pool, ownerPrincipalId, raw.id, { now: at(4), actor: "w1-owner" });
    expect(dismissed!.state).toBe("dismissed");
    expect(dismissed!.resolutionReason).not.toBeNull();
    expect(dismissed!.resolvedBy).toBe("owner");
    const outcomeAfterDismiss = await getOutcomeById(db!.pool, outcome.id);
    expect(outcomeAfterDismiss!.status).toBe("waiting_user"); // outcome untouched

    // Bump with the IDENTICAL change_fingerprint: the closed row reopens per
    // §1.3 (closed → reopen, preserve first_raised_at) but must NOT re-deliver
    // — an unchanged fingerprint never re-notifies (§1.4, invariant 5).
    const bump = await attention!.openOrBumpOrReopen(db!.pool, bumpInput(raw, outcome.id, identicalFingerprint), {
      now: at(5), actor: "replay",
    });
    expect(bump.action).toBe("reopened");
    expect(bump.deliverNow).toBe(false);
    const afterIdentical = await soleItem(outcome.id);
    expect(afterIdentical.state).toBe("open");
    expect(afterIdentical.occurrences).toBe(2);

    // Re-dismiss, then a genuinely NEW occurrence (different fingerprint):
    // reopen AND deliver (the ratified `delivered=true` semantics).
    await attention!.dismissAttention(db!.pool, ownerPrincipalId, raw.id, { now: at(6), actor: "w1-owner" });
    const bumpNew = await attention!.openOrBumpOrReopen(db!.pool, bumpInput(raw, outcome.id, `${outcome.id}:waiting_user:${at(150).toISOString()}`), {
      now: at(150), actor: "producer",
    });
    expect(bumpNew.action).toBe("reopened");
    expect(bumpNew.deliverNow).toBe(true);
    const afterNew = await soleItem(outcome.id);
    expect(afterNew.state).toBe("open");
    expect(afterNew.occurrences).toBe(3);
    expect(afterNew.first_raised_at).toBe(raw.first_raised_at); // reopen preserves
  });
});
