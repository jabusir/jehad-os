/**
 * U1 attention action routes (ADR-0021) — integration over buildApp against
 * an isolated migrated database (label prefix "uxb"): fail-closed matrices
 * for BOTH POST /ui/snooze and POST /ui/reopen (401 no-session / 403 bad
 * CSRF / 404 unknown-or-foreign item — /ui/action's exact status codes), the
 * snooze token → minutes map incl. the <30-min evening roll and the
 * 5..4320 ceiling rejection, and the reopen round-trip (owner-resolved and
 * owner-dismissed → open with columns cleared, zero notifications minted;
 * producer-closed, non-terminal, and >24h stay closed). /ui/action must
 * STILL 403 non-stored snooze args.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../../packages/db/tests/test-db";
import { buildApp } from "../index";
import { snoozeTokenToMinutes } from "./attention-actions";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

const USER_CREDENTIAL = randomBytes(32).toString("hex");
const OTHER_CREDENTIAL = randomBytes(32).toString("hex");

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw.join(";") : String(raw);
  const match = line.match(/jehad_session=[^;]+/);
  expect(match, `set-cookie carries jehad_session: ${line}`).not.toBeNull();
  return match![0];
}

describe("snooze time-token map (plan §2, snooze side)", () => {
  const at = (h: number, m: number): Date => new Date(2026, 9, 13, h, m, 0, 0); // server-local

  it("evening = 20:00 today server-local, with the <30-min roll to next-day 20:00", () => {
    expect(snoozeTokenToMinutes("evening", at(10, 0))).toBe(600); // 10h to 20:00
    expect(snoozeTokenToMinutes("evening", at(15, 30))).toBe(270); // 4h30m
    expect(snoozeTokenToMinutes("evening", at(19, 29))).toBe(31); // still ≥ 30 → today
    expect(snoozeTokenToMinutes("evening", at(19, 30))).toBe(30); // boundary: not < 30 → today
    // The snooze-floor artifact: closer than 30 minutes (or past 20:00) rolls.
    expect(snoozeTokenToMinutes("evening", at(19, 31))).toBe(24 * 60 + 29); // tomorrow 20:00
    expect(snoozeTokenToMinutes("evening", at(20, 10))).toBe(23 * 60 + 50); // past 20:00 → rolls
    expect(snoozeTokenToMinutes("evening", at(23, 0))).toBe(21 * 60);
  });

  it("tomorrow = 09:00 next server-local day; 1h = 60; unknown token → null (fail-closed)", () => {
    expect(snoozeTokenToMinutes("tomorrow", at(8, 0))).toBe(25 * 60);
    expect(snoozeTokenToMinutes("tomorrow", at(9, 0))).toBe(24 * 60);
    expect(snoozeTokenToMinutes("tomorrow", at(22, 0))).toBe(11 * 60);
    expect(snoozeTokenToMinutes("1h", at(0, 0))).toBe(60);
    expect(snoozeTokenToMinutes("weekend", at(12, 0))).toBeNull();
    expect(snoozeTokenToMinutes("", at(12, 0))).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("attention action routes (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let userId: string;
  let otherId: string;
  let cookie: string;
  let otherCookie: string;
  let otherCsrf: string;
  let csrf: string;
  let seq = 0;

  async function seedItem(principalId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO attention_items
         (id, principal_id, source_type, source_object_id, fingerprint, kind, state,
          title, summary, why_it_matters, evidence_refs, actions, occurrences)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'fp-1', $5, $6, $7, 'A summary', 'Because.', $8::jsonb, $9::jsonb, $10::int)`,
      [
        id,
        principalId,
        overrides.source_type ?? "watch",
        overrides.source_object_id ?? `uxb-obj-${seq += 1}`,
        overrides.kind ?? "watch.match",
        overrides.state ?? "open",
        overrides.title ?? "U1 probe",
        JSON.stringify(overrides.evidence_refs ?? []),
        JSON.stringify(overrides.actions ?? [
          { key: "attention.resolve" },
          { key: "attention.dismiss" },
          { key: "attention.snooze" },
          { key: "attention.seen" },
        ]),
        overrides.occurrences ?? 1,
      ],
    );
    return id;
  }

  async function login(credential: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/ui/session",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${encodeURIComponent(credential)}`,
    });
    expect(res.statusCode).toBe(303);
    return cookieFrom(res);
  }

  function post(url: "/ui/snooze" | "/ui/reopen" | "/ui/action", cookieHeader: string | undefined, fields: Record<string, string>) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
      },
      payload: Object.entries(fields)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&"),
    });
  }

  const itemRow = async (id: string) =>
    (await db.pool.query(
      `SELECT state, resolved_at, resolved_by, resolution_reason, snoozed_until, snooze_count, first_raised_at, occurrences
         FROM attention_items WHERE id = $1::uuid`,
      [id],
    )).rows[0];

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "uxbactions");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "u1owner", credentialHash: sha256Hex(USER_CREDENTIAL),
    });
    userId = user.id;
    const other = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "u1other", credentialHash: sha256Hex(OTHER_CREDENTIAL),
    });
    otherId = other.id;

    app = await buildApp({ db: db.pool });
    cookie = await login(USER_CREDENTIAL);
    otherCookie = await login(OTHER_CREDENTIAL);

    await seedItem(userId, { title: "csrf donor" });
    await seedItem(otherId, { title: "their csrf donor" });
    const today = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });
    expect(today.statusCode).toBe(200);
    csrf = today.body.match(/name="csrf" value="([^"]+)"/)![1];
    const otherToday = await app.inject({ method: "GET", url: "/ui", headers: { cookie: otherCookie } });
    expect(otherToday.statusCode).toBe(200);
    otherCsrf = otherToday.body.match(/name="csrf" value="([^"]+)"/)![1];
  });

  afterAll(async () => {
    await app.close();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  // ------------------------------------------------------------ /ui/snooze
  it("POST /ui/snooze fail-closed matrix: 401 no session, 403 bad CSRF, 404 foreign/unknown", async () => {
    const target = await seedItem(userId, { title: "snooze matrix" });

    const anon = await post("/ui/snooze", undefined, { itemId: target, minutes: "60" });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["content-security-policy"]).toBe(CSP);

    const noCsrf = await post("/ui/snooze", cookie, { itemId: target, minutes: "60" });
    expect(noCsrf.statusCode).toBe(403);
    const badCsrf = await post("/ui/snooze", cookie, { itemId: target, minutes: "60", csrf: `${csrf.slice(0, -2)}00` });
    expect(badCsrf.statusCode).toBe(403);
    expect(badCsrf.headers["content-security-policy"]).toBe(CSP);
    expect((await itemRow(target)).state).toBe("open"); // untouched by denied posts

    const foreign = await seedItem(otherId, { title: "not yours" });
    const foreignPost = await post("/ui/snooze", cookie, { itemId: foreign, minutes: "60", csrf });
    expect(foreignPost.statusCode).toBe(404);
    expect((await itemRow(foreign)).state).toBe("open"); // the other principal unaffected

    const unknown = await post("/ui/snooze", cookie, { itemId: randomUUID(), minutes: "60", csrf });
    expect(unknown.statusCode).toBe(404);
  });

  it("POST /ui/snooze bounds: floor, ceiling rejection, garbage, unknown preset → 400 remedy page", async () => {
    const target = await seedItem(userId, { title: "snooze bounds" });
    for (const fields of [
      { itemId: target, minutes: "4" },
      { itemId: target, minutes: "9999" },
      { itemId: target, minutes: "4321" },
      { itemId: target, minutes: "abc" },
      { itemId: target },
      { itemId: target, preset: "weekend" },
    ]) {
      const res = await post("/ui/snooze", cookie, { ...fields, csrf });
      expect(res.statusCode, `fields ${JSON.stringify(fields)}`).toBe(400);
      expect(res.headers["content-security-policy"]).toBe(CSP);
      expect(res.body).toContain("Back to Today"); // inline remedy, never a dead end
    }
    const row = await itemRow(target);
    expect(row.state).toBe("open");
    expect(row.snoozed_until).toBeNull();

    const malformed = await post("/ui/snooze", cookie, { itemId: "not-a-uuid", minutes: "60", csrf });
    expect(malformed.statusCode).toBe(400);
  });

  it("POST /ui/snooze dispatches minutes and presets; preset 1h lands ~60 minutes out", async () => {
    const before = Date.now();

    const minutesId = await seedItem(userId, { title: "snooze 90m" });
    const byMinutes = await post("/ui/snooze", cookie, { itemId: minutesId, minutes: "90", csrf });
    expect(byMinutes.statusCode).toBe(303);
    expect(byMinutes.headers.location).toBe("/ui?done=snooze");
    const minutesRow = await itemRow(minutesId);
    expect(minutesRow.state).toBe("snoozed");
    expect(Number(minutesRow.snooze_count)).toBe(1);
    const minutesUntil = new Date(minutesRow.snoozed_until as string).getTime();
    expect(minutesUntil).toBeGreaterThanOrEqual(before + 89 * 60_000);
    expect(minutesUntil).toBeLessThanOrEqual(Date.now() + 91 * 60_000);

    const hourId = await seedItem(userId, { title: "snooze 1h preset" });
    const byPreset = await post("/ui/snooze", cookie, { itemId: hourId, preset: "1h", csrf });
    expect(byPreset.statusCode).toBe(303);
    const hourUntil = new Date((await itemRow(hourId)).snoozed_until as string).getTime();
    expect(hourUntil).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(hourUntil).toBeLessThanOrEqual(Date.now() + 61 * 60_000);

    // evening/tomorrow land ON the pinned wall-clock hours (server-local;
    // ceil keeps the landing at/after the hour, sub-minute drift allowed).
    const eveningId = await seedItem(userId, { title: "snooze evening preset" });
    expect((await post("/ui/snooze", cookie, { itemId: eveningId, preset: "evening", csrf })).statusCode).toBe(303);
    const evening = new Date((await itemRow(eveningId)).snoozed_until as string);
    expect(evening.getHours()).toBe(20);
    expect(evening.getMinutes()).toBeLessThanOrEqual(1);
    expect(evening.getTime()).toBeGreaterThan(before); // today 20:00 or the rolled next-day 20:00

    const tomorrowId = await seedItem(userId, { title: "snooze tomorrow preset" });
    expect((await post("/ui/snooze", cookie, { itemId: tomorrowId, preset: "tomorrow", csrf })).statusCode).toBe(303);
    const tomorrow = new Date((await itemRow(tomorrowId)).snoozed_until as string);
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getMinutes()).toBeLessThanOrEqual(1);
    expect(tomorrow.getTime()).toBeGreaterThan(before);
    expect(tomorrow.getTime()).toBeLessThanOrEqual(before + 33 * 60 * 60_000);
  });

  // ------------------------------------------------------------ /ui/reopen
  it("POST /ui/reopen fail-closed matrix: 401 no session, 403 bad CSRF, 404 foreign/unknown, 400 malformed", async () => {
    const targetId = await seedItem(userId, { title: "reopen matrix", state: "resolved" });
    await db.pool.query(
      `UPDATE attention_items SET resolved_at = now(), resolved_by = 'owner', resolution_reason = 'handled'
        WHERE id = $1::uuid`,
      [targetId],
    );

    const anon = await post("/ui/reopen", undefined, { itemId: targetId });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["content-security-policy"]).toBe(CSP);

    const noCsrf = await post("/ui/reopen", cookie, { itemId: targetId });
    expect(noCsrf.statusCode).toBe(403);
    const badCsrf = await post("/ui/reopen", cookie, { itemId: targetId, csrf: `${csrf.slice(0, -2)}00` });
    expect(badCsrf.statusCode).toBe(403);
    expect(badCsrf.headers["content-security-policy"]).toBe(CSP);

    const foreign = await seedItem(otherId, { title: "theirs, closed", state: "resolved" });
    await db.pool.query(
      `UPDATE attention_items SET resolved_at = now(), resolved_by = 'owner', resolution_reason = 'handled'
        WHERE id = $1::uuid`,
      [foreign],
    );
    const foreignPost = await post("/ui/reopen", cookie, { itemId: foreign, csrf });
    expect(foreignPost.statusCode).toBe(404);
    expect((await itemRow(foreign)).state).toBe("resolved"); // the other principal unaffected

    // A fully authenticated foreign principal (valid session + valid CSRF of
    // their own) still 404s — scoping precedes legality, nothing leaks.
    const foreignSession = await post("/ui/reopen", otherCookie, { itemId: targetId, csrf: otherCsrf });
    expect(foreignSession.statusCode).toBe(404);

    const unknown = await post("/ui/reopen", cookie, { itemId: randomUUID(), csrf });
    expect(unknown.statusCode).toBe(404);

    const malformed = await post("/ui/reopen", cookie, { itemId: "not-a-uuid", csrf });
    expect(malformed.statusCode).toBe(400);
  });

  it("undo round-trip over the UI: owner-resolved and owner-dismissed reopen (303 ?done=reopen, columns cleared, ZERO notifications)", async () => {
    // Resolve through /ui/action, then undo through /ui/reopen.
    const resolvedId = await seedItem(userId, { title: "tap resolve then undo" });
    expect((await post("/ui/action", cookie, { itemId: resolvedId, key: "attention.resolve", args: "{}", csrf })).statusCode).toBe(303);
    expect((await itemRow(resolvedId)).state).toBe("resolved");

    const undo = await post("/ui/reopen", cookie, { itemId: resolvedId, csrf });
    expect(undo.statusCode).toBe(303);
    expect(undo.headers.location).toBe("/ui?done=reopen");
    const undone = await itemRow(resolvedId);
    expect(undone.state).toBe("open");
    expect(undone.resolved_at).toBeNull();
    expect(undone.resolved_by).toBeNull();
    expect(undone.resolution_reason).toBeNull();
    // No push: the owner is standing in the UI (ADR-0021).
    expect((await db.pool.query(
      `SELECT count(*)::int AS n FROM notifications WHERE kind = 'attention' AND source_id = $1`,
      [resolvedId],
    )).rows[0].n).toBe(0);

    // Same for a dismissal.
    const dismissedId = await seedItem(userId, { title: "tap dismiss then undo" });
    expect((await post("/ui/action", cookie, { itemId: dismissedId, key: "attention.dismiss", args: "{}", csrf })).statusCode).toBe(303);
    expect((await itemRow(dismissedId)).state).toBe("dismissed");
    expect((await post("/ui/reopen", cookie, { itemId: dismissedId, csrf })).statusCode).toBe(303);
    const undoneDismiss = await itemRow(dismissedId);
    expect(undoneDismiss.state).toBe("open");
    expect(undoneDismiss.resolved_by).toBeNull();

    // The reopened event is on the log for both.
    for (const id of [resolvedId, dismissedId]) {
      const events = await db.pool.query(
        `SELECT count(*)::int AS n FROM events WHERE type = 'attention.item.reopened' AND payload->>'itemId' = $1`,
        [id],
      );
      expect(Number(events.rows[0].n)).toBe(1);
    }
  });

  it("POST /ui/reopen rejects producer-closed, non-terminal, and >24h-stale items with 400 remedy pages", async () => {
    // Producer-closed: machine truth is never owner-overridden.
    const producerId = await seedItem(userId, { title: "producer closed", state: "resolved" });
    await db.pool.query(
      `UPDATE attention_items SET resolved_at = now(), resolved_by = 'producer', resolution_reason = 'outcome_completed'
        WHERE id = $1::uuid`,
      [producerId],
    );
    const producerPost = await post("/ui/reopen", cookie, { itemId: producerId, csrf });
    expect(producerPost.statusCode).toBe(400);
    expect(producerPost.body).toContain("Back to Today");
    expect((await itemRow(producerId)).state).toBe("resolved");

    // Non-terminal: open items are not undo targets.
    const openId = await seedItem(userId, { title: "still open" });
    expect((await post("/ui/reopen", cookie, { itemId: openId, csrf })).statusCode).toBe(400);
    expect((await itemRow(openId)).state).toBe("open");

    // Past the 24h window: a closure that old is history.
    const staleId = await seedItem(userId, { title: "stale close", state: "resolved" });
    await db.pool.query(
      `UPDATE attention_items SET resolved_at = now() - interval '25 hours', resolved_by = 'owner', resolution_reason = 'handled'
        WHERE id = $1::uuid`,
      [staleId],
    );
    expect((await post("/ui/reopen", cookie, { itemId: staleId, csrf })).statusCode).toBe(400);
    expect((await itemRow(staleId)).state).toBe("resolved");
  });

  // ------------------------------------------------------- /ui/action gate
  it("/ui/action still 403s non-stored snooze args (registry-and-item gate unchanged)", async () => {
    const target = await seedItem(userId, {
      title: "no snooze stored",
      actions: [{ key: "attention.resolve" }],
    });
    const forged = await post("/ui/action", cookie, {
      itemId: target, key: "attention.snooze", args: JSON.stringify({ minutes: 30 }), csrf,
    });
    expect(forged.statusCode).toBe(403);
    expect((await itemRow(target)).state).toBe("open");
    expect((await itemRow(target)).snoozed_until).toBeNull();
  });
});
