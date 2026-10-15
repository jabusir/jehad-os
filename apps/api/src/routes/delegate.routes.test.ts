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
import { resolveDeadlinePick } from "./ui";
import type { OutcomeDispatchPort } from "@jehad/workflow";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// U3 injects a CSP-hashed inline script into every page; markup assertions
// must run against the DOM content, not the script's own selector text.
const bodyOnly = (html: string): string => html.replace(/<script[\s\S]*?<\/script>/g, "");
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

describe("deadline quick-pick map (shared time-token map, server-local; UX plan §2)", () => {
  it("tonight = today 20:00 server-local with NO snooze-floor roll", () => {
    const morning = resolveDeadlinePick("tonight", new Date(2026, 2, 1, 9, 15));
    expect(morning!.getTime()).toBe(new Date(2026, 2, 1, 20, 0).getTime());
    // 20:30 → the target is today 20:00, already past — never rolled to
    // tomorrow 20:00 (the floor roll is a snooze-only artifact per §2).
    const late = resolveDeadlinePick("tonight", new Date(2026, 2, 1, 20, 30))!;
    expect(late.getTime()).toBe(new Date(2026, 2, 1, 20, 0).getTime());
    expect(late.getTime()).toBeLessThan(new Date(2026, 2, 1, 20, 30).getTime());
  });

  it("tomorrow = next day 09:00 and nextweek = +7 days 09:00, across month bounds", () => {
    expect(resolveDeadlinePick("tomorrow", new Date(2026, 2, 1, 23, 59))!.getTime())
      .toBe(new Date(2026, 2, 2, 9, 0).getTime());
    expect(resolveDeadlinePick("tomorrow", new Date(2026, 0, 31, 12, 0))!.getTime())
      .toBe(new Date(2026, 1, 1, 9, 0).getTime());
    expect(resolveDeadlinePick("nextweek", new Date(2026, 2, 1, 0, 1))!.getTime())
      .toBe(new Date(2026, 2, 8, 9, 0).getTime());
  });

  it("none/unknown picks resolve to nothing", () => {
    const now = new Date();
    expect(resolveDeadlinePick("none", now)).toBeNull();
    expect(resolveDeadlinePick("garbage", now)).toBeNull();
  });
});

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
    expect(res.statusCode).toBe(303);
    expect(String(res.headers.location)).toMatch(/^\/ui\/missions\?created=/);
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

    const emptyGoal = await post({ goal: "", criterion1: "done" });
    expect(emptyGoal.statusCode).toBe(400);
    expect(emptyGoal.body).toContain('name="goal"'); // inline re-render, never a bare 400 page
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
    // U2: success is a 303 redirect to the mission on Missions (no
    // confirmation page); the canonical effects below are unchanged.
    expect(res.statusCode).toBe(303);
    const location = String(res.headers.location);
    expect(location).toMatch(/^\/ui\/missions\?created=/);

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
    // the redirect target is exactly the created mission's card
    expect(location).toBe(`/ui/missions?created=${encodeURIComponent(String(o.ref))}`);
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
    expect(first.statusCode).toBe(303);
    expect(String(first.headers.location)).toMatch(/^\/ui\/missions\?created=/);
    const second = await app.inject({
      method: "POST", url: "/ui/delegate",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie }, payload,
    });
    // U2: the alreadyRequested retry lands on the SAME redirect target
    expect(second.statusCode).toBe(303);
    const ref = (await db.pool.query(
      "SELECT ref FROM outcomes WHERE title = 'Idempotent retry mission'",
    )).rows[0]!.ref as string;
    expect(String(second.headers.location)).toBe(`/ui/missions?created=${encodeURIComponent(ref)}`);
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
    // U2: the cap rejection re-renders the form with the input preserved
    expect(res.body).toContain('value="Cap-busting mission"');
    expect(res.body).toMatch(/name="submissionId" value="([^"]+)"/);
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

