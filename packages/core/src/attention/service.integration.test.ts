// Attention service integration tests (ADR-0018; product-reset plan §5)
// against an isolated migrated database: the three-branch write (insert /
// bump / reopen with first_raised_at preserved), the change_fingerprint
// re-delivery rule, seen ≠ resolved (seen items stay listed — the documented
// W1 choice), explicit snooze state, fail-closed principal scoping, the
// contract sort, the liveness sweep (gone resolves, unknown never closes,
// unregistered outcome skips), and terminal-row GC. Needs PostgreSQL 16 —
// skipped unless TEST_DATABASE_URL is set. The live `jehad` database is
// NEVER touched: every run gets its own jehad_test_* database.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { registerAttentionResolver } from "./resolvers.js";
import {
  dismissAttention,
  listOpenAttention,
  livenessSweep,
  markSeen,
  openOrBumpOrReopen,
  resolveAttention,
  resolveAttentionBySource,
  snoozeAttention,
  type AttentionDb,
} from "./service.js";
import type { OpenAttentionInput } from "./types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// Mon 2026-09-21 10:00 PDT — business hours (quiet hours do not interfere).
const NOW = new Date("2026-09-21T17:00:00.000Z");
const ACTOR = "system:attention-test";

describe.skipIf(TEST_DATABASE_URL === undefined)("attention service (W1, ADR-0018)", () => {
  let db: IsolatedDb;
  let principalId: string;
  let seq = 0;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "attentionw1");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'attention-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
    // A "watch" resolver under test control; the `outcome` sourceType is
    // deliberately NEVER registered here (lane C owns that registration) —
    // proving unregistered → unknown → never closes.
    registerAttentionResolver("watch", async (_db, item) =>
      item.sourceObjectId === "gone-1" ? "gone"
      : item.sourceObjectId === "live-1" ? "live"
      : "unknown",
    );
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

  function openItem(overrides: Partial<OpenAttentionInput> = {}): OpenAttentionInput {
    return {
      principalId,
      sourceType: "watch",
      sourceObjectId: `watch-obj-${seq += 1}`,
      fingerprint: "fp-1",
      kind: "watch.match",
      level: "inbox",
      title: "Acme quote updated",
      summary: "Acme replied with packaging numbers.",
      whyItMatters: "Feeds the delegation decision.",
      evidenceRefs: [{ type: "gmail_message", id: "m-1" }],
      actions: [{ key: "attention.resolve" }],
      ...overrides,
    };
  }

  const exec: AttentionDb = {
    query: (sql, params = []) =>
      db.pool.query(sql, params as unknown[]) as unknown as Promise<{ rows: Record<string, unknown>[] }>,
    connect: () => db.pool.connect() as unknown as import("./service.js").AttentionTx & { release(): void },
  };

  function q(sql: string, params: readonly unknown[] = []): { rows: Array<Record<string, unknown>> } {
    return db.pool.query(sql, params) as unknown as { rows: Array<Record<string, unknown>> };
  }

  async function openEventCount(itemId: string): Promise<number> {
    const rows = await q(`SELECT count(*)::int AS n FROM events WHERE type = 'attention.item.opened' AND payload->>'itemId' = $1`, [itemId]);
    return Number(rows.rows[0]!.n);
  }

  it("migration 029: the identity key collapses duplicates at the DB level too", async () => {
    const first = await exec.query(
      `INSERT INTO attention_items (id, principal_id, source_type, source_object_id, fingerprint, kind, title, summary)
       VALUES (gen_random_uuid(), $1::uuid, 'watch', 'raw-obj', 'raw-fp', 'watch.match', 't', 's') RETURNING id`,
      [principalId],
    );
    expect(first.rows).toHaveLength(1);
    await expect(
      exec.query(
        `INSERT INTO attention_items (id, principal_id, source_type, source_object_id, fingerprint, kind, title, summary)
         VALUES (gen_random_uuid(), $1::uuid, 'watch', 'raw-obj', 'raw-fp', 'watch.match', 't', 's')`,
        [principalId],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("no-row → INSERT: opens, delivers, emits the content-free opened event + audit", async () => {
    const result = await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "open-1" }), { now: at(0), actor: ACTOR });
    expect(result.action).toBe("opened");
    expect(result.deliverNow).toBe(true);
    expect(result.deferReason).toBeNull();
    expect(result.item.state).toBe("open");
    expect(result.item.occurrences).toBe(1);
    expect(result.item.firstRaisedAt.toISOString()).toBe(at(0).toISOString());

    const events = await q(
      `SELECT payload FROM events WHERE type = 'attention.item.opened' AND payload->>'itemId' = $1`,
      [result.item.id],
    );
    expect(events.rows).toHaveLength(1);
    const payload = events.rows[0]!.payload as Record<string, unknown>;
    // Content-free contract: ids/kind/level ONLY — never title/summary text.
    expect(Object.keys(payload).sort()).toEqual(
      ["fingerprint", "itemId", "kind", "level", "principalId", "sourceObjectId", "sourceType"],
    );
    expect(payload.kind).toBe("watch.match");

    const audits = await q(`SELECT outputs_ref FROM audit_log WHERE action = 'attention.opened' AND outputs_ref LIKE $1`, [`%${result.item.id}%`]);
    expect(audits.rows).toHaveLength(1);
  });

  it("identical duplicate producer call → bump: occurrences=2, one row, unchanged ⇒ no re-delivery, no new event", async () => {
    const input = openItem({ sourceObjectId: "bump-1", changeFingerprint: "occ-1" });
    const opened = await openOrBumpOrReopen(exec, input, { now: at(1), actor: ACTOR });
    expect(opened.action).toBe("opened");

    const bumped = await openOrBumpOrReopen(exec, input, { now: at(2), actor: ACTOR });
    expect(bumped.action).toBe("bumped");
    expect(bumped.item.occurrences).toBe(2);
    expect(bumped.deliverNow).toBe(false);
    expect(bumped.deferReason).toBe("unchanged");
    expect(await itemCountFor("bump-1")).toBe(1);
    expect(await openEventCount(opened.item.id)).toBe(1);
  });

  it("changed change_fingerprint on bump → deliverNow true (a new occurrence is news)", async () => {
    const input = openItem({ sourceObjectId: "bump-2", changeFingerprint: "occ-1" });
    await openOrBumpOrReopen(exec, input, { now: at(3), actor: ACTOR });
    const again = await openOrBumpOrReopen(exec, { ...input, changeFingerprint: "occ-2" }, { now: at(4), actor: ACTOR });
    expect(again.action).toBe("bumped");
    expect(again.deliverNow).toBe(true);
    expect(again.deferReason).toBeNull();
    expect(again.item.occurrences).toBe(2);
    expect(again.item.changeFingerprint).toBe("occ-2");
    expect(again.item.title).toBe(input.title); // text refreshed on the one row
  });

  it("a level rise on bump re-delivers even with an identical fingerprint, and the item level never falls", async () => {
    const input = openItem({ sourceObjectId: "bump-3", level: "inbox", changeFingerprint: "occ-1" });
    await openOrBumpOrReopen(exec, input, { now: at(5), actor: ACTOR });
    const risen = await openOrBumpOrReopen(exec, { ...input, level: "interrupt" }, { now: at(6), actor: ACTOR });
    expect(risen.deliverNow).toBe(true);
    expect(risen.deferReason).toBeNull();
    expect(risen.item.level).toBe("interrupt");

    const calmed = await openOrBumpOrReopen(exec, { ...input, level: "digest" }, { now: at(7), actor: ACTOR });
    expect(calmed.item.level).toBe("interrupt");
  });

  it("seen ≠ resolved: markSeen leaves state 'seen' and the item STAYS listed (it still needs action)", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "seen-1" }), { now: at(8), actor: ACTOR });
    const seen = await markSeen(exec, principalId, opened.item.id, { now: at(9), actor: ACTOR });
    expect(seen!.state).toBe("seen");
    expect(seen!.seenAt!.toISOString()).toBe(at(9).toISOString());
    expect(seen!.resolvedAt).toBeNull();

    const listed = await listOpenAttention(exec, principalId, { now: at(9) });
    expect(listed.map((i) => i.id)).toContain(opened.item.id);

    // A seen item still resolves (owner comes back to it).
    const resolved = await resolveAttention(exec, principalId, opened.item.id, { now: at(10), actor: ACTOR, by: "owner", reason: "done" });
    expect(resolved!.state).toBe("resolved");
  });

  it("resolve emits attention.item.resolved once; a re-resolve is an honest no-op (no second event)", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "resolve-1" }), { now: at(11), actor: ACTOR });
    const resolved = await resolveAttention(exec, principalId, opened.item.id, { now: at(12), actor: ACTOR, by: "owner", reason: "handled" });
    expect(resolved!.state).toBe("resolved");
    expect(resolved!.resolvedBy).toBe("owner");
    expect(resolved!.resolutionReason).toBe("handled");

    const events = await q(`SELECT payload FROM events WHERE type = 'attention.item.resolved' AND payload->>'itemId' = $1`, [opened.item.id]);
    expect(events.rows).toHaveLength(1);
    const payload = events.rows[0]!.payload as Record<string, unknown>;
    expect(payload.resolvedBy).toBe("owner");
    expect(payload.reason).toBe("handled");

    const again = await resolveAttention(exec, principalId, opened.item.id, { now: at(13), actor: ACTOR, by: "owner" });
    expect(again!.id).toBe(opened.item.id);
    expect(await eventCount("attention.item.resolved", opened.item.id)).toBe(1);
  });

  it("dismiss is a terminal owner close, off the action list", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "dismiss-1" }), { now: at(14), actor: ACTOR });
    const dismissed = await dismissAttention(exec, principalId, opened.item.id, { now: at(15), actor: ACTOR });
    expect(dismissed!.state).toBe("dismissed");
    expect(dismissed!.resolvedBy).toBe("owner");
    expect(dismissed!.resolutionReason).toBe("dismissed");
    const listed = await listOpenAttention(exec, principalId, { now: at(15), includeSnoozed: true });
    expect(listed.map((i) => i.id)).not.toContain(opened.item.id);
  });

  it("snooze is an explicit state: expiry, count, list visibility; resolving a snoozed item is allowed", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "snooze-1" }), { now: at(16), actor: ACTOR });
    const snoozed = await snoozeAttention(exec, principalId, opened.item.id, 30, { now: at(17), actor: ACTOR });
    expect(snoozed!.state).toBe("snoozed");
    expect(snoozed!.snoozedUntil!.toISOString()).toBe(at(47).toISOString());
    expect(snoozed!.snoozeCount).toBe(1);

    expect((await listOpenAttention(exec, principalId, { now: at(17) })).map((i) => i.id)).not.toContain(opened.item.id);
    expect((await listOpenAttention(exec, principalId, { now: at(17), includeSnoozed: true })).map((i) => i.id)).toContain(opened.item.id);

    const resolved = await resolveAttention(exec, principalId, opened.item.id, { now: at(18), actor: ACTOR, by: "owner" });
    expect(resolved!.state).toBe("resolved");
  });

  it("snooze validates minutes (fail-closed against a hidden timer)", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "snooze-2" }), { now: at(19), actor: ACTOR });
    await expect(snoozeAttention(exec, principalId, opened.item.id, 0, { now: at(19), actor: ACTOR })).rejects.toThrow(TypeError);
    await expect(snoozeAttention(exec, principalId, opened.item.id, -5, { now: at(19), actor: ACTOR })).rejects.toThrow(TypeError);
  });

  it("reopen on recurrence preserves first_raised_at, clears the resolution, and delivers", async () => {
    const input = openItem({ sourceObjectId: "reopen-1" });
    const opened = await openOrBumpOrReopen(exec, input, { now: at(20), actor: ACTOR });
    await resolveAttention(exec, principalId, opened.item.id, { now: at(21), actor: ACTOR, by: "owner", reason: "done" });

    const reopened = await openOrBumpOrReopen(exec, input, { now: at(22), actor: ACTOR });
    expect(reopened.action).toBe("reopened");
    expect(reopened.deliverNow).toBe(true);
    expect(reopened.item.state).toBe("open");
    // The invariant: the condition's original raise time survives.
    expect(reopened.item.firstRaisedAt.toISOString()).toBe(opened.item.firstRaisedAt.toISOString());
    expect(reopened.item.resolvedAt).toBeNull();
    expect(reopened.item.resolvedBy).toBeNull();
    expect(reopened.item.occurrences).toBe(2);
  });

  it("fail-closed principal scoping: a foreign principal gets null / 0 / [] everywhere", async () => {
    const foreign = randomUUID();
    const opened = await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "scoped-1" }), { now: at(23), actor: ACTOR });
    expect(await resolveAttention(exec, foreign, opened.item.id, { now: at(24), actor: ACTOR, by: "owner" })).toBeNull();
    expect(await dismissAttention(exec, foreign, opened.item.id, { now: at(24), actor: ACTOR })).toBeNull();
    expect(await markSeen(exec, foreign, opened.item.id, { now: at(24), actor: ACTOR })).toBeNull();
    expect(await snoozeAttention(exec, foreign, opened.item.id, 30, { now: at(24), actor: ACTOR })).toBeNull();
    expect(await listOpenAttention(exec, foreign, { now: at(24) })).toEqual([]);
    expect(await resolveAttentionBySource(exec, foreign, "watch", "scoped-1", { now: at(24), actor: ACTOR, by: "producer", reason: "cancelled" })).toBe(0);
    // The owner is untouched by all of it.
    expect((await listOpenAttention(exec, principalId, { now: at(24) })).map((i) => i.id)).toContain(opened.item.id);
  });

  it("resolveAttentionBySource closes by producer identity (leaving waiting_user / cancelled)", async () => {
    const input = openItem({ sourceObjectId: "by-source-1" });
    await openOrBumpOrReopen(exec, input, { now: at(25), actor: ACTOR });
    const closed = await resolveAttentionBySource(exec, principalId, "watch", "by-source-1", { now: at(26), actor: ACTOR, by: "producer", reason: "watch_cancelled" });
    expect(closed).toBe(1);
    expect(await resolveAttentionBySource(exec, principalId, "watch", "by-source-1", { now: at(27), actor: ACTOR, by: "producer", reason: "watch_cancelled" })).toBe(0);
  });

  it("listOpenAttention follows the contract sort: safety → level rank → has actions → oldest", async () => {
    const digestNoActions = openItem({ sourceObjectId: "sort-a", level: "digest", actions: [] });
    const inboxWithActions = openItem({ sourceObjectId: "sort-b", level: "inbox", actions: [{ key: "attention.resolve" }] });
    const interruptNoActions = openItem({ sourceObjectId: "sort-c", level: "interrupt", actions: [] });
    const safetyDigest = openItem({ sourceObjectId: "sort-d", level: "digest", safetyClass: "water", actions: [] });
    // Raise deliberately out of contract order.
    await openOrBumpOrReopen(exec, interruptNoActions, { now: at(28), actor: ACTOR });
    await openOrBumpOrReopen(exec, safetyDigest, { now: at(29), actor: ACTOR });
    await openOrBumpOrReopen(exec, inboxWithActions, { now: at(30), actor: ACTOR });
    await openOrBumpOrReopen(exec, digestNoActions, { now: at(31), actor: ACTOR });

    const listed = await listOpenAttention(exec, principalId, { now: at(31) });
    const ids = listed.map((i) => i.sourceObjectId);
    expect(ids.indexOf("sort-d")).toBeLessThan(ids.indexOf("sort-c")); // safety first
    expect(ids.indexOf("sort-c")).toBeLessThan(ids.indexOf("sort-b")); // interrupt > inbox
    expect(ids.indexOf("sort-b")).toBeLessThan(ids.indexOf("sort-a")); // inbox > digest
    // a vs any same-rank tie would fall to actions then firstRaisedAt — a is last either way.
  });

  it("liveness sweep: gone resolves (by 'liveness'), live and unknown never close, unregistered outcome skips", async () => {
    await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "gone-1" }), { now: at(32), actor: ACTOR });
    await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "live-1" }), { now: at(33), actor: ACTOR });
    await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "unknown-1" }), { now: at(34), actor: ACTOR });
    await openOrBumpOrReopen(exec, openItem({ sourceType: "outcome", sourceObjectId: "outcome-1", kind: "outcome.ready", fingerprint: "outcome:o1:ready" }), { now: at(35), actor: ACTOR });

    const before = await q(`SELECT count(*)::int AS n FROM attention_items WHERE state IN ('open','seen')`);
    const sweep = await livenessSweep(exec, { now: at(36) });
    expect(sweep.checked).toBe(Number(before.rows[0]!.n));
    expect(sweep.resolved).toBe(1);

    const gone = await q(`SELECT state, resolved_by, resolution_reason FROM attention_items WHERE source_object_id = 'gone-1'`);
    expect(gone.rows[0]!.state).toBe("resolved");
    expect(gone.rows[0]!.resolved_by).toBe("liveness");
    expect(gone.rows[0]!.resolution_reason).toBe("liveness_gone");
    for (const survivor of ["live-1", "unknown-1", "outcome-1"]) {
      const rows = await q(`SELECT state FROM attention_items WHERE source_object_id = $1`, [survivor]);
      expect(rows.rows[0]!.state).toBe("open");
    }
  });

  it("GC purges only terminal rows past 30d; open rows are never age-deleted", async () => {
    await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "gc-terminal" }), { now: at(37), actor: ACTOR });
    await openOrBumpOrReopen(exec, openItem({ sourceObjectId: "gc-fresh" }), { now: at(38), actor: ACTOR });
    const terminal = await q(
      `SELECT id FROM attention_items WHERE source_object_id = 'gc-terminal'`,
    );
    await resolveAttention(exec, principalId, String(terminal.rows[0]!.id), { now: at(39), actor: ACTOR, by: "owner" });
    // Backdate the terminal row past the retention window; the fresh one stays.
    await q(`UPDATE attention_items SET resolved_at = $1::timestamptz WHERE source_object_id = 'gc-terminal'`, [
      new Date(NOW.getTime() - 31 * 86_400_000).toISOString(),
    ]);

    await livenessSweep(exec, { now: at(40) });

    expect(await q(`SELECT 1 FROM attention_items WHERE source_object_id = 'gc-terminal'`).then((r) => r.rows.length)).toBe(0);
    expect(await q(`SELECT 1 FROM attention_items WHERE source_object_id = 'gc-fresh'`).then((r) => r.rows.length)).toBe(1);
    // Aged-but-open rows are never age-deleted (the sweep's first branch only resolves).
    await q(`UPDATE attention_items SET first_raised_at = $1::timestamptz WHERE source_object_id = 'gc-fresh' AND state = 'open'`, [
      new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
    ]);
    await livenessSweep(exec, { now: at(41) });
    expect(await q(`SELECT 1 FROM attention_items WHERE source_object_id = 'gc-fresh'`).then((r) => r.rows.length)).toBe(1);
  });

  it("migration 029 round-trip: down drops the table, re-up restores it", async () => {
    const rolled = await migrateDown(db.pool, { to: "028_gmail_principal_uuid" });
    // 030 exists post-merge: reverse-lexical down rolls it back first.
    expect(rolled).toEqual(["030_attention_kind", "029_attention_items"]);
    const exists = await q(`SELECT 1 FROM information_schema.tables WHERE table_name = 'attention_items'`);
    expect(exists.rows).toHaveLength(0);

    const applied = await migrateUp(db.pool);
    expect(applied).toEqual(["029_attention_items", "030_attention_kind"]);
    const recreated = await q(`SELECT 1 FROM information_schema.tables WHERE table_name = 'attention_items'`);
    expect(recreated.rows).toHaveLength(1);
  });

  async function itemCountFor(sourceObjectId: string): Promise<number> {
    const rows = await q(`SELECT count(*)::int AS n FROM attention_items WHERE source_object_id = $1`, [sourceObjectId]);
    return Number(rows.rows[0]!.n);
  }

  async function eventCount(type: string, itemId: string): Promise<number> {
    const rows = await q(`SELECT count(*)::int AS n FROM events WHERE type = $1 AND payload->>'itemId' = $2`, [type, itemId]);
    return Number(rows.rows[0]!.n);
  }
});
