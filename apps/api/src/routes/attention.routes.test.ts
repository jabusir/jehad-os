/**
 * Attention JSON API — integration (bearer auth via the instance hook, USER
 * guard, fail-closed 404s, snooze bounds, feedback landing in the existing
 * feedback table).
 *
 */

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../../packages/db/tests/test-db";
import { buildApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;



// ---- end test-only stand-ins ----------------------------------------------

const USER_CREDENTIAL = randomBytes(32).toString("hex");
const OTHER_CREDENTIAL = randomBytes(32).toString("hex");

describe.skipIf(!TEST_DATABASE_URL)("attention routes (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let userId: string;
  let otherId: string;
  let openId: string;
  let snoozedId: string;

  const auth = { authorization: `Bearer ${USER_CREDENTIAL}` };
  const otherAuth = { authorization: `Bearer ${OTHER_CREDENTIAL}` };

  async function seedItem(principalId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO attention_items
         (id, principal_id, source_type, source_object_id, fingerprint, kind, state,
          title, summary, why_it_matters, evidence_refs, actions)
       VALUES ($1::uuid, $2::uuid, 'watch', $3, 'fp-1', 'watch.match', 'open',
               'A title', 'A summary', 'Because.', '[]'::jsonb, '[]'::jsonb)`,
      [id, principalId, `obj-${randomUUID()}`],
    );
    if (Object.keys(overrides).length > 0) {
      const sets = Object.keys(overrides).map((k, i) => `${k} = $${i + 2}`);
      await db.pool.query(
        `UPDATE attention_items SET ${sets.join(", ")} WHERE id = $1::uuid`,
        [id, ...Object.values(overrides)],
      );
    }
    return id;
  }

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "apiattention");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "josctl", credentialHash: sha256Hex(USER_CREDENTIAL),
    });
    userId = user.id;
    const other = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "second", credentialHash: sha256Hex(OTHER_CREDENTIAL),
    });
    otherId = other.id;
    openId = await seedItem(userId);
    snoozedId = await seedItem(userId, {
      state: "snoozed", snoozed_until: new Date(Date.now() + 3600_000),
    });
    app = await buildApp({ db: db.pool });
  });

  afterAll(async () => {
    await app.close();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("GET /attention lists open + snoozed for the calling principal only", async () => {
    const res = await app.inject({ method: "GET", url: "/attention", headers: auth });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((i: { id: string }) => i.id);
    expect(ids).toContain(openId);
    expect(ids).toContain(snoozedId);
    // principal isolation: the other principal's items never appear
    const foreignId = await seedItem(otherId);
    const again = await app.inject({ method: "GET", url: "/attention", headers: auth });
    expect(again.json().items.map((i: { id: string }) => i.id)).not.toContain(foreignId);
  });

  it("resolve: 200 + row resolved; repeat → 404; foreign → 404; malformed → 400", async () => {
    const res = await app.inject({ method: "POST", url: `/attention/${openId}/resolve`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().item).toMatchObject({ id: openId, state: "resolved", resolvedBy: "owner" });
    const row = (await db.pool.query("SELECT state, resolved_by FROM attention_items WHERE id = $1::uuid", [openId])).rows[0];
    expect(row.state).toBe("resolved");

    // ADR-0018 §5.6: an already-terminal resolve is an honest no-op (200,
    // row unchanged), not a denial — only foreign/unknown → 404.
    const repeat = await app.inject({ method: "POST", url: `/attention/${openId}/resolve`, headers: auth });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().item).toMatchObject({ id: openId, state: "resolved" });

    const foreign = await app.inject({ method: "POST", url: `/attention/${snoozedId}/resolve`, headers: otherAuth });
    expect(foreign.statusCode).toBe(404);

    const bad = await app.inject({ method: "POST", url: "/attention/not-a-uuid/resolve", headers: auth });
    expect(bad.statusCode).toBe(400);

    const unknown = await app.inject({ method: "POST", url: `/attention/${randomUUID()}/resolve`, headers: auth });
    expect(unknown.statusCode).toBe(404);
  });

  it("dismiss and seen update rows principal-scoped", async () => {
    const a = await seedItem(userId);
    const b = await seedItem(userId);
    const dismiss = await app.inject({ method: "POST", url: `/attention/${a}/dismiss`, headers: auth });
    expect(dismiss.statusCode).toBe(200);
    expect((await db.pool.query("SELECT state FROM attention_items WHERE id = $1::uuid", [a])).rows[0].state).toBe("dismissed");

    const seen = await app.inject({ method: "POST", url: `/attention/${b}/seen`, headers: auth });
    expect(seen.statusCode).toBe(200);
    const seenRow = (await db.pool.query("SELECT state, seen_at FROM attention_items WHERE id = $1::uuid", [b])).rows[0];
    expect(seenRow.state).toBe("seen");
    expect(seenRow.seen_at).not.toBeNull();

    // seen ≠ resolved: still listed as seen, never silently resolved
    expect((await app.inject({ method: "GET", url: "/attention", headers: auth })).json().items
      .some((i: { id: string; state: string }) => i.id === b && i.state === "seen")).toBe(true);
  });

  it("snooze validates minutes bounds 5..4320 and writes snoozed_until", async () => {
    const id = await seedItem(userId);
    const ok = await app.inject({
      method: "POST", url: `/attention/${id}/snooze`, headers: auth, payload: { minutes: 7 },
    });
    expect(ok.statusCode).toBe(200);
    const row = (await db.pool.query("SELECT state, snoozed_until, snooze_count FROM attention_items WHERE id = $1::uuid", [id])).rows[0];
    expect(row.state).toBe("snoozed");
    expect(row.snoozed_until).not.toBeNull();
    expect(Number(row.snooze_count)).toBe(1);

    for (const minutes of [4, 4321, "abc", undefined]) {
      const bad = await app.inject({
        method: "POST", url: `/attention/${id}/snooze`, headers: auth,
        payload: minutes === undefined ? {} : { minutes },
      });
      expect(bad.statusCode, `minutes=${String(minutes)}`).toBe(400);
    }
  });

  it("feedback lands in the feedback table as item_type='attention_item', principal-scoped", async () => {
    const id = await seedItem(userId);
    const res = await app.inject({
      method: "POST", url: `/attention/${id}/feedback`, headers: auth, payload: { verdict: "useful" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().feedback).toMatchObject({ itemType: "attention_item", itemId: id, verdict: "useful" });
    const rows = (await db.pool.query(
      "SELECT item_type, item_id, verdict, created_by FROM feedback WHERE item_type = 'attention_item' AND item_id = $1",
      [id],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].created_by).toBe(userId);

    // idempotent re-tap inside the dedupe window → still one row
    await app.inject({ method: "POST", url: `/attention/${id}/feedback`, headers: auth, payload: { verdict: "useful" } });
    expect((await db.pool.query("SELECT 1 FROM feedback WHERE item_id = $1", [id])).rows).toHaveLength(1);

    const badVerdict = await app.inject({
      method: "POST", url: `/attention/${id}/feedback`, headers: auth, payload: { verdict: "banana" },
    });
    expect(badVerdict.statusCode).toBe(400);

    // fail-closed: another principal's item id is not feedbackable either
    const foreign = await app.inject({
      method: "POST", url: `/attention/${snoozedId}/feedback`, headers: otherAuth, payload: { verdict: "noise" },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("unauthenticated requests are 401; harness principals are 403", async () => {
    const harnessCredential = randomBytes(32).toString("hex");
    await upsertPrincipalCredential(db.pool, {
      type: "harness", name: "openclaw", credentialHash: sha256Hex(harnessCredential),
    });
    const anon = await app.inject({ method: "GET", url: "/attention" });
    expect(anon.statusCode).toBe(401);

    const harness = await app.inject({
      method: "GET", url: "/attention", headers: { authorization: `Bearer ${harnessCredential}` },
    });
    expect(harness.statusCode).toBe(403);
    expect(harness.json()).toEqual({ error: "forbidden" });
  });
});
