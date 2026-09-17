// User-side notification routes — integration suite against a per-file
// isolated database. GET /notifications + approve/reject are USER-ONLY
// (harness principals get 403 + audit — the harness never approves its own
// delivery queue); deterministic 400/404/409 shapes.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createNotification } from "@jehad/core";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db";
import { buildApp } from "../src/index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const USER_CREDENTIAL = randomBytes(32).toString("hex");
const HARNESS_CREDENTIAL = randomBytes(32).toString("hex");

describe.skipIf(!TEST_DATABASE_URL)("notification routes (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let userId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "apinotify");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user",
      name: "josctl",
      credentialHash: sha256Hex(USER_CREDENTIAL),
    });
    userId = user.id;
    await upsertPrincipalCredential(db.pool, {
      type: "harness",
      name: "openclaw",
      credentialHash: sha256Hex(HARNESS_CREDENTIAL),
    });
    app = await buildApp({ db: db.pool });
  });

  afterAll(async () => {
    await app.close();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function pendingNotification(
    overrides: Partial<Parameters<typeof createNotification>[1]> = {},
  ): Promise<string> {
    const notification = await createNotification(db.pool, {
      kind: "escalation",
      title: "Escalation for review",
      payload: { text: "review me" },
      sourceType: "escalation",
      sourceId: randomUUID(),
      createdBy: userId,
      ...overrides,
    });
    expect(notification.status).toBe("pending");
    return notification.id;
  }

  it("lists notifications with status/kind filters", async () => {
    const approvedBrief = await createNotification(db.pool, {
      kind: "brief",
      title: "Morning brief",
      payload: { content: "hi" },
      sourceType: "brief",
      sourceId: randomUUID(),
      createdBy: userId,
    });
    const pendingEscalation = await pendingNotification();

    const all = await app.inject({
      method: "GET",
      url: "/notifications",
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(all.statusCode).toBe(200);
    const ids = all.json().notifications.map((n: { id: string }) => n.id);
    expect(ids).toContain(approvedBrief.id);
    expect(ids).toContain(pendingEscalation);

    const approvedOnly = await app.inject({
      method: "GET",
      url: "/notifications?status=approved",
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(approvedOnly.statusCode).toBe(200);
    const approvedIds = approvedOnly.json().notifications.map((n: { id: string }) => n.id);
    expect(approvedIds).toContain(approvedBrief.id);
    expect(approvedIds).not.toContain(pendingEscalation);

    const briefs = await app.inject({
      method: "GET",
      url: "/notifications?kind=brief",
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(briefs.json().notifications.every((n: { kind: string }) => n.kind === "brief")).toBe(true);
  });

  it("approve moves pending → approved and audits; repeat approve → 409", async () => {
    const id = await pendingNotification();
    const approve = await app.inject({
      method: "POST",
      url: `/notifications/${id}/approve`,
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().notification).toMatchObject({ id, status: "approved", approvedBy: userId });

    const repeat = await app.inject({
      method: "POST",
      url: `/notifications/${id}/approve`,
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(repeat.statusCode).toBe(409);

    const audit = await db.pool.query(
      "SELECT actor FROM audit_log WHERE action = 'notification.approved' AND outputs_ref::jsonb->>'notificationId' = $1",
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor).toBe("user:josctl");
  });

  it("reject moves pending → rejected and audits", async () => {
    const id = await pendingNotification();
    const reject = await app.inject({
      method: "POST",
      url: `/notifications/${id}/reject`,
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().notification).toMatchObject({ id, status: "rejected" });
    const audit = await db.pool.query(
      "SELECT actor FROM audit_log WHERE action = 'notification.rejected' AND outputs_ref::jsonb->>'notificationId' = $1",
      [id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("400 malformed (id, filter), 404 unknown, 401 unauthenticated", async () => {
    const badId = await app.inject({
      method: "POST",
      url: "/notifications/not-a-uuid/approve",
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(badId.statusCode).toBe(400);

    const badFilter = await app.inject({
      method: "GET",
      url: "/notifications?status=banana",
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(badFilter.statusCode).toBe(400);

    const badLimit = await app.inject({
      method: "GET",
      url: "/notifications?limit=zero",
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(badLimit.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: `/notifications/${randomUUID()}/approve`,
      headers: { authorization: `Bearer ${USER_CREDENTIAL}` },
    });
    expect(missing.statusCode).toBe(404);

    const anon = await app.inject({ method: "GET", url: "/notifications" });
    expect(anon.statusCode).toBe(401);
  });

  it("harness principals get 403 + audit on every notification route (the queue is user-reviewed)", async () => {
    const id = await pendingNotification();
    const calls = [
      { method: "GET", url: "/notifications" },
      { method: "POST", url: `/notifications/${id}/approve` },
      { method: "POST", url: `/notifications/${id}/reject` },
    ];
    for (const call of calls) {
      const res = await app.inject({
        ...call,
        headers: { authorization: `Bearer ${HARNESS_CREDENTIAL}` },
      });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden" });
    }
    // The queue state is untouched: still pending, never harness-approved.
    const row = (
      await db.pool.query("SELECT status, approved_by FROM notifications WHERE id = $1::uuid", [id])
    ).rows[0];
    expect(row.status).toBe("pending");
    expect(row.approved_by).toBeNull();

    const denials = await db.pool.query(
      "SELECT actor, action FROM audit_log WHERE action = 'notifications.forbidden' AND actor = 'harness:openclaw'",
    );
    expect(denials.rows).toHaveLength(calls.length);
  });
});
