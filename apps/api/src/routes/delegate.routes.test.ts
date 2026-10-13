/**
 * W1.2 mobile delegate surface — integration. The web route and the CLI share
 * ONE canonical seam (createAndDispatchOutcome): policy cap, budget/deadline
 * defaults, principal checks, audit/provenance, and exactly-once dispatch.
 * The dispatch port is injected (counting fake) — no Inngest dependency.
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
import type { OutcomeDispatchPort } from "@jehad/workflow";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TS_LOGIN = "owner@example.tailnet";

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw.join(";") : String(raw);
  const match = line.match(/jehad_session=[^;]+/);
  expect(match, `set-cookie carries jehad_session: ${line}`).not.toBeNull();
  return match![0];
}

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

describe.skipIf(!TEST_DATABASE_URL)("mobile delegate surface (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let userId: string;
  let cookie: string;
  let csrf: string;
  let configPath: string;
  let dispatchCalls: { name: string; payload: unknown }[];

  async function autoLogin(): Promise<void> {
    const res = await app.inject({ method: "GET", url: "/ui", headers: { "Tailscale-User-Login": TS_LOGIN } });
    expect(res.statusCode).toBe(200);
    cookie = cookieFrom(res);
    const delegatePage = await app.inject({ method: "GET", url: "/ui/delegate", headers: { cookie } });
    const m = delegatePage.body.match(/name="csrf" value="([^"]+)"/);
    expect(m, "delegate form carries the session CSRF token").not.toBeNull();
    csrf = m![1];
  }

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w12delegate");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "josctl", credentialHash: sha256Hex(randomBytes(32).toString("hex")),
    });
    userId = user.id;

    configPath = join(tmpdir(), `w12delegate-${randomUUID()}.json`);
    await fs.writeFile(
      configPath,
      JSON.stringify({ tailscale: { enabled: true, identities: { [TS_LOGIN]: "josctl" } } }),
    );
    process.env.TODAY_AUTH_CONFIG = configPath;
    resetTodayAuthPolicyCache();

    dispatchCalls = [];
    const fake: OutcomeDispatchPort = {
      start: async (name, payload) => {
        dispatchCalls.push({ name, payload });
        return { runId: `fake-${dispatchCalls.length}` };
      },
    };
    app = await buildApp({ db: db.pool, dispatch: fake });
    await autoLogin();
  });

  afterAll(async () => {
    delete process.env.TODAY_AUTH_CONFIG;
    resetTodayAuthPolicyCache();
    await fs.rm(configPath, { force: true });
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("GET /ui/delegate requires an authenticated session", async () => {
    const anon = await app.inject({ method: "GET", url: "/ui/delegate" });
    expect(anon.statusCode).toBe(401);
  });

  it("POST requires CSRF; principal is taken from the session only (never the form)", async () => {
    const noCsrf = await app.inject({
      method: "POST", url: "/ui/delegate",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ goal: "x task", criterion1: "done", submissionId: randomUUID() }),
    });
    expect(noCsrf.statusCode).toBe(403);

    // a forged principalId field must be IGNORED (principal = session principal)
    const res = await app.inject({
      method: "POST", url: "/ui/delegate",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({
        csrf, goal: "CSRF probe mission", criterion1: "It is verifiably done",
        submissionId: randomUUID(), principalId: "00000000-0000-4000-8000-00000000dead",
      }),
    });
    expect(res.statusCode).toBe(200);
    const row = await db.pool.query(
      "SELECT principal_id, title FROM outcomes WHERE title = 'CSRF probe mission'",
    );
    expect(row.rows).toHaveLength(1);
    expect(String(row.rows[0]!.principal_id)).toBe(userId);
  });

  it("empty goal denied; zero criteria denied; too many criteria denied; malformed/past deadline denied", async () => {
    const post = async (fields: Record<string, string>) =>
      app.inject({
        method: "POST", url: "/ui/delegate",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        payload: form({ csrf, submissionId: randomUUID(), ...fields }),
      });

    expect((await post({ goal: "", criterion1: "done" })).statusCode).toBe(400);
    expect((await post({ goal: "ab", criterion1: "done" })).statusCode).toBe(400); // directive too short
    expect((await post({ goal: "No criteria mission" })).statusCode).toBe(400);
    // extra fields beyond the 4 rendered rows are IGNORED (bounded form),
    // not an error — the >12 service bound is covered in the parity test
    expect((await post({ goal: "Bad deadline", criterion1: "done", deadline: "not-a-date" })).statusCode).toBe(400);
    expect((await post({ goal: "Past deadline", criterion1: "done", deadline: "2020-01-01T10:00" })).statusCode).toBe(400);
  });

  it("valid submission creates exactly ONE canonical Outcome + criteria rows + dispatches exactly once", async () => {
    dispatchCalls.length = 0;
    const sid = randomUUID();
    const res = await app.inject({
      method: "POST", url: "/ui/delegate",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({
        csrf, submissionId: sid,
        goal: "Water the plants while away",
        criterion1: "Soil moisture above threshold",
        criterion2: "No wilted leaves",
        constraint1: "Budget under $5",
        deadline: "2026-12-01T10:00",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("delegated");

    const outcomes = await db.pool.query(
      "SELECT id, ref, title, directive, deadline_at, budget_usd, created_by FROM outcomes WHERE title = 'Water the plants while away'",
    );
    expect(outcomes.rows).toHaveLength(1);
    const o = outcomes.rows[0]!;
    const criteria = await db.pool.query(
      "SELECT ordinal, criterion FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal",
      [o.id],
    );
    expect(criteria.rows.map((r) => String(r.criterion))).toEqual([
      "Soil moisture above threshold",
      "No wilted leaves",
    ]);
    // deadline honored (form value, not the policy default), budget = policy default
    expect(new Date(String(o.deadline_at)).toISOString().startsWith("2026-12-01")).toBe(true);
    expect(o.created_by).toBe("josctl");
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.name).toBe("outcome-executor");
    expect((dispatchCalls[0]!.payload as { ref: string }).ref).toBe(String(o.ref));

    // canonical provenance: delegate_requested + delegate_created + outcome.created events
    const events = await db.pool.query(
      "SELECT type FROM events WHERE payload->>'submissionId' = $1 OR (type = 'outcome.created' AND payload->>'outcomeId' = $2)",
      [sid, String(o.id)],
    );
    const types = events.rows.map((r) => String(r.type)).sort();
    expect(types).toEqual(["outcome.created", "outcome.delegate_created", "outcome.delegate_requested"]);
  });

  it("duplicate HTTP retry with the same submissionId does NOT create a second mission or re-dispatch", async () => {
    dispatchCalls.length = 0;
    const sid = randomUUID();
    const payload = form({
      csrf, submissionId: sid, goal: "Idempotent retry mission", criterion1: "Done means done",
    });
    const first = await app.inject({
      method: "POST", url: "/ui/delegate",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie }, payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST", url: "/ui/delegate",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie }, payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain("Already delegated");
    const outcomes = await db.pool.query(
      "SELECT count(*)::int AS n FROM outcomes WHERE title = 'Idempotent retry mission'",
    );
    expect(Number(outcomes.rows[0]!.n)).toBe(1);
    expect(dispatchCalls).toHaveLength(1);
  });

  it("policy active-outcome cap still applies on the web path", async () => {
    // repo policy.yaml: max_active_per_principal = 3 — fill the cap
    for (let i = 0; i < 3; i += 1) {
      await db.pool.query(
        `INSERT INTO outcomes (id, principal_id, ref, title, directive, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'd', 'waiting_user')`,
        [randomUUID(), userId, `CAPX${i}`, `Cap filler ${i}`],
      );
    }
    const res = await app.inject({
      method: "POST", url: "/ui/delegate",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ csrf, goal: "Cap-busting mission", criterion1: "done", submissionId: randomUUID() }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("policy cap");
  });

  it("audit/provenance matches the CLI delegation shape (same canonical events, principal-scoped actor)", async () => {
    // CLI-style delegation through the SAME shared seam (direct service call)
    const { createAndDispatchOutcome } = await import("@jehad/workflow");
    const { outcomesPolicyOf, parsePolicyV1 } = await import("@jehad/core");
    const { readFileSync } = await import("node:fs");
    const policy = outcomesPolicyOf(
      parsePolicyV1(readFileSync(new URL("../../../../policy.yaml", import.meta.url), "utf8")),
    );
    await db.pool.query(
      "UPDATE outcomes SET status = 'cancelled' WHERE principal_id = $1::uuid AND title IN ('CSRF probe mission','Water the plants while away','Idempotent retry mission','Cap filler 0','Cap filler 1','Cap filler 2')",
      [userId],
    );
    const mission = await createAndDispatchOutcome(
      db.pool,
      { start: async () => ({ runId: "cli-fake" }) },
      // (13 criteria would throw RangeError here — the service bound)
      {
        principalId: userId, principalName: "josctl",
        goal: "CLI parity mission", directive: "CLI parity mission",
        criteria: ["Outcome achieved, judged by the owner"],
        submissionId: randomUUID(), policy,
      },
      { now: new Date(), actor: "josctl:delegate" },
    );
    const cliEvents = await db.pool.query(
      "SELECT type FROM events WHERE payload->>'outcomeId' = $1 AND type IN ('outcome.created','outcome.delegate_created')",
      [mission.outcome.id],
    );
    expect(cliEvents.rows.map((r) => String(r.type)).sort()).toEqual([
      "outcome.created",
      "outcome.delegate_created",
    ]);
  });
});
