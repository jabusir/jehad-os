// requires Lane D buildApp export — runs at integration
//
// W1 Lane E — HTTP-level acceptance over buildApp() inject (contract §API):
// bearer JSON surface (GET /attention, POST /attention/:id/resolve) and the
// Today cookie-session HTML surface (GET /ui, POST /ui/session, POST /ui/action,
// GET /ui/outcome/:ref) including the hostile-string render check.
//
// Post-merge file: buildApp exists at base, but the attention routes (Lane D)
// and migrations 029/030 do not. The import is guarded behind a runtime check
// (dynamic import; the suite SKIPS when the export or the routes are missing —
// `W1 tables not present — runs post-merge` / `W1 attention routes not present
// — runs post-merge (Lane D)`). No stubs, no production edits. Per-file
// isolated db; skipped unless TEST_DATABASE_URL is set.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createOutcome, transitionOutcome } from "@jehad/core";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../../packages/db/tests/test-db.js";

type BuildAppFn = (opts?: { db?: unknown }) => Promise<FastifyInstance>;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

async function loadBuildApp(): Promise<BuildAppFn | null> {
  try {
    const specifier = "../index.js";
    const mod = (await import(specifier)) as Record<string, unknown>;
    return typeof mod["buildApp"] === "function" ? (mod["buildApp"] as BuildAppFn) : null;
  } catch {
    return null;
  }
}

