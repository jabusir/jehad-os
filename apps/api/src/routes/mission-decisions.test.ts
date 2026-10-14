/**
 * U1.4 — mission decision routes (the "resolve doesn't truly resolve" fix).
 * POST /ui/mission-done drives the CANONICAL outcome: criteria verified with
 * owner-judgment evidence (ADR-0017 gate), waiting_user → verifying →
 * completed, ready nudge cleared. /ui/mission-failed → failed with a reason.
 * /ui/criterion → per-criterion verify/waive. All session + CSRF +
 * principal-scoped; legality from the outcome service's own guards.
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
const TS_LOGIN = "owner@example.tailnet";

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw.join(";") : String(raw);
  const m = line.match(/jehad_session=[^;]+/);
  expect(m, "set-cookie carries jehad_session").not.toBeNull();
  return m![0];
}

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

describe.skipIf(!TEST_DATABASE_URL)("mission decision routes (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let userId: string;
  let cookie: string;
  let csrf: string;
  let configPath: string;

  /** Seed a waiting_user outcome with owner-judgment criteria + its ready card. */
  async function seedWaitingMission(ref: string, criteria: string[]): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO outcomes (id, principal_id, ref, title, directive, status)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'd', 'waiting_user')`,
      [id, userId, ref, `Mission ${ref}`],
    );
    for (let i = 0; i < criteria.length; i += 1) {
      await db.pool.query(
        `INSERT INTO outcome_criteria (id, outcome_id, ordinal, criterion, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'pending')`,
        [randomUUID(), id, i + 1, criteria[i]!],
      );
    }
    await db.pool.query(
      `INSERT INTO attention_items
         (id, principal_id, source_type, source_object_id, fingerprint, kind, state, title, summary, evidence_refs, actions, occurrences)
       VALUES ($1::uuid, $2::uuid, 'outcome', $3, $4, 'outcome.ready', 'open', 'ready', 's',
               $5::jsonb, $6::jsonb, 1)`,
      [
        randomUUID(),
        userId,
        id,
        `outcome:${ref}:ready`,
        JSON.stringify([{ type: "outcome", id: ref }]),
        JSON.stringify([
          { key: "outcome.open", args: { ref } },
          { key: "attention.resolve" },
          { key: "attention.snooze" },
          { key: "attention.dismiss" },
        ]),
      ],
    );
    return id;
  }

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "uxmmissions");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "josctl", credentialHash: sha256Hex(randomBytes(32).toString("hex")),
    });
    userId = user.id;
    configPath = join(tmpdir(), `uxm-${randomUUID()}.json`);
    await fs.writeFile(configPath, JSON.stringify({ tailscale: { enabled: true, identities: { [TS_LOGIN]: "josctl" } } }));
    process.env.TODAY_AUTH_CONFIG = configPath;
    resetTodayAuthPolicyCache();
    app = await buildApp({ db: db.pool, dispatch: { start: async () => ({ runId: "fake" }) } });
    const res = await app.inject({ method: "GET", url: "/ui", headers: { "Tailscale-User-Login": TS_LOGIN } });
    cookie = cookieFrom(res);
    const page = await app.inject({ method: "GET", url: "/ui/delegate", headers: { cookie } });
    csrf = page.body.match(/name="csrf" value="([^"]+)"/)![1]!;
  });

  afterAll(async () => {
    delete process.env.TODAY_AUTH_CONFIG;
    resetTodayAuthPolicyCache();
    await fs.rm(configPath, { force: true });
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("mission-done verifies criteria WITH evidence, completes the outcome, clears the nudge, mints no push", async () => {
    const outcomeId = await seedWaitingMission("MDONE1", ["Soil moisture up", "No wilted leaves"]);
    const res = await app.inject({
      method: "POST", url: "/ui/mission-done",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ ref: "MDONE1", csrf }),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/ui?done=mission-done");

    const outcome = await db.pool.query("SELECT status FROM outcomes WHERE id = $1::uuid", [outcomeId]);
    expect(String(outcome.rows[0]!.status)).toBe("completed");
    const criteria = await db.pool.query(
      "SELECT status FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal", [outcomeId]);
    expect(criteria.rows.map((r) => String(r.status))).toEqual(["verified", "verified"]);
    // ADR-0017 honesty: every verification carries a real evidence row
    const evidence = await db.pool.query(
      "SELECT count(*)::int AS n FROM outcome_criteria WHERE outcome_id = $1::uuid AND status = 'verified' AND evidence_ref IS NULL",
      [outcomeId],
    );
    expect(Number(evidence.rows[0]!.n)).toBe(0);
    const evidenceRows = await db.pool.query(
      "SELECT source_type, claim FROM evidence WHERE source_ref = 'today:mission-done:MDONE1'");
    expect(evidenceRows.rows.length).toBe(2);
    expect(String(evidenceRows.rows[0]!.source_type)).toBe("manual");
    // nudge cleared, owner-stamped, and NO notification minted (ADR-0021 spirit:
    // the owner is standing right here)
    const item = await db.pool.query(
      "SELECT state, resolved_by FROM attention_items WHERE source_object_id = $1", [outcomeId]);
    expect(String(item.rows[0]!.state)).toBe("resolved");
    // completed missions close their own nudge via the producer truth
    // ('producer') — or by the owner's hand ('owner'); both are honest.
    expect(["owner", "producer"]).toContain(String(item.rows[0]!.resolved_by));
    const pushes = await db.pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE created_at > now() - interval '1 minute' AND kind = 'attention'");
    expect(Number(pushes.rows[0]!.n)).toBe(0);
  });

  it("mission-failed moves a waiting mission to failed with the owner's reason", async () => {
    const outcomeId = await seedWaitingMission("MFAIL1", ["It happened"]);
    const res = await app.inject({
      method: "POST", url: "/ui/mission-failed",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ ref: "MFAIL1", csrf, reason: "The vendor never called back" }),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/ui?done=mission-failed");
    const outcome = await db.pool.query(
      "SELECT status, failure_reason FROM outcomes WHERE id = $1::uuid", [outcomeId]);
    expect(String(outcome.rows[0]!.status)).toBe("failed");
    expect(String(outcome.rows[0]!.failure_reason)).toBe("The vendor never called back");
  });

  it("criterion verify/waive updates exactly one criterion with evidence for verify", async () => {
    const outcomeId = await seedWaitingMission("MCRIT1", ["First", "Second"]);
    await app.inject({
      method: "POST", url: "/ui/criterion",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ ref: "MCRIT1", ordinal: "1", verdict: "verify", csrf }),
    });
    await app.inject({
      method: "POST", url: "/ui/criterion",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ ref: "MCRIT1", ordinal: "2", verdict: "waive", csrf }),
    });
    const criteria = await db.pool.query(
      "SELECT ordinal, status FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal", [outcomeId]);
    expect(criteria.rows.map((r) => String(r.status))).toEqual(["verified", "waived_by_owner"]);
  });

  it("fail-closed matrix: no session 401, bad CSRF 403, foreign ref 404, wrong-state 400", async () => {
    await seedWaitingMission("MFOREIGN", ["x"]);
    const noSession = await app.inject({
      method: "POST", url: "/ui/mission-done",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({ ref: "MFOREIGN", csrf }),
    });
    expect(noSession.statusCode).toBe(401);
    const badCsrf = await app.inject({
      method: "POST", url: "/ui/mission-done",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ ref: "MFOREIGN", csrf: "wrong" }),
    });
    expect(badCsrf.statusCode).toBe(403);
    const foreign = await app.inject({
      method: "POST", url: "/ui/mission-done",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ ref: "NOPE9", csrf }),
    });
    expect(foreign.statusCode).toBe(404);
    // completed missions can't be re-decided
    await db.pool.query("UPDATE outcomes SET status = 'failed' WHERE ref = 'MFAIL1'");
    const wrongState = await app.inject({
      method: "POST", url: "/ui/mission-done",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      payload: form({ ref: "MFAIL1", csrf }),
    });
    expect(wrongState.statusCode).toBe(400);
  });

  it("today renders the decision primary on outcome cards; detail renders decision + per-criterion controls", async () => {
    await seedWaitingMission("MCARD1", ["Only criterion"]);
    const today = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });
    expect(today.statusCode, `today: ${today.body.slice(0, 300)}`).toBe(200);
    expect(today.body).toContain('action="/ui/mission-done"');
    expect(today.body).toContain("Just clear this nudge");
    const detail = await app.inject({ method: "GET", url: "/ui/outcome/MCARD1", headers: { cookie } });
    expect(detail.statusCode, `detail: ${detail.body.slice(0, 300)}`).toBe(200);
    expect(detail.body).toContain('action="/ui/mission-done"');
    expect(detail.body).toContain('action="/ui/mission-failed"');
    expect(detail.body).toContain('name="verdict" value="verify"');
    expect(detail.body).toContain('name="verdict" value="waive"');
  });
});
