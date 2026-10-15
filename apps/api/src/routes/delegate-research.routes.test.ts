/**
 * mission-execution v1 — the research delegate surface (integration,
 * isolated db). POST /ui/delegate sends mode:"research" to the ONE canonical
 * seam (createAndDispatchOutcome) no matter what the client posts, the
 * canonical Outcome carries the software-minted research plan, and the
 * mission detail page renders ONLY the canonical assignment result — fully
 * escaped, honest progress/stopped lines, and principal-scoped (foreign 404).
 * Harness reused from delegate.routes.test.ts (sessions, CSRF, fake dispatch
 * port) and mission-decisions.test.ts (direct outcome/assignment seeding).
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

describe.skipIf(!TEST_DATABASE_URL)("research delegate surface (mission-execution v1, integration)", () => {
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
    csrf = m![1]!;
  }

  const postDelegate = (fields: Record<string, string>) =>
    app.inject({
      method: "POST", url: "/ui/delegate",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ csrf, submissionId: randomUUID(), ...fields }),
    });

  /**
   * Seed an outcome (terminal status — off the policy-cap active set) and
   * its research assignment directly, like the executor would have left it.
   */
  async function seedResearchMission(
    ref: string,
    assignment: { status: string; result?: Record<string, unknown>; blocker?: Record<string, unknown> } | null,
  ): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO outcomes (id, principal_id, ref, title, directive, status)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, 'cancelled')`,
      [id, userId, ref, `Research mission ${ref}`],
    );
    if (assignment !== null) {
      await db.pool.query(
        `INSERT INTO assignments (id, outcome_id, principal_id, role, status, input, result, blocker, budget_usd)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'research', $4, $5::jsonb, $6::jsonb, $7::jsonb, 0)`,
        [
          randomUUID(), id, userId, assignment.status,
          JSON.stringify({ task: `Research mission ${ref}` }),
          assignment.result === undefined ? null : JSON.stringify(assignment.result),
          assignment.blocker === undefined ? null : JSON.stringify(assignment.blocker),
        ],
      );
    }
    return id;
  }

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "delegres");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "josctl", credentialHash: sha256Hex(randomBytes(32).toString("hex")),
    });
    userId = user.id;

    configPath = join(tmpdir(), `delegres-${randomUUID()}.json`);
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

  it("GET renders the research-only Type section, not the old executor copy", async () => {
    const res = await app.inject({ method: "GET", url: "/ui/delegate", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<h1>DELEGATE</h1>");
    expect(res.body).toContain('<input type="radio" name="mode" value="research" checked>');
    expect(res.body).toContain("What do you want researched?");
    expect(res.body).toContain("Start research");
    expect(res.body).toContain("Constraints");
    for (const pick of ["none", "tonight", "tomorrow", "nextweek", "custom"]) {
      expect(res.body).toContain(`name="deadlinePick" value="${pick}"`);
    }
    expect(res.body).not.toContain("Delegate — an executor starts immediately.");
  });

  it("POST happy path: research plan minted canonically + one outcome-executor start", async () => {
    dispatchCalls.length = 0;
    const goal = "Research the cheapest solid oak desk";
    const res = await postDelegate({ goal, criterion1: "Sources are cited", constraint1: "Under $500" });
    expect(res.statusCode).toBe(303);
    const location = String(res.headers.location);
    expect(location).toMatch(/^\/ui\/missions\?created=/);

    const outcomes = await db.pool.query(
      "SELECT id, ref, plan FROM outcomes WHERE title = $1",
      [goal],
    );
    expect(outcomes.rows).toHaveLength(1);
    const o = outcomes.rows[0] as { id: string; ref: string; plan: unknown };
    // The canonical plan is the deterministic research assignment, minted by
    // software from the selected mode — deep-equal, never model-authored.
    expect(o.plan).toEqual([{ assign: { role: "research", task: goal } }]);
    expect(location).toBe(`/ui/missions?created=${encodeURIComponent(o.ref)}`);

    const criteria = await db.pool.query(
      "SELECT verification_method FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal",
      [o.id],
    );
    expect(criteria.rows).toHaveLength(1);
    expect((criteria.rows[0] as { verification_method: unknown }).verification_method)
      .toEqual({ kind: "owner_judgment" });

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.name).toBe("outcome-executor");
    expect((dispatchCalls[0]!.payload as { ref: string }).ref).toBe(o.ref);
  });

  it("tampered form mode is IGNORED: an extra mode=analyze field still mints the research plan", async () => {
    dispatchCalls.length = 0;
    const goal = "Tampered mode cannot pick the mission type";
    const res = await postDelegate({ goal, criterion1: "done", mode: "analyze" });
    expect(res.statusCode).toBe(303);
    const outcomes = await db.pool.query(
      "SELECT plan FROM outcomes WHERE title = $1",
      [goal],
    );
    expect(outcomes.rows).toHaveLength(1);
    // The route never reads the client's mode field — it always sends
    // mode:"research" to the seam, which fails closed on unsupported types.
    expect((outcomes.rows[0] as { plan: unknown }).plan)
      .toEqual([{ assign: { role: "research", task: goal } }]);
    expect(dispatchCalls).toHaveLength(1);
  });

  it("succeeded research assignment renders the result: escaped everywhere, typed sources, confidence", async () => {
    const ref = "RESOK1";
    await seedResearchMission(ref, {
      status: "succeeded",
      result: {
        summary: "<script>alert(1)</script>",
        artifact: { title: "Lock research", body: "<img src=x onerror=alert(2)>" },
        citations: [
          { ref: "source-1", url: "https://example.com/lock", title: "Lock Review <b>", note: "n" },
        ],
        confidence: 0.7,
        openQuestions: ["price drift?"],
      },
    });
    const res = await app.inject({ method: "GET", url: `/ui/outcome/${ref}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const html = bodyOnly(res.body);
    expect(html).toContain("<h2>Research result</h2>");
    // Summary + body FULLY escaped — the raw tags never reach the page.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img ");
    // Source link: exact URL, restricted rel, escaped label.
    expect(html).toContain(
      '<a href="https://example.com/lock" rel="noopener noreferrer nofollow" target="_blank">Lock Review &lt;b&gt;</a>',
    );
    expect(html).toContain("Sources");
    expect(html).toContain("Open questions");
    expect(html).toContain("price drift?");
    expect(html).toContain("Confidence 70%");
  });

  it("running assignment renders an honest progress line", async () => {
    const ref = "RESRUN1";
    await seedResearchMission(ref, { status: "running" });
    const res = await app.inject({ method: "GET", url: `/ui/outcome/${ref}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Research in progress");
    expect(res.body).not.toContain("Research result");
  });

  it("blocked assignment renders the stop line with the blocker detail", async () => {
    const ref = "RESBLK1";
    await seedResearchMission(ref, {
      status: "blocked",
      blocker: { kind: "mechanical_failure", detail: "all citations failed" },
    });
    const res = await app.inject({ method: "GET", url: `/ui/outcome/${ref}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Research stopped: all citations failed");
  });

  it("no assignment → no result section at all", async () => {
    await seedResearchMission("RESNONE1", null);
    const res = await app.inject({ method: "GET", url: "/ui/outcome/RESNONE1", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("Research result");
  });

  it("foreign principal gets 404 for another principal's outcome (no result leak)", async () => {
    const foreignToken = randomBytes(32).toString("hex");
    await upsertPrincipalCredential(db.pool, {
      type: "user", name: "otheruser", credentialHash: sha256Hex(foreignToken),
    });
    const login = await app.inject({
      method: "POST", url: "/ui/session",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({ token: foreignToken }),
    });
    expect(login.statusCode).toBe(303);
    const foreignCookie = cookieFrom(login);
    const res = await app.inject({
      method: "GET", url: "/ui/outcome/RESOK1", headers: { cookie: foreignCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("Research result");
  });
});