/** 10:00 America/Los_Angeles — outside the 22:00–07:00 PT quiet hours. */
const T0 = new Date("2026-10-06T17:00:00.000Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const OWNER_CREDENTIAL = randomBytes(32).toString("hex");
const OWNER2_CREDENTIAL = randomBytes(32).toString("hex");

let db: IsolatedDb | null = null;
let app: FastifyInstance | null = null;
let ownerPrincipalId = "";

if (TEST_DATABASE_URL !== undefined) {
  db = await createIsolatedTestDb(TEST_DATABASE_URL, "w1api");
  await migrateUp(db.pool);
  const tables = await db.pool.query("SELECT to_regclass('public.attention_items') AS t");
  const tablesPresent = tables.rows[0]?.["t"] !== null && tables.rows[0]?.["t"] !== undefined;
  if (!tablesPresent) {
    await dropIsolatedTestDb(TEST_DATABASE_URL, db);
    db = null;
  } else {
    await seedDomains(db.pool);
    const owner = await upsertPrincipalCredential(db.pool, {
      type: "user", name: `w1-owner-${randomUUID().slice(0, 8)}`, credentialHash: sha256Hex(OWNER_CREDENTIAL),
    });
    ownerPrincipalId = owner.id;
    await upsertPrincipalCredential(db.pool, {
      type: "user", name: `w1-owner-2-${randomUUID().slice(0, 8)}`, credentialHash: sha256Hex(OWNER2_CREDENTIAL),
    });

    const buildApp = await loadBuildApp();
    if (buildApp === null) {
      await dropIsolatedTestDb(TEST_DATABASE_URL, db);
      db = null;
    } else {
      app = await buildApp({ db: db.pool });
      // Route-presence probe: auth runs before routing, so a valid bearer is
      // required to see the 404 that means "Lane D not merged yet".
      const probe = await app.inject({
        method: "GET", url: "/attention",
        headers: { authorization: `Bearer ${OWNER_CREDENTIAL}` },
      });
      if (probe.statusCode === 404) {
        await app.close();
        await dropIsolatedTestDb(TEST_DATABASE_URL, db);
        app = null;
        db = null;
      }
    }
  }
}

describe.skipIf(db === null)("W1 Today + attention HTTP surface (integration, post-merge)", () => {
  afterAll(async () => {
    if (app !== null) await app.close();
    app = null;
    if (db !== null && TEST_DATABASE_URL !== undefined) {
      await dropIsolatedTestDb(TEST_DATABASE_URL, db);
      db = null;
    }
  });

  // ------------------------------------------------------------ helpers

  function bearer(credential: string): Record<string, string> {
    return { authorization: `Bearer ${credential}` };
  }

  async function seedReadyOutcome(principalId: string, title: string): Promise<{ outcomeId: string; ref: string }> {
    const { outcome } = await createOutcome(db!.pool, {
      principalId,
      title,
      directive: "W1 HTTP acceptance: delegated work that parks for owner judgment",
      criteria: [{ criterion: "Outcome achieved, judged by the owner", verificationMethod: { kind: "owner_judgment" } }],
      createdBy: "josctl",
    }, { now: T0, actor: "w1-e2e" });
    for (const [to, minutes] of [["queued", 1], ["running", 2], ["waiting_user", 3]] as const) {
      const r = await transitionOutcome(db!.pool, outcome.id, to, {}, { now: at(minutes), actor: "w1-executor" });
      expect(r.changed).toBe(true);
    }
    return { outcomeId: outcome.id, ref: outcome.ref };
  }

  async function itemRow(outcomeId: string): Promise<Record<string, unknown>> {
    const r = await db!.pool.query(
      "SELECT * FROM attention_items WHERE source_object_id = $1 LIMIT 1",
      [outcomeId],
    );
    expect(r.rows).toHaveLength(1);
    return r.rows[0] as Record<string, unknown>;
  }

  function setCookies(res: InjectResponse): string[] {
    const raw: unknown = res.headers["set-cookie"];
    if (raw === undefined) return [];
    return Array.isArray(raw) ? raw.map(String) : [String(raw)];
  }

  function cookieHeader(cookies: readonly string[]): string {
    return cookies.map((c) => c.split(";")[0] ?? "").join("; ");
  }

  function extractCsrf(html: string): string | null {
    for (const re of [/name="csrf"[^>]*value="([^"]+)"/, /value="([^"]+)"[^>]*name="csrf"/]) {
      const m = re.exec(html);
      if (m !== null) return m[1]!;
    }
    return null;
  }

  /** Owner session for the HTML surface; returns the Cookie header value. */
  async function ownerSession(): Promise<string> {
    const exchange = await app!.inject({
      method: "POST", url: "/ui/session", payload: { token: OWNER_CREDENTIAL },
    });
    expect([200, 302, 303]).toContain(exchange.statusCode);
    const cookies = setCookies(exchange);
    expect(cookies.length).toBeGreaterThan(0);
    return cookieHeader(cookies);
  }

  // ------------------------------------------------------------ bearer JSON

  it("GET /attention is bearer-authed and principal-scoped (fail-closed)", async () => {
    const { outcomeId } = await seedReadyOutcome(ownerPrincipalId, "Assemble the board deck");
    const itemId = String((await itemRow(outcomeId))["id"]);

    const anon = await app!.inject({ method: "GET", url: "/attention" });
    expect(anon.statusCode).toBe(401);

    const ownerRes = await app!.inject({ method: "GET", url: "/attention", headers: bearer(OWNER_CREDENTIAL) });
    expect(ownerRes.statusCode).toBe(200);
    const items = ownerRes.json()["items"] as Record<string, unknown>[];
    const mine = items.find((i) => i["id"] === itemId);
    expect(mine).toBeDefined();
    expect(mine!["kind"]).toBe("outcome.ready");
    expect(mine!["state"]).toBe("open");

    const foreignRes = await app!.inject({ method: "GET", url: "/attention", headers: bearer(OWNER2_CREDENTIAL) });
    expect(foreignRes.statusCode).toBe(200);
    const foreignItems = foreignRes.json()["items"] as Record<string, unknown>[];
    expect(foreignItems.find((i) => i["id"] === itemId)).toBeUndefined();
  });

  it("POST /attention/:id/resolve: owner CAN, a foreign principal CANNOT (fail-closed)", async () => {
    const { outcomeId } = await seedReadyOutcome(ownerPrincipalId, "Schedule the dentist slot");
    const itemId = String((await itemRow(outcomeId))["id"]);

    const foreign = await app!.inject({
      method: "POST", url: `/attention/${itemId}/resolve`, headers: bearer(OWNER2_CREDENTIAL), payload: {},
    });
    expect([403, 404]).toContain(foreign.statusCode); // foreign ≡ nonexistent
    const afterForeign = await itemRow(outcomeId);
    expect(afterForeign["state"]).toBe("open");

    const ownerRes = await app!.inject({
      method: "POST", url: `/attention/${itemId}/resolve`, headers: bearer(OWNER_CREDENTIAL), payload: {},
    });
    expect(ownerRes.statusCode).toBeLessThan(400);
    const afterOwner = await itemRow(outcomeId);
    expect(afterOwner["state"]).toBe("resolved");
    expect(afterOwner["resolved_by"]).toBe("owner");
  });

  // ------------------------------------------------------------ Today HTML

  it("GET /ui requires a session; POST /ui/session bakes a hardened cookie", async () => {
    const anon = await app!.inject({ method: "GET", url: "/ui" });
    expect(anon.statusCode).toBe(401);

    const exchange = await app!.inject({
      method: "POST", url: "/ui/session", payload: { token: OWNER_CREDENTIAL },
    });
    expect([200, 302, 303]).toContain(exchange.statusCode);
    const cookies = setCookies(exchange);
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies.join("\n")).toContain("HttpOnly");
    expect(cookies.join("\n")).toContain("SameSite=Strict");

    const session = cookieHeader(cookies);
    const page = await app!.inject({ method: "GET", url: "/ui", headers: { cookie: session } });
    expect(page.statusCode).toBe(200);
    expect(String(page.headers["content-type"])).toContain("text/html");
    const csp = String(page.headers["content-security-policy"] ?? "");
    expect(csp).toContain("default-src 'none'");
  });

  it("hostile outcome titles render escaped: no raw '<script'/'<img' tags survive", async () => {
    const hostile = `<script>alert('x')</script> <img src=x onerror=alert(1)>`;
    const { ref } = await seedReadyOutcome(ownerPrincipalId, hostile);
    const session = await ownerSession();

    const page = await app!.inject({ method: "GET", url: "/ui", headers: { cookie: session } });
    expect(page.statusCode).toBe(200);
    // ADR-0022: exactly one <script — the hash-pinned enhancement script;
    // hostile content must never add another or render raw.
    expect(page.body.split("<script").length - 1).toBe(1);
    expect(page.body).not.toContain("<img"); // inert "onerror=" text may survive; the tag must not

    const outcomeView = await app!.inject({
      method: "GET", url: `/ui/outcome/${ref}`, headers: { cookie: session },
    });
    expect(outcomeView.statusCode).toBe(200);
    expect(outcomeView.body.split("<script").length - 1).toBe(1);
    expect(outcomeView.body).not.toContain("<img");
    expect(outcomeView.body).toContain("&lt;script"); // escaped, rendered anyway
    expect(outcomeView.body).toContain("Waiting for you"); // U0 language map (raw enum never renders)
  });

  it("POST /ui/action dispatches attention.resolve through the registry (CSRF required)", async () => {
    const { outcomeId } = await seedReadyOutcome(ownerPrincipalId, "Confirm the flights home");
    const itemId = String((await itemRow(outcomeId))["id"]);
    const session = await ownerSession();

    const page = await app!.inject({ method: "GET", url: "/ui", headers: { cookie: session } });
    expect(page.statusCode).toBe(200);
    const csrf = extractCsrf(page.body);
    expect(csrf).not.toBeNull(); // embedded in every form (contract)

    // Missing CSRF is rejected (CSRF token required).
    const csrfless = await app!.inject({
      method: "POST", url: "/ui/action", headers: { cookie: session },
      payload: { itemId, key: "attention.resolve", args: {} },
    });
    expect(csrfless.statusCode).toBeGreaterThanOrEqual(400);

    const action = await app!.inject({
      method: "POST", url: "/ui/action", headers: { cookie: session },
      payload: { itemId, key: "attention.resolve", args: {}, csrf },
    });
    expect(action.statusCode).toBeLessThan(400);
    const after = await itemRow(outcomeId);
    expect(after["state"]).toBe("resolved");
    expect(after["resolved_by"]).toBe("owner");
  });
});