describe.skipIf(!TEST_DATABASE_URL)("U2 delegate form (integration, isolated uxc db)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let userId: string;
  let cookie: string;
  let csrf: string;
  let configPath: string;

  async function autoLogin(): Promise<void> {
    const res = await app.inject({ method: "GET", url: "/ui", headers: { "Tailscale-User-Login": TS_LOGIN } });
    expect(res.statusCode).toBe(200);
    cookie = cookieFrom(res);
    const delegatePage = await app.inject({ method: "GET", url: "/ui/delegate", headers: { cookie } });
    const m = delegatePage.body.match(/name="csrf" value="([^"]+)"/);
    expect(m, "delegate form carries the session CSRF token").not.toBeNull();
    csrf = m![1];
  }

  const postForm = (fields: Record<string, string>) =>
    app.inject({
      method: "POST", url: "/ui/delegate",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ csrf, submissionId: randomUUID(), ...fields }),
    });

  const fillCap = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) {
      await db.pool.query(
        `INSERT INTO outcomes (id, principal_id, ref, title, directive, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'd', 'waiting_user')`,
        [randomUUID(), userId, `UXCCAP${i}`, `Uxc cap filler ${i}`],
      );
    }
  };

  const cancelAll = async (): Promise<void> => {
    await db.pool.query("UPDATE outcomes SET status = 'cancelled' WHERE principal_id = $1::uuid", [userId]);
  };

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "uxcdelegate");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "josctl", credentialHash: sha256Hex(randomBytes(32).toString("hex")),
    });
    userId = user.id;

    configPath = join(tmpdir(), `uxcdelegate-${randomUUID()}.json`);
    await fs.writeFile(
      configPath,
      JSON.stringify({ tailscale: { enabled: true, identities: { [TS_LOGIN]: "josctl" } } }),
    );
    process.env.TODAY_AUTH_CONFIG = configPath;
    resetTodayAuthPolicyCache();

    app = await buildApp({ db: db.pool, dispatch: { start: async () => ({ runId: "uxc-fake" }) } });
    await autoLogin();
  });

  afterAll(async () => {
    delete process.env.TODAY_AUTH_CONFIG;
    resetTodayAuthPolicyCache();
    await fs.rm(configPath, { force: true });
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("GET renders the grouped form: labels, helper lines, 4 DOM rows with data-extra rows 2-4 in details wrappers", async () => {
    const res = await app.inject({ method: "GET", url: "/ui/delegate", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // mission-execution v1: Research is the ONE executable type — fixed mode,
    // research framing, honest submit copy.
    expect(res.body).toContain('name="mode" value="research" checked');
    expect(res.body).toContain("What do you want researched?");
    expect(res.body).toContain("Done means");
    expect(res.body).toContain("How will you judge the result? You verify it when the research comes back.");
    expect(res.body).toContain("Constraints");
    expect(res.body).toContain("Rules the research must respect.");
    // all 4 rows per section in the DOM; rows 2-4 marked data-extra
    expect((res.body.match(/name="criterion[1-4]"/g) ?? [])).toHaveLength(4);
    expect((res.body.match(/name="constraint[1-4]"/g) ?? [])).toHaveLength(4);
    expect((bodyOnly(res.body).match(/data-extra/g) ?? [])).toHaveLength(6);
    expect((res.body.match(/<details class="extra-rows"><summary>Add another<\/summary>/g) ?? [])).toHaveLength(2);
    // deadline quick-picks + no-JS custom reveal hook
    for (const pick of ["none", "tonight", "tomorrow", "nextweek", "custom"]) {
      expect(res.body).toContain(`name="deadlinePick" value="${pick}"`);
    }
    expect(res.body).toContain('name="deadline"');
    expect(res.body).toContain('class="deadline-custom"');
    // policy slots context + new submit copy
    expect(res.body).toContain("of 3 mission slots used");
    expect(res.body).toContain("Start research");
  });

  it("quick-picks resolve server-local: tomorrow 09:00, nextweek +7d 09:00, tonight 20:00", async () => {
    const storedDeadline = async (title: string): Promise<number> =>
      new Date(String((await db.pool.query("SELECT deadline_at FROM outcomes WHERE title = $1", [title])).rows[0]!.deadline_at)).getTime();

    const tomorrow = await postForm({ goal: "Uxc tomorrow mission", criterion1: "done", deadlinePick: "tomorrow" });
    expect(tomorrow.statusCode).toBe(303);
    const expTom = new Date();
    expTom.setDate(expTom.getDate() + 1);
    expTom.setHours(9, 0, 0, 0);
    expect(await storedDeadline("Uxc tomorrow mission")).toBe(expTom.getTime());

    const nextweek = await postForm({ goal: "Uxc nextweek mission", criterion1: "done", deadlinePick: "nextweek" });
    expect(nextweek.statusCode).toBe(303);
    const expNw = new Date();
    expNw.setDate(expNw.getDate() + 7);
    expNw.setHours(9, 0, 0, 0);
    expect(await storedDeadline("Uxc nextweek mission")).toBe(expNw.getTime());

    // tonight is only delegable before 20:00 server-local; the past case is
    // covered by the dedicated test below plus the resolveDeadlinePick units.
    if (new Date().getHours() < 20) {
      const tonight = await postForm({ goal: "Uxc tonight mission", criterion1: "done", deadlinePick: "tonight" });
      expect(tonight.statusCode).toBe(303);
      const expTonight = new Date();
      expTonight.setHours(20, 0, 0, 0);
      expect(await storedDeadline("Uxc tonight mission")).toBe(expTonight.getTime());
    }
    await cancelAll();
  });

  it("a quick-pick whose target already passed re-renders inline (never a bare 400)", async () => {
    const now = new Date();
    if (now.getHours() >= 20) {
      // tonight (today 20:00) has already passed
      const res = await postForm({ goal: "Uxc passed pick mission", criterion1: "done", deadlinePick: "tonight" });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("quick pick already passed");
      expect(res.body).toContain('value="Uxc passed pick mission"');
      expect(res.body).toContain('name="criterion1"'); // form re-rendered, not a bare page
    } else {
      // tonight cannot have passed before 20:00 server-local — exercise the
      // identical inline-remedy path with an already-past custom datetime
      // (resolveDeadlinePick units prove tonight maps past after 20:00).
      const past = new Date(now.getTime() - 3_600_000);
      const pad = (n: number): string => String(n).padStart(2, "0");
      const local = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;
      const res = await postForm({ goal: "Uxc passed pick mission", criterion1: "done", deadlinePick: "custom", deadline: local });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("already passed");
      expect(res.body).toContain('value="Uxc passed pick mission"');
      expect(res.body).toMatch(/name="deadlinePick" value="custom" checked/);
    }
  });

  it("validation failure re-renders inline with ALL submitted values preserved", async () => {
    const res = await postForm({
      goal: "Uxc preserve this exact goal",
      criterion1: "",
      constraint1: "stay under 10 dollars",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('name="goal"');
    expect(res.body).toContain('value="Uxc preserve this exact goal"');
    expect(res.body).toContain('name="constraint1"');
    expect(res.body).toContain('value="stay under 10 dollars"');
    expect(res.body).toContain("field-error");
    expect(res.body).toContain("how will you judge this done?");
    // retry mechanics intact: fresh CSRF + submissionId in the re-render
    expect(res.body).toMatch(/name="csrf" value="([^"]+)"/);
    expect(res.body).toMatch(/name="submissionId" value="([^"]+)"/);
  });

  it("at cap: GET renders slots + cap notice INSTEAD of the submit button; POST re-renders inline", async () => {
    await fillCap();
    const page = await app.inject({ method: "GET", url: "/ui/delegate", headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("3 of 3 mission slots used");
    expect(page.body).toContain("policy cap");
    expect(bodyOnly(page.body)).not.toContain('type="submit"');
    expect(bodyOnly(page.body)).not.toContain("Start research");

    const res = await postForm({ goal: "Uxc cap-buster", criterion1: "done" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("policy cap");
    expect(res.body).toContain('value="Uxc cap-buster"');
    expect(bodyOnly(res.body)).not.toContain('type="submit"');
    await cancelAll();
    // cap lifted → the submit button is back
    const after = await app.inject({ method: "GET", url: "/ui/delegate", headers: { cookie } });
    expect(after.body).toContain("Start research");
  });

  it("POST redirects to /ui/missions?created=REF and that card renders a one-time highlight", async () => {
    const res = await postForm({ goal: "Uxc highlight me mission", criterion1: "done" });
    expect(res.statusCode).toBe(303);
    const loc = String(res.headers.location);
    expect(loc).toMatch(/^\/ui\/missions\?created=/);
    const ref = decodeURIComponent(loc.split("created=")[1]!);

    const missions = await app.inject({ method: "GET", url: loc, headers: { cookie } });
    expect(missions.statusCode).toBe(200);
    expect(missions.body).toContain("Uxc highlight me mission");
    expect((missions.body.match(/class="card created-pulse"/g) ?? [])).toHaveLength(1);
    // the pulse ships with its reduced-motion opt-out, ≤10 style lines
    expect(missions.body).toContain("@keyframes createdPulse");
    expect(missions.body).toContain("prefers-reduced-motion");

    // one-time + fail-closed: no ref / unknown ref → no highlight anywhere
    const plain = await app.inject({ method: "GET", url: "/ui/missions", headers: { cookie } });
    expect(plain.body).not.toContain('class="created-pulse"');
    const unknown = await app.inject({ method: "GET", url: "/ui/missions?created=ZZZZ", headers: { cookie } });
    expect(unknown.body).not.toContain('class="created-pulse"');
    expect(ref.length).toBeGreaterThan(0);
    await cancelAll();
  });
});
