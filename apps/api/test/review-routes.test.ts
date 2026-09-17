// Review/escalation routes — integration suite against a per-file isolated
// database (packages/db/tests/test-db.ts). Covers M6C acceptance: the
// approve/reject/resolve round-trip over HTTP with audit rows, 401 when
// unauthenticated, 403 + audit for non-user principals on every new route,
// deterministic 400/404/409 shapes.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  migrateUp,
  seedDomains,
  sha256Hex,
  upsertPrincipalCredential,
} from "@jehad/db";
import {
  ModelEgressPolicyRegistry,
  acceptEvent,
  promoteCandidate,
  raiseEscalation,
} from "@jehad/core";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db";
import { buildApp } from "../src/index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CREDENTIAL = randomBytes(32).toString("hex");
const HARNESS_CREDENTIAL = randomBytes(32).toString("hex");

describe.skipIf(!TEST_DATABASE_URL)("review + escalation routes (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;

  // Route approve path uses the repo-root egress-policy.yaml (personal.normal
  // → openrouter allowed), matching the default promotion gate config.
  const registry = new ModelEgressPolicyRegistry([
    {
      id: "personal-normal",
      domainId: "personal",
      sensitivity: "normal",
      allowedProviders: ["openrouter"],
      allowRemote: false,
      requireRedaction: false,
    },
  ]);

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "apireview");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    await upsertPrincipalCredential(db.pool, {
      type: "user",
      name: "josctl",
      credentialHash: sha256Hex(CREDENTIAL),
    });
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

  function auth(credential: string): { authorization: string } {
    return { authorization: `Bearer ${credential}` };
  }

  function jsonAuth(credential: string): { authorization: string; "content-type": string } {
    return { ...auth(credential), "content-type": "application/json" };
  }

  async function queueSemanticCandidate(statement: string): Promise<string> {
    const accepted = await acceptEvent(db.pool, {
      type: "capture.recorded",
      schemaVersion: 1,
      source: "cli.capture",
      externalId: `route-test-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      payload: { statement },
      runId: null,
    });
    const inserted = await db.pool.query(
      `INSERT INTO memory_candidates (domain_id, proposed_class, assertion_kind, payload, provenance)
       SELECT d.id, 'semantic', 'model_inferred', $1::jsonb, $2::jsonb
       FROM domains d WHERE d.key = 'personal'
       RETURNING id`,
      [
        JSON.stringify({ statement, confidence: 0.9 }),
        JSON.stringify({
          sourceEventId: accepted.envelope.id,
          runId: null,
          model: "test-model",
          promptVersion: "p1",
        }),
      ],
    );
    const id = String(inserted.rows[0].id);
    // Route the candidate into the review queue (gate-5 semantic → in_review).
    const outcome = await promoteCandidate(db.pool, id, { egressRegistry: registry });
    expect(outcome.action).toBe("in_review");
    return id;
  }

  async function createEscalation(urgency: string): Promise<string> {
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    const run = await db.pool.query(
      `INSERT INTO runs (kind, principal_id, status, domain_id)
       SELECT 'workflow', $1, 'blocked', d.id FROM domains d WHERE d.key = 'personal'
       RETURNING id`,
      [principal.rows[0].id],
    );
    const raised = await raiseEscalation(db.pool, {
      runId: String(run.rows[0].id),
      reason: "approval_required",
      urgency,
      estHumanMinutes: 10,
    });
    return raised.escalation.id;
  }

  it("GET /review returns the queue for a user principal", async () => {
    const candidate = await queueSemanticCandidate("Jehad reviews in batches");
    const escalationId = await createEscalation("high");
    const res = await app.inject({ method: "GET", url: "/review", headers: auth(CREDENTIAL) });
    expect(res.statusCode).toBe(200);
    const queue = res.json().queue;
    expect(queue.promotions.map((p: { id: string }) => p.id)).toContain(candidate);
    expect(queue.escalations.map((e: { id: string }) => e.id)).toContain(escalationId);
  });

  it("approve completes an in_review candidate and writes an audit row", async () => {
    const candidate = await queueSemanticCandidate("Jehad walks after lunch");
    const res = await app.inject({
      method: "POST",
      url: `/review/${candidate}/approve`,
      headers: auth(CREDENTIAL),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toMatchObject({ candidateId: candidate, action: "promoted" });
    const audit = await db.pool.query(
      "SELECT actor, action FROM audit_log WHERE action = 'review.approve' AND outputs_ref::jsonb->>'candidateId' = $1",
      [candidate],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor).toBe("user:josctl");
  });

  it("reject discards an in_review candidate and writes an audit row", async () => {
    const candidate = await queueSemanticCandidate("Jehad never rejects tests");
    const res = await app.inject({
      method: "POST",
      url: `/review/${candidate}/reject`,
      headers: jsonAuth(CREDENTIAL),
      payload: JSON.stringify({ note: "stale" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rejection).toMatchObject({ candidateId: candidate, status: "rejected" });
    const row = (
      await db.pool.query("SELECT status FROM memory_candidates WHERE id = $1::uuid", [candidate])
    ).rows[0];
    expect(row.status).toBe("rejected");
    const audit = await db.pool.query(
      "SELECT actor, action FROM audit_log WHERE action = 'review.reject' AND outputs_ref::jsonb->>'candidateId' = $1",
      [candidate],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("GET /escalations lists non-resolved escalations urgency-first", async () => {
    const blocker = await createEscalation("blocker");
    const low = await createEscalation("low");
    const res = await app.inject({ method: "GET", url: "/escalations", headers: auth(CREDENTIAL) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().escalations.map((e: { id: string }) => e.id);
    expect(ids).toContain(blocker);
    expect(ids).toContain(low);
    expect(ids.indexOf(blocker)).toBeLessThan(ids.indexOf(low));
  });

  it("resolve settles an escalation, closes its human_wait, audits, and 409s on repeat", async () => {
    const escalationId = await createEscalation("high");
    const res = await app.inject({
      method: "POST",
      url: `/escalations/${escalationId}/resolve`,
      headers: jsonAuth(CREDENTIAL),
      payload: JSON.stringify({ resolution: "answered the question" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().escalation).toMatchObject({ id: escalationId, status: "resolved" });
    expect(res.json().closedHumanWaits).toBe(1);
    const wait = (
      await db.pool.query(
        "SELECT resolved_at FROM human_waits WHERE escalation_id = $1::uuid",
        [escalationId],
      )
    ).rows[0];
    expect(wait.resolved_at).not.toBeNull();
    const audit = await db.pool.query(
      "SELECT actor, action FROM audit_log WHERE action = 'escalation.resolve' AND outputs_ref::jsonb->>'escalationId' = $1",
      [escalationId],
    );
    expect(audit.rows).toHaveLength(1);

    const repeat = await app.inject({
      method: "POST",
      url: `/escalations/${escalationId}/resolve`,
      headers: jsonAuth(CREDENTIAL),
      payload: JSON.stringify({ resolution: "again" }),
    });
    expect(repeat.statusCode).toBe(409);
  });

  it("maps malformed ids/bodies to 400 and unknown ids to 404", async () => {
    const badId = await app.inject({
      method: "POST",
      url: "/review/not-a-uuid/approve",
      headers: auth(CREDENTIAL),
    });
    expect(badId.statusCode).toBe(400);

    const unknownCandidate = await app.inject({
      method: "POST",
      url: `/review/${randomUUID()}/reject`,
      headers: jsonAuth(CREDENTIAL),
      payload: JSON.stringify({}),
    });
    expect(unknownCandidate.statusCode).toBe(404);

    const badResolveBody = await app.inject({
      method: "POST",
      url: `/escalations/${randomUUID()}/resolve`,
      headers: jsonAuth(CREDENTIAL),
      payload: JSON.stringify({}),
    });
    expect(badResolveBody.statusCode).toBe(400);
    expect(badResolveBody.json().error).toBe("invalid_resolution");

    const unknownEscalation = await app.inject({
      method: "POST",
      url: `/escalations/${randomUUID()}/resolve`,
      headers: jsonAuth(CREDENTIAL),
      payload: JSON.stringify({ resolution: "x" }),
    });
    expect(unknownEscalation.statusCode).toBe(404);
  });

  it("401 when unauthenticated on every new route", async () => {
    const noAuth = { "content-type": "application/json" };
    const calls = [
      { method: "GET", url: "/review" },
      { method: "POST", url: `/review/${randomUUID()}/approve` },
      { method: "POST", url: `/review/${randomUUID()}/reject` },
      { method: "GET", url: "/escalations" },
      { method: "POST", url: `/escalations/${randomUUID()}/resolve` },
    ];
    for (const call of calls) {
      const res = await app.inject({ ...call, headers: noAuth });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthenticated" });
    }
  });

  it("403 + audit for non-user principals on every new route", async () => {
    const calls = [
      { method: "GET", url: "/review", route: "review" },
      { method: "POST", url: `/review/${randomUUID()}/approve`, route: "review" },
      { method: "POST", url: `/review/${randomUUID()}/reject`, route: "review" },
      { method: "GET", url: "/escalations", route: "escalations" },
      { method: "POST", url: `/escalations/${randomUUID()}/resolve`, route: "escalations" },
    ];
    for (const call of calls) {
      const res = await app.inject({ ...call, headers: auth(HARNESS_CREDENTIAL) });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden" });
    }
    const denials = await db.pool.query(
      "SELECT actor, action FROM audit_log WHERE action IN ('review.forbidden', 'escalations.forbidden') AND actor = 'harness:openclaw'",
    );
    expect(denials.rows).toHaveLength(calls.length);
  });
});
