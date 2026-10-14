/**
 * Today UI — integration (session paste → cookie, CSRF, XSS escaping,
 * principal isolation, registry-dispatched actions, outcome view).
 *
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../../packages/db/tests/test-db";
import { issueSession } from "../session";
import { buildApp } from "../index";
import { scriptTags, TODAY_CSP, TODAY_SCRIPT } from "./ui-script";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("ADR-0022 CSP integrity (no DB — runs in every environment)", () => {
  it("the hash embedded in TODAY_CSP equals an independent sha256(TODAY_SCRIPT) — drift fails the build, not production", () => {
    const embedded = TODAY_CSP.match(/'sha256-([A-Za-z0-9+/=]+)'/);
    expect(embedded, "TODAY_CSP must pin exactly one sha256 script hash").not.toBeNull();
    expect(embedded![1]).toBe(createHash("sha256").update(TODAY_SCRIPT).digest("base64"));
  });

  it("TODAY_CSP is the exact amended string (ADR-0022): no unsafe-inline for scripts, connect-src/img-src present", () => {
    const hash = createHash("sha256").update(TODAY_SCRIPT).digest("base64");
    expect(TODAY_CSP).toBe(
      `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; ` +
        `connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'`,
    );
  });

  it("scriptTags() embeds TODAY_SCRIPT exactly once plus icon/meta identity", () => {
    const tags = scriptTags();
    expect(tags.split("<script>").length - 1).toBe(1);
    expect(tags).toContain(`<script>${TODAY_SCRIPT}</script>`);
    expect(tags).toContain(`<link rel="apple-touch-icon" href="/ui/icon.svg">`);
    expect(tags).toContain(`<meta name="apple-mobile-web-app-capable" content="yes">`);
  });

  it("TODAY_SCRIPT never contains markup-breaking sequences", () => {
    expect(TODAY_SCRIPT).not.toContain("</script");
    expect(TODAY_SCRIPT).not.toContain("<!--");
    expect(TODAY_SCRIPT.length).toBeGreaterThan(0);
  });
});



// ---- end test-only stand-ins ----------------------------------------------

const USER_CREDENTIAL = randomBytes(32).toString("hex");
const OTHER_CREDENTIAL = randomBytes(32).toString("hex");

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw.join(";") : String(raw);
  const match = line.match(/jehad_session=[^;]+/);
  expect(match, `set-cookie carries jehad_session: ${line}`).not.toBeNull();
  return match![0];
}

describe.skipIf(!TEST_DATABASE_URL)("today ui routes (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let userId: string;
  let otherId: string;
  let cookie: string;
  let otherCookie: string;
  let csrf: string;
  const XSS_TITLE = `<script>alert(1)</script>`;
  const XSS_WHY = `<img src=x onerror="alert(2)">`;

  async function seedItem(principalId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO attention_items
         (id, principal_id, source_type, source_object_id, fingerprint, kind, state,
          title, summary, why_it_matters, evidence_refs, actions, occurrences)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'fp-1', $5, $6, $7, 'A summary', $8, $9::jsonb, $10::jsonb, $11::int)`,
      [
        id,
        principalId,
        overrides.source_type ?? "watch",
        overrides.source_object_id ?? `obj-${randomUUID()}`,
        overrides.kind ?? "watch.match",
        overrides.state ?? "open",
        overrides.title ?? "Safe title",
        overrides.why_it_matters ?? "Because.",
        JSON.stringify(overrides.evidence_refs ?? []),
        JSON.stringify(
          overrides.actions ?? [
            { key: "attention.resolve" },
            { key: "attention.dismiss" },
            { key: "attention.snooze" },
            { key: "attention.seen" },
          ],
        ),
        overrides.occurrences ?? 1,
      ],
    );
    return id;
  }

  async function seedOutcome(principalId: string, ref: string, title: string): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO outcomes (id, principal_id, ref, title, directive, status)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'do the thing', 'waiting_user')`,
      [id, principalId, ref, title],
    );
    await db.pool.query(
      `INSERT INTO outcome_criteria (id, outcome_id, ordinal, criterion, status, verified_at)
       VALUES ($1::uuid, $2::uuid, 1, 'The thing is done', 'verified', now())`,
      [randomUUID(), id],
    );
    await db.pool.query(
      `INSERT INTO outcome_criteria (id, outcome_id, ordinal, criterion)
       VALUES ($1::uuid, $2::uuid, 2, 'The other thing is done')`,
      [randomUUID(), id],
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

  function actionPost(cookieHeader: string, fields: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/ui/action",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader },
      payload: Object.entries(fields)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&"),
    });
  }

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "apitoday");
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

    await seedItem(userId, { title: XSS_TITLE, why_it_matters: XSS_WHY });
    await seedItem(userId, { title: "Seen thing", state: "seen", occurrences: 2 });
    const outcomeId = await seedOutcome(userId, "ABC7", `<b>Delegated</b> work`);
    await seedItem(userId, {
      title: "Outcome ready",
      source_type: "outcome",
      source_object_id: outcomeId,
      kind: "outcome.ready",
      evidence_refs: [{ type: "outcome", id: "ABC7" }],
      actions: [
        { key: "outcome.open", args: { ref: "ABC7" } },
        { key: "attention.resolve" },
        { key: "attention.snooze" },
      ],
    });

    app = await buildApp({ db: db.pool });
    cookie = await login(USER_CREDENTIAL);
    otherCookie = await login(OTHER_CREDENTIAL);

    const today = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });
    expect(today.statusCode).toBe(200);
    csrf = today.body.match(/name="csrf" value="([^"]+)"/)![1];
  });

  afterAll(async () => {
    await app.close();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  // ------------------------------------------------------------------ auth
  it("no session → 401 fail-closed page (recovery link, never a credential prompt); bad token → 401; good token → flagged cookie", async () => {
    const anon = await app.inject({ method: "GET", url: "/ui" });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["content-security-policy"]).toBe(TODAY_CSP);
    // W1.2: the normal path fails closed; the credential paste is recovery-only
    expect(anon.body).toContain("/ui/recovery");
    expect(anon.body).not.toContain(`action="/ui/session"`);
    expect(anon.body).toContain(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
    const recovery = await app.inject({ method: "GET", url: "/ui/recovery" });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.body).toContain(`action="/ui/session"`);

    const bad = await app.inject({
      method: "POST", url: "/ui/session",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "token=wrong-credential",
    });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({
      method: "POST", url: "/ui/session",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${encodeURIComponent(USER_CREDENTIAL)}`,
    });
    expect(good.statusCode).toBe(303);
    const rawCookie = String(good.headers["set-cookie"]);
    expect(rawCookie).toContain("jehad_session=");
    expect(rawCookie).toContain("HttpOnly");
    expect(rawCookie).toContain("Secure");
    expect(rawCookie).toContain("SameSite=Strict");
    expect(rawCookie).toContain("Path=/");
  });

  it("garbage, forged, and expired cookies are 401; machine credentials never mint sessions", async () => {
    const garbage = await app.inject({
      method: "GET", url: "/ui", headers: { cookie: "jehad_session=garbage" },
    });
    expect(garbage.statusCode).toBe(401);

    const forged = await app.inject({
      method: "GET", url: "/ui", headers: { cookie: "jehad_session=MA==|99999999999999|deadbeef" },
    });
    expect(forged.statusCode).toBe(401);

    const expiredCookie = issueSession(
      userId, sha256Hex(USER_CREDENTIAL), new Date(Date.now() - 25 * 3600_000),
    ).cookie.match(/jehad_session=[^;]+/)![0];
    const expired = await app.inject({
      method: "GET", url: "/ui", headers: { cookie: expiredCookie },
    });
    expect(expired.statusCode).toBe(401);

    const harnessCredential = randomBytes(32).toString("hex");
    await upsertPrincipalCredential(db.pool, {
      type: "harness", name: "openclaw", credentialHash: sha256Hex(harnessCredential),
    });
    const harness = await app.inject({
      method: "POST", url: "/ui/session",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${encodeURIComponent(harnessCredential)}`,
    });
    expect(harness.statusCode).toBe(401);
  });

  // ------------------------------------------------------------------ today
  it("GET /ui renders Today sections, metadata, and registry labels", async () => {
    const res = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(TODAY_CSP);
    expect(res.body).toContain("TODAY");
    expect(res.body).toContain("Needs you");
    expect(res.body).toContain("Snoozed");
    expect(res.body).toContain("Seen thing");           // seen stays in Needs you
    expect(res.body).toContain("Outcome ABC7");          // evidence text (outcome ref)
    expect(res.body).toContain("×2 occurrences");
    expect(res.body).toContain("Open outcome");          // registry label
    expect(res.body).toContain("Resolve");
    expect(res.body).toMatch(/id="item-[0-9a-f-]{36}"/); // deep-link anchor
  });

  it("XSS: external item text is fully escaped in Today and the outcome view", async () => {
    const res = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });
    // ADR-0022: exactly ONE script tag — the hash-pinned enhancement script;
    // hostile payloads must never add a second (or survive raw).
    expect(res.body.split("<script").length - 1).toBe(1);
    expect(res.body).not.toContain("<script>alert");
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(res.body).not.toContain("<img");
    expect(res.body).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");

    const view = await app.inject({ method: "GET", url: "/ui/outcome/ABC7", headers: { cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.body.split("<script").length - 1).toBe(1);
    expect(view.body).not.toContain("<b>Delegated</b>");
    expect(view.body).toContain("&lt;b&gt;Delegated&lt;/b&gt; work");
  });

  // ---------------------------------------------------------------- lane D
  it("ADR-0022: every Today response carries TODAY_CSP and serves the pinned script exactly once", async () => {
    const surfaces = [
      { method: "GET", url: "/ui", headers: { cookie } },
      { method: "GET", url: "/ui/delegate", headers: { cookie } },
      { method: "GET", url: "/ui/missions", headers: { cookie } },
      { method: "GET", url: "/ui/outcome/ABC7", headers: { cookie } },
      { method: "GET", url: "/ui" }, // 401 fail-closed page carries it too
    ] as const;
    for (const surface of surfaces) {
      const res = await app.inject({ ...surface });
      expect(res.headers["content-security-policy"], surface.url).toBe(TODAY_CSP);
      expect(res.body.split("<script>").length - 1, surface.url).toBe(1);
      expect(res.body).toContain(TODAY_SCRIPT);
    }
  });

  it("GET /ui/icon.svg is a reachable public path serving a small static SVG", async () => {
    const anon = await app.inject({ method: "GET", url: "/ui/icon.svg" });
    expect(anon.statusCode).toBe(200); // no cookie, no bearer — public path
    expect(anon.headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
    expect(anon.headers["cache-control"]).toBe("public, max-age=604800");
    expect(anon.body.startsWith("<svg")).toBe(true);
    expect(Buffer.byteLength(anon.body, "utf8")).toBeLessThanOrEqual(1024);
    expect(anon.body).not.toContain("<script");
    expect(anon.body).not.toMatch(/(src|href)\s*=/); // zero external/remote references

    // public path means NO auth gate: garbage session never blocks it either
    const gated = await app.inject({
      method: "GET", url: "/ui/icon.svg", headers: { cookie: "jehad_session=garbage" },
    });
    expect(gated.statusCode).toBe(200);
    expect(gated.body).toBe(anon.body);
  });

  it("no-JS parity: stripping the enhancement script leaves every functional form intact", async () => {
    const stripScript = (html: string): string => html.replace(/<script>[\s\S]*?<\/script>/, "");
    const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

    const today = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });
    const todayStripped = stripScript(today.body);
    expect(count(todayStripped, /<script/g)).toBe(0);
    expect(count(todayStripped, /<form method="post" action="\/ui\/action"/g)).toBe(
      count(today.body, /<form method="post" action="\/ui\/action"/g),
    );
    expect(count(todayStripped, /name="csrf" value="[^"]+"/g)).toBe(
      count(today.body, /name="csrf" value="[^"]+"/g),
    );
    expect(count(todayStripped, /<button type="submit">/g)).toBe(
      count(today.body, /<button type="submit">/g),
    );

    const delegate = await app.inject({ method: "GET", url: "/ui/delegate", headers: { cookie } });
    const delegateStripped = stripScript(delegate.body);
    expect(delegateStripped).toContain(`<form method="post" action="/ui/delegate">`);
    expect(count(delegateStripped, /<form method="post"/g)).toBe(
      count(delegate.body, /<form method="post"/g),
    );
    expect(count(delegateStripped, /<input[^>]+maxlength="2000"/g)).toBe(
      count(delegate.body, /<input[^>]+maxlength="2000"/g),
    );

    const recovery = await app.inject({ method: "GET", url: "/ui/recovery" });
    const recoveryStripped = stripScript(recovery.body);
    expect(recoveryStripped).toContain(`<form method="post" action="/ui/session">`);
  });

  // ------------------------------------------------------------------ csrf
  it("POST /ui/action requires the session CSRF token (missing/wrong → 403)", async () => {
    const target = (await db.pool.query(
      "SELECT id FROM attention_items WHERE title = 'Seen thing'",
    )).rows[0].id as string;

    const missing = await actionPost(cookie, {
      itemId: target, key: "attention.resolve", args: "{}",
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.headers["content-security-policy"]).toBe(TODAY_CSP);

    const wrong = await actionPost(cookie, {
      itemId: target, key: "attention.resolve", args: "{}", csrf: `${csrf.slice(0, -2)}00`,
    });
    expect(wrong.statusCode).toBe(403);

    const row = (await db.pool.query("SELECT state FROM attention_items WHERE id = $1::uuid", [target])).rows[0];
    expect(row.state).toBe("seen"); // untouched by both denied posts
  });

  it("actions dispatch through the registry and update rows; bad key/args → 400", async () => {
    const resolveId = await seedItem(userId, { title: "Resolve me" });
    const resolved = await actionPost(cookie, {
      itemId: resolveId, key: "attention.resolve", args: "{}", csrf,
    });
    expect(resolved.statusCode).toBe(303);
    expect(resolved.headers.location).toBe("/ui");
    expect((await db.pool.query("SELECT state FROM attention_items WHERE id = $1::uuid", [resolveId])).rows[0].state).toBe("resolved");

    const dismissId = await seedItem(userId, { title: "Dismiss me" });
    expect((await actionPost(cookie, { itemId: dismissId, key: "attention.dismiss", args: "{}", csrf })).statusCode).toBe(303);
    expect((await db.pool.query("SELECT state FROM attention_items WHERE id = $1::uuid", [dismissId])).rows[0].state).toBe("dismissed");

    const seenId = await seedItem(userId, { title: "Seen me" });
    expect((await actionPost(cookie, { itemId: seenId, key: "attention.seen", args: "{}", csrf })).statusCode).toBe(303);
    expect((await db.pool.query("SELECT state FROM attention_items WHERE id = $1::uuid", [seenId])).rows[0].state).toBe("seen");

    const snoozeId = await seedItem(userId, {
      title: "Snooze me", actions: [{ key: "attention.snooze", args: { minutes: 120 } }],
    });
    expect((await actionPost(cookie, {
      itemId: snoozeId, key: "attention.snooze", args: JSON.stringify({ minutes: 120 }), csrf,
    })).statusCode).toBe(303);
    const snoozed = (await db.pool.query(
      "SELECT state, snoozed_until, snooze_count FROM attention_items WHERE id = $1::uuid", [snoozeId],
    )).rows[0];
    expect(snoozed.state).toBe("snoozed");
    expect(snoozed.snoozed_until).not.toBeNull();
    expect(Number(snoozed.snooze_count)).toBe(1);

    // W1.1 finding 5: registry-valid keys that the ITEM does not store fail
    // closed; stored-key with mismatched args fails closed too.
    const forged = await seedItem(userId, {
      title: "Forge target",
      actions: [
        { key: "attention.feedback", args: { verdict: "noise" } },
        { key: "attention.snooze" },
      ],
    });
    // registry-valid, not stored on THIS item → fail closed
    expect((await actionPost(cookie, { itemId: forged, key: "attention.dismiss", args: "{}", csrf })).statusCode).toBe(403);
    expect((await actionPost(cookie, { itemId: forged, key: "attention.feedback", args: JSON.stringify({ verdict: "interruptive" }), csrf })).statusCode).toBe(403);
    // stored key, args the item never carried → fail closed
    expect((await actionPost(cookie, { itemId: forged, key: "attention.feedback", args: JSON.stringify({ verdict: "useful" }), csrf })).statusCode).toBe(403);
    // stored key + exact stored args → passes the gate (snooze dispatch = free minutes)
    expect((await actionPost(cookie, { itemId: forged, key: "attention.snooze", args: JSON.stringify({ minutes: 30 }), csrf })).statusCode).toBe(303);

    const outOfBounds = await actionPost(cookie, {
      itemId: snoozeId, key: "attention.snooze", args: JSON.stringify({ minutes: 9999 }), csrf,
    });
    expect(outOfBounds.statusCode).toBe(400);

    const unknown = await actionPost(cookie, {
      itemId: snoozeId, key: "system.shutdown", args: "{}", csrf,
    });
    expect(unknown.statusCode).toBe(400);

    const malformedArgs = await actionPost(cookie, {
      itemId: snoozeId, key: "attention.snooze", args: "not-json", csrf,
    });
    expect(malformedArgs.statusCode).toBe(400);
  });

  it("attention.feedback via /ui/action writes a feedback row", async () => {
    const id = await seedItem(userId, {
      title: "Rate me", actions: [{ key: "attention.feedback", args: { verdict: "noise" } }],
    });
    const res = await actionPost(cookie, {
      itemId: id, key: "attention.feedback", args: JSON.stringify({ verdict: "noise" }), csrf,
    });
    expect(res.statusCode).toBe(303);
    const rows = (await db.pool.query(
      "SELECT item_type, verdict, created_by FROM feedback WHERE item_type = 'attention_item' AND item_id = $1",
      [id],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("noise");
    expect(rows[0].created_by).toBe(userId);
  });

  it("outcome.open 302s to the contract path; the outcome view renders criteria", async () => {
    const itemId = (await db.pool.query(
      "SELECT id FROM attention_items WHERE kind = 'outcome.ready' AND title = 'Outcome ready'",
    )).rows[0].id as string;
    const res = await actionPost(cookie, {
      itemId, key: "outcome.open", args: JSON.stringify({ ref: "ABC7" }), csrf,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/ui/outcome/${encodeURIComponent("ABC7")}`);

    const byPath = await app.inject({ method: "GET", url: "/ui/outcome/ABC7", headers: { cookie } });
    expect(byPath.statusCode).toBe(200);
    expect(byPath.headers["content-security-policy"]).toBe(TODAY_CSP);
    expect(byPath.body).toContain("status waiting_user");
    expect(byPath.body).toContain("✓");
    expect(byPath.body).toContain("The thing is done");
    expect(byPath.body).toContain("○");
    expect(byPath.body).toContain("Created ");
    expect(byPath.body).toContain("Updated ");

    // query shape — what cookie browsers land on via the rewriteUrl hop
    const byQuery = await app.inject({ method: "GET", url: "/ui/outcome?ref=ABC7", headers: { cookie } });
    expect(byQuery.statusCode).toBe(200);

    const unknown = await app.inject({ method: "GET", url: "/ui/outcome/ZZZZ", headers: { cookie } });
    expect(unknown.statusCode).toBe(404);
  });

  // ------------------------------------------------------ principal isolation
  it("W1.1 correction: an EXPIRED snooze renders under Needs you immediately, not Snoozed", async () => {
    const id = await seedItem(userId, {
      title: "Expired-snooze sectioning probe",
      state: "snoozed",
      actions: [{ key: "attention.resolve" }],
    });
    // snoozed_until in the PAST: needs-you per the listOpenAttention contract
    await db.pool.query(
      "UPDATE attention_items SET snoozed_until = now() - interval '5 minutes' WHERE id = $1::uuid",
      [id],
    );
    const page = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    const needs = page.split("Needs you")[1]!.split("Snoozed")[0]!;
    const snoozed = page.split("Snoozed")[1]!;
    expect(needs).toContain("Expired-snooze sectioning probe");
    expect(snoozed).not.toContain("Expired-snooze sectioning probe");

    // a LIVE snooze still renders under Snoozed
    await db.pool.query(
      "UPDATE attention_items SET snoozed_until = now() + interval '1 hour' WHERE id = $1::uuid",
      [id],
    );
    const page2 = (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).body;
    const needs2 = page2.split("Needs you")[1]!.split("Snoozed")[0]!;
    const snoozed2 = page2.split("Snoozed")[1]!;
    expect(needs2).not.toContain("Expired-snooze sectioning probe");
    expect(snoozed2).toContain("Expired-snooze sectioning probe");
  });

  it("a second principal sees none of the first principal's items; foreign action/view → 404", async () => {
    const fresh = await seedItem(userId, { title: "Isolation probe" });
    await seedItem(otherId, { title: "Others own thing" }); // their page must render a form (csrf)

    const view = await app.inject({ method: "GET", url: "/ui", headers: { cookie: otherCookie } });
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain("Others own thing"); // their own item is visible to them
    expect(view.body).not.toContain("Safe title");
    expect(view.body).not.toContain("Isolation probe");

    // the other principal's CSRF (valid for their own session) + a foreign id
    const otherCsrf = view.body.match(/name="csrf" value="([^"]+)"/)![1];
    const attempted = await actionPost(otherCookie, {
      itemId: fresh, key: "attention.resolve", args: "{}", csrf: otherCsrf,
    });
    expect(attempted.statusCode).toBe(404);
    expect((await db.pool.query("SELECT state FROM attention_items WHERE id = $1::uuid", [fresh])).rows[0].state).toBe("open");

    const foreignOutcome = await app.inject({
      method: "GET", url: "/ui/outcome/ABC7", headers: { cookie: otherCookie },
    });
    expect(foreignOutcome.statusCode).toBe(404);
  });
});
