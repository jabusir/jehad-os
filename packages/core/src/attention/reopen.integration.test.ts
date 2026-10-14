// Owner-initiated attention reopen — the undo round-trip (ADR-0021; Today UX
// overhaul Lane B, plan §3 U1.1). Integration against an isolated migrated
// database (label prefix "uxb"): legal reopen of owner-resolved AND
// owner-dismissed items inside the 24h window (state open, resolution columns
// cleared, additive event recorded, ZERO delivery rows minted — the ADR-0021
// no-push decision), rejection past 24h, rejection from non-terminal states,
// rejection of producer/liveness-closed items, and fail-closed principal
// scoping. Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  AttentionReopenError,
  dismissAttention,
  listOpenAttention,
  markSeen,
  openOrBumpOrReopen,
  reopenAttentionByOwner,
  resolveAttention,
  resolveAttentionBySource,
  snoozeAttention,
  type AttentionDb,
} from "./service.js";
import type { OpenAttentionInput } from "./types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// Mon 2026-09-21 10:00 PDT — a fixed clock for window arithmetic.
const NOW = new Date("2026-09-21T17:00:00.000Z");
const OWNER_ACTOR = "user:jehad-owner";

describe.skipIf(TEST_DATABASE_URL === undefined)("reopenAttentionByOwner (ADR-0021)", () => {
  let db: IsolatedDb;
  let principalId: string;
  let seq = 0;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "uxbreopen");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'jehad-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

  function openItem(overrides: Partial<OpenAttentionInput> = {}): OpenAttentionInput {
    return {
      principalId,
      sourceType: "watch",
      sourceObjectId: `uxb-obj-${seq += 1}`,
      fingerprint: "fp-1",
      kind: "watch.match",
      level: "inbox",
      title: "Undo probe",
      summary: "Mis-tapped terminal action.",
      whyItMatters: "Owner wants it back.",
      actions: [{ key: "attention.resolve" }, { key: "attention.dismiss" }],
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

  async function attentionNotificationCount(itemId: string): Promise<number> {
    const rows = await q(
      `SELECT count(*)::int AS n FROM notifications WHERE kind = 'attention' AND source_id = $1`,
      [itemId],
    );
    return Number(rows.rows[0]!.n);
  }

  it("catalog pin: attention.item.reopened is the 43rd v1 member", async () => {
    // Runtime build-blocker assertion mirrored here so the DB suite cannot
    // run against a kernel that lacks the event type.
    const { EVENT_CATALOG_V1 } = await import("../events/catalog.js");
    expect(EVENT_CATALOG_V1).toContain("attention.item.reopened");
    expect(EVENT_CATALOG_V1.length).toBe(43);
  });

  it("undo round-trip: owner-resolved → reopen (open, columns cleared, event + audit with user:<name>, ZERO notifications)", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem(), { now: at(0), actor: OWNER_ACTOR });
    const resolved = await resolveAttention(exec, principalId, opened.item.id, {
      now: at(1), actor: OWNER_ACTOR, by: "owner", reason: "handled",
    });
    expect(resolved!.state).toBe("resolved");

    const reopened = await reopenAttentionByOwner(exec, principalId, opened.item.id, { now: at(2), actor: OWNER_ACTOR });
    expect(reopened).not.toBeNull();
    expect(reopened!.state).toBe("open");
    // Resolution columns cleared...
    expect(reopened!.resolvedAt).toBeNull();
    expect(reopened!.resolvedBy).toBeNull();
    expect(reopened!.resolutionReason).toBeNull();
    // ...while the raise-time identity is untouched, and undo is NOT a new
    // occurrence (§1.3 counts producer occurrences only).
    expect(reopened!.firstRaisedAt.toISOString()).toBe(opened.item.firstRaisedAt.toISOString());
    expect(reopened!.occurrences).toBe(1);

    // Back on the action list where the owner expects it.
    const listed = await listOpenAttention(exec, principalId, { now: at(2) });
    expect(listed.map((i) => i.id)).toContain(opened.item.id);

    // The additive event, content-free payload (ids + priorState only).
    const events = await q(
      `SELECT payload FROM events WHERE type = 'attention.item.reopened' AND payload->>'itemId' = $1`,
      [opened.item.id],
    );
    expect(events.rows).toHaveLength(1);
    const payload = events.rows[0]!.payload as Record<string, unknown>;
    expect(payload.priorState).toBe("resolved");
    expect(Object.keys(payload).sort()).toEqual(
      ["itemId", "principalId", "priorState", "sourceObjectId", "sourceType"],
    );

    // Provenance: the audit row carries the user:<name> actor.
    const audits = await q(
      `SELECT actor, action FROM audit_log WHERE action = 'attention.reopened_by_owner' AND outputs_ref LIKE $1`,
      [`%${opened.item.id}%`],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]!.actor).toBe("user:jehad-owner");

    // ADR-0021 NO-PUSH — the named-call acceptance: reopen delivers nothing.
    expect(await attentionNotificationCount(opened.item.id)).toBe(0);
    const stamps = await q(
      `SELECT delivery_attempts, last_delivery_attempt_at, last_delivered_at FROM attention_items WHERE id = $1::uuid`,
      [opened.item.id],
    );
    expect(Number(stamps.rows[0]!.delivery_attempts)).toBe(0);
    expect(stamps.rows[0]!.last_delivery_attempt_at).toBeNull();
    expect(stamps.rows[0]!.last_delivered_at).toBeNull();
  });

  it("undo round-trip: owner-dismissed → reopen inside the window", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem(), { now: at(3), actor: OWNER_ACTOR });
    const dismissed = await dismissAttention(exec, principalId, opened.item.id, { now: at(4), actor: OWNER_ACTOR });
    expect(dismissed!.state).toBe("dismissed");
    expect(dismissed!.resolvedBy).toBe("owner");

    const reopened = await reopenAttentionByOwner(exec, principalId, opened.item.id, { now: at(5), actor: OWNER_ACTOR });
    expect(reopened!.state).toBe("open");
    expect(reopened!.resolvedAt).toBeNull();
    expect(reopened!.resolvedBy).toBeNull();
    expect(reopened!.resolutionReason).toBeNull();
    const events = await q(
      `SELECT payload FROM events WHERE type = 'attention.item.reopened' AND payload->>'itemId' = $1`,
      [opened.item.id],
    );
    expect(events.rows).toHaveLength(1);
    expect((events.rows[0]!.payload as Record<string, unknown>).priorState).toBe("dismissed");
    expect(await attentionNotificationCount(opened.item.id)).toBe(0);
  });

  it("rejected past the 24h window (state untouched, no event)", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem(), { now: at(6), actor: OWNER_ACTOR });
    await resolveAttention(exec, principalId, opened.item.id, { now: at(7), actor: OWNER_ACTOR, by: "owner", reason: "done" });
    // Exactly 24h later is still inside the window (<= is legal).
    const boundary = await reopenAttentionByOwner(exec, principalId, opened.item.id, { now: at(7 + 24 * 60), actor: OWNER_ACTOR });
    expect(boundary!.state).toBe("open");
    // Close again; one minute past the window is history.
    await resolveAttention(exec, principalId, opened.item.id, { now: at(7 + 24 * 60 + 1), actor: OWNER_ACTOR, by: "owner", reason: "done" });
    await expect(
      reopenAttentionByOwner(exec, principalId, opened.item.id, { now: at(7 + 24 * 60 + 1 + 24 * 60 + 1), actor: OWNER_ACTOR }),
    ).rejects.toThrow(AttentionReopenError);
    const row = (await q(`SELECT state, resolved_by FROM attention_items WHERE id = $1::uuid`, [opened.item.id])).rows[0];
    expect(row.state).toBe("resolved");
    expect(row.resolved_by).toBe("owner");
    const events = await q(
      `SELECT count(*)::int AS n FROM events WHERE type = 'attention.item.reopened' AND payload->>'itemId' = $1`,
      [opened.item.id],
    );
    expect(Number(events.rows[0]!.n)).toBe(1); // only the legal boundary reopen
  });

  it("rejected from non-terminal states (open, seen, snoozed)", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem(), { now: at(10), actor: OWNER_ACTOR });
    await expect(
      reopenAttentionByOwner(exec, principalId, opened.item.id, { now: at(11), actor: OWNER_ACTOR }),
    ).rejects.toThrow(/resolved or dismissed/);
    await markSeen(exec, principalId, opened.item.id, { now: at(11), actor: OWNER_ACTOR });
    await expect(
      reopenAttentionByOwner(exec, principalId, opened.item.id, { now: at(12), actor: OWNER_ACTOR }),
    ).rejects.toThrow(AttentionReopenError);
    await snoozeAttention(exec, principalId, opened.item.id, 30, { now: at(12), actor: OWNER_ACTOR });
    await expect(
      reopenAttentionByOwner(exec, principalId, opened.item.id, { now: at(13), actor: OWNER_ACTOR }),
    ).rejects.toThrow(AttentionReopenError);
    const row = (await q(`SELECT state FROM attention_items WHERE id = $1::uuid`, [opened.item.id])).rows[0];
    expect(row.state).toBe("snoozed");
  });

  it("rejected for producer- and liveness-closed items — owner undo never overrides machine truth", async () => {
    const producer = await openOrBumpOrReopen(exec, openItem(), { now: at(14), actor: OWNER_ACTOR });
    await resolveAttentionBySource(exec, principalId, "watch", producer.item.sourceObjectId, {
      now: at(15), actor: "system/outcome-producer", by: "producer", reason: "outcome_completed",
    });
    await expect(
      reopenAttentionByOwner(exec, principalId, producer.item.id, { now: at(16), actor: OWNER_ACTOR }),
    ).rejects.toThrow(/only owner-closed items/);

    const liveness = await openOrBumpOrReopen(exec, openItem(), { now: at(17), actor: OWNER_ACTOR });
    await resolveAttentionBySource(exec, principalId, "watch", liveness.item.sourceObjectId, {
      now: at(18), actor: "system/attention-liveness", by: "liveness", reason: "liveness_gone",
    });
    await expect(
      reopenAttentionByOwner(exec, principalId, liveness.item.id, { now: at(19), actor: OWNER_ACTOR }),
    ).rejects.toThrow(AttentionReopenError);
  });

  it("fail-closed principal scoping: a foreign principal gets null, the owner's row untouched", async () => {
    const opened = await openOrBumpOrReopen(exec, openItem(), { now: at(20), actor: OWNER_ACTOR });
    await resolveAttention(exec, principalId, opened.item.id, { now: at(21), actor: OWNER_ACTOR, by: "owner", reason: "done" });
    expect(
      await reopenAttentionByOwner(exec, randomUUID(), opened.item.id, { now: at(22), actor: OWNER_ACTOR }),
    ).toBeNull();
    const row = (await q(`SELECT state FROM attention_items WHERE id = $1::uuid`, [opened.item.id])).rows[0];
    expect(row.state).toBe("resolved");
    expect(await reopenAttentionByOwner(exec, principalId, randomUUID(), { now: at(22), actor: OWNER_ACTOR })).toBeNull();
  });
});
