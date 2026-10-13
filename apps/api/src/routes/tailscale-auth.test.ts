/**
 * W1.2 Tailscale identity login — integration (exact allowlist → exact user
 * principal → normal Today session; fail-closed everywhere else; recovery
 * credential path and bearer auth unchanged).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../../packages/db/tests/test-db";
import { resetTodayAuthPolicyCache } from "../tailscale-auth";
import { buildApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const USER_CREDENTIAL = randomBytes(32).toString("hex");
const TS_LOGIN = "owner@example.tailnet";

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw.join(";") : String(raw);
  const match = line.match(/jehad_session=[^;]+/);
  expect(match, `set-cookie carries jehad_session: ${line}`).not.toBeNull();
  return match![0];
}

describe.skipIf(!TEST_DATABASE_URL)("tailscale identity login (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let userId: string;
  let harnessId: string;
  let configPath: string;
  const fakeDispatch = { start: async () => ({ runId: "fake-run" }) };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w12auth");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "josctl", credentialHash: sha256Hex(USER_CREDENTIAL),
    });
    userId = user.id;
    // A non-user principal sharing the mapped name pattern — must never authenticate.
    const harness = await upsertPrincipalCredential(db.pool, {
      type: "harness", name: "harness-one", credentialHash: sha256Hex(randomBytes(32).toString("hex")),
    });
    harnessId = harness.id;
    // A user principal WITHOUT a credential — session keys derive from the
    // credential hash, so no-credential users fail closed.
    await db.pool.query(
      "INSERT INTO principals (id, type, name, credential_hash) VALUES ($1::uuid, 'user', 'credless', NULL)",
      [randomUUID()],
    );

    configPath = join(tmpdir(), `w12auth-${randomUUID()}.json`);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        tailscale: { enabled: true, identities: { [TS_LOGIN]: "josctl", "harness-mapped@example.tailnet": "harness-one", "credless@example.tailnet": "credless" } },
      }),
    );
    process.env.TODAY_AUTH_CONFIG = configPath;
    resetTodayAuthPolicyCache();

    app = await buildApp({ db: db.pool, dispatch: fakeDispatch });
    await db.pool.query(
      `INSERT INTO attention_items
         (id, principal_id, source_type, source_object_id, fingerprint, kind, state, title, summary, evidence_refs, actions, occurrences)
       VALUES ($1::uuid, $2::uuid, 'watch', 'obj-1', 'fp-1', 'watch.match', 'open', 'Owner-only item', 's', '[]'::jsonb, '[]'::jsonb, 1)`,
      [randomUUID(), userId],
    );
  });

  afterAll(async () => {
    delete process.env.TODAY_AUTH_CONFIG;
    resetTodayAuthPolicyCache();
    await fs.rm(configPath, { force: true });
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function getUi(headers: Record<string, string> = {}) {
    return app.inject({ method: "GET", url: "/ui", headers });
  }

  it("allowlisted Tailscale-User-Login → normal session for the mapped principal, no credential", async () => {
    const res = await getUi({ "Tailscale-User-Login": TS_LOGIN });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Owner-only item");
    expect(res.body).not.toContain("recovery sign-in");
    // the minted cookie is a NORMAL Today session — reuse it
    const cookie = cookieFrom(res);
    const again = await getUi({ cookie });
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain("Owner-only item");
  });

  it("set-cookie flags remain Secure+HttpOnly+SameSite=Strict on the auto-login path", async () => {
    const res = await getUi({ "Tailscale-User-Login": TS_LOGIN });
    const line = Array.isArray(res.headers["set-cookie"]) ? (res.headers["set-cookie"] as string[]).join(";") : String(res.headers["set-cookie"]);
    expect(line).toContain("Secure");
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Strict");
  });

  it("unlisted login → denied; missing header → denied; display name alone → denied; tagged identity → denied", async () => {
    const unlisted = await getUi({ "Tailscale-User-Login": "stranger@example.tailnet" });
    expect(unlisted.statusCode).toBe(401);
    expect(unlisted.body).toContain("recovery sign-in");

    const missing = await getUi({});
    expect(missing.statusCode).toBe(401);

    // Display name / profile pic are NEVER consulted for authentication.
    const displayNameOnly = await getUi({
      "Tailscale-User-Name": "josctl",
      "Tailscale-User-Profile-Pic": "https://example.com/pic.png",
    });
    expect(displayNameOnly.statusCode).toBe(401);

    const tagged = await getUi({ "Tailscale-User-Login": "" });
    expect(tagged.statusCode).toBe(401);
  });

  it("non-user principal and credential-less principal mapped in the allowlist → still denied", async () => {
    const harness = await getUi({ "Tailscale-User-Login": "harness-mapped@example.tailnet" });
    expect(harness.statusCode).toBe(401);

    const credless = await getUi({ "Tailscale-User-Login": "credless@example.tailnet" });
    expect(credless.statusCode).toBe(401);
  });

  it("feature disabled in config → identity headers authorize nothing (fail closed)", async () => {
    await fs.writeFile(configPath, JSON.stringify({ tailscale: { enabled: false, identities: { [TS_LOGIN]: "josctl" } } }));
    resetTodayAuthPolicyCache();
    const res = await getUi({ "Tailscale-User-Login": TS_LOGIN });
    expect(res.statusCode).toBe(401);
    // restore
    await fs.writeFile(
      configPath,
      JSON.stringify({ tailscale: { enabled: true, identities: { [TS_LOGIN]: "josctl", "harness-mapped@example.tailnet": "harness-one", "credless@example.tailnet": "credless" } } }),
    );
    resetTodayAuthPolicyCache();
    expect((await getUi({ "Tailscale-User-Login": TS_LOGIN })).statusCode).toBe(200);
  });

  it("principal mapping cannot cross principals: auto-logged session sees only its own items", async () => {
    // second principal's item
    await db.pool.query(
      `INSERT INTO attention_items
         (id, principal_id, source_type, source_object_id, fingerprint, kind, state, title, summary, evidence_refs, actions, occurrences)
       VALUES ($1::uuid, $2::uuid, 'watch', 'obj-2', 'fp-2', 'watch.match', 'open', 'Second item', 's', '[]'::jsonb, '[]'::jsonb, 1)`,
      [randomUUID(), harnessId === userId ? randomUUID() : (await upsertPrincipalCredential(db.pool, { type: "user", name: "second", credentialHash: sha256Hex(randomBytes(32).toString("hex")) })).id],
    );
    const res = await getUi({ "Tailscale-User-Login": TS_LOGIN });
    expect(res.body).toContain("Owner-only item");
    expect(res.body).not.toContain("Second item");
  });

  it("break-glass credential path still works and remains separate from the normal path", async () => {
    const page = await app.inject({ method: "GET", url: "/ui/recovery" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Recovery sign-in");
    const res = await app.inject({
      method: "POST",
      url: "/ui/session",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${encodeURIComponent(USER_CREDENTIAL)}`,
    });
    expect(res.statusCode).toBe(303);
    const cookie = cookieFrom(res);
    const today = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });
    expect(today.statusCode).toBe(200);
    expect(today.body).toContain("Owner-only item");
    expect(userId).toBeTruthy();
    expect(harnessId).toBeTruthy();
  });

  it("bearer API auth unchanged: no Authorization header on a machine route → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/events" });
    expect(res.statusCode).toBe(401);
  });

  it("CSRF remains enforced after Tailscale auto-login", async () => {
    const res = await getUi({ "Tailscale-User-Login": TS_LOGIN });
    const cookie = cookieFrom(res);
    // POST /ui/action with the session cookie but no CSRF → 403
    const itemId = (await db.pool.query("SELECT id FROM attention_items WHERE principal_id = $1::uuid LIMIT 1", [userId])).rows[0]!.id;
    const bad = await app.inject({
      method: "POST",
      url: "/ui/action",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: `itemId=${itemId}&key=attention.seen&args={}&csrf=wrong`,
    });
    expect(bad.statusCode).toBe(403);
  });
});
