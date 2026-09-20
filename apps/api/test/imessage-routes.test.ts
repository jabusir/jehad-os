// iMessage shadow-sensor route tests (gateway Phase A, Lane B). Needs
// PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set (per-file
// isolated db). Covers the capability boundary: 401 unauthenticated, 403
// without the imessage:ingest grant (including the send_channel:imessage
// principal — the send grant does NOT widen to ingest), 200 with it,
// HTTP-level idempotent ingest, health 204 + audit, and 400 malformed
// bodies.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { issueGrant } from "@jehad/core";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db";
import { buildApp } from "../src/index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SENSOR_CREDENTIAL = randomBytes(32).toString("hex");
const EDGE_CREDENTIAL = randomBytes(32).toString("hex");

const T0 = new Date("2026-09-18T12:00:00.000Z");

function batchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid: `guid-${randomUUID().slice(0, 8)}`,
    rowid: 216995,
    is_from_me: false,
    transport_handle: "+15550001111",
    service: "iMessage",
    has_text: true,
    has_attributed_body: false,
    decoded_status: "ok",
    text_length: 42,
    normalized_text_sha256: null,
    observed_at: T0.toISOString(),
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)("imessage harness routes (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;
  let sensorHarnessId: string;
  let ingestToken: string;
  let sendChannelToken: string;
  let personalDomainId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igbapi");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const sensor = await upsertPrincipalCredential(db.pool, {
      type: "harness",
      name: "imessage-sensor",
      credentialHash: sha256Hex(SENSOR_CREDENTIAL),
    });
    sensorHarnessId = sensor.id;
    const edge = await upsertPrincipalCredential(db.pool, {
      type: "harness",
      name: "imessage-local",
      credentialHash: sha256Hex(EDGE_CREDENTIAL),
    });
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    personalDomainId = String(domain.rows[0].id);

    const ingest = await issueGrant(db.pool, {
      principalId: sensorHarnessId,
      runId: null,
      capability: "imessage:ingest",
      resource: "imessage",
      domainId: personalDomainId,
      ttlMs: 60 * 60_000,
    });
    ingestToken = ingest.token;
    // The send-only edge grant — must NOT authorize ingest (no widening).
    const sendChannel = await issueGrant(db.pool, {
      principalId: edge.id,
      runId: null,
      capability: "send_channel:imessage",
      resource: "notifications",
      domainId: personalDomainId,
      ttlMs: 60 * 60_000,
    });
    sendChannelToken = sendChannel.token;

    app = await buildApp({ db: db.pool });
  });

  afterAll(async () => {
    await app.close();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function sensorHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${SENSOR_CREDENTIAL}` };
    if (token !== undefined) headers["x-capability-token"] = token;
    return headers;
  }

  function postIngest(body: unknown, headers: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/harness/imessage/ingest",
      headers: { ...headers, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  // ------------------------------------------------------- capability gate

  it("401 unauthenticated", async () => {
    const ingest = await app.inject({
      method: "POST",
      url: "/harness/imessage/ingest",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(ingest.statusCode).toBe(401);
    const health = await app.inject({
      method: "POST",
      url: "/harness/imessage/health",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(health.statusCode).toBe(401);
  });

  it("403 without the imessage:ingest grant (no token → missing; wrong principal/token → wrong_capability)", async () => {
    const noToken = await postIngest(
      { batch: [batchRow()], cursor: { rowid: 1 } },
      sensorHeaders(),
    );
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().code).toBe("missing_capability_token");

    // The send-only edge principal's grant must NOT widen to ingest.
    const sendEdge = await postIngest(
      { batch: [batchRow()], cursor: { rowid: 1 } },
      { authorization: `Bearer ${EDGE_CREDENTIAL}`, "x-capability-token": sendChannelToken },
    );
    expect(sendEdge.statusCode).toBe(403);
    expect(sendEdge.json().code).toBe("wrong_capability");
    // Denial audited.
    const denial = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log
       WHERE action = 'harness.grant_denied' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(denial.rows[0].o).toMatchObject({
      reason: "wrong_capability",
      capabilities: ["imessage:ingest"],
      resource: "imessage",
    });
  });

  // ------------------------------------------------------------- ingest

  it("ingest with the grant is idempotent over HTTP (same batch twice → duplicates counted)", async () => {
    const batch = [batchRow({ guid: "http-1" }), batchRow({ guid: "http-2", is_from_me: true, decoded_status: "own-ok" })];
    const body = { batch, cursor: { rowid: 216996, db_generation: "gen-a" } };
    const first = await postIngest(body, sensorHeaders(ingestToken));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 2, duplicates: 0, fingerprint_matches: [], quarantined: [] });

    const second = await postIngest(body, sensorHeaders(ingestToken));
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ accepted: 0, duplicates: 2, fingerprint_matches: [], quarantined: [] });

    const count = await db.pool.query("SELECT count(*)::int AS n FROM imessage_transport_events");
    expect(Number(count.rows[0].n)).toBe(2);
    const state = await db.pool.query("SELECT cursor_rowid FROM imessage_sensor_state");
    expect(Number(state.rows[0].cursor_rowid)).toBe(216996);

    // The call is audited with the grant id.
    const audit = await db.pool.query(
      `SELECT actor, grant_id, outputs_ref::jsonb AS o FROM audit_log WHERE action = 'imessage.ingest'`,
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    expect(audit.rows[0].actor).toBe("harness:imessage-sensor");
    expect(audit.rows[0].grant_id).not.toBeNull();
    expect(audit.rows[0].o).toMatchObject({ accepted: 2, duplicates: 0 });
  });

  it("ingest maps malformed bodies to 400 and persists nothing", async () => {
    const notArray = await postIngest(
      { batch: "nope", cursor: { rowid: 1 } },
      sensorHeaders(ingestToken),
    );
    expect(notArray.statusCode).toBe(400);
    // Row-level invalids QUARANTINE (200 + quarantined report — the sensor
    // cursor must advance; adversary 8c), while batch-level malformations
    // stay 400.
    const badStatus = await postIngest(
      { batch: [batchRow({ decoded_status: "garbage" })], cursor: { rowid: 1 } },
      sensorHeaders(ingestToken),
    );
    expect(badStatus.statusCode).toBe(200);
    expect(badStatus.json().quarantined).toHaveLength(1);
    const badCursor = await postIngest(
      { batch: [], cursor: { rowid: -1 } },
      sensorHeaders(ingestToken),
    );
    expect(badCursor.statusCode).toBe(400);
    // Quarantine ADVANCES the cursor (poison rows must never wedge the
    // pipeline); only the invalid-cursor 400 persisted nothing.
    const state = await db.pool.query(
      "SELECT count(*)::int AS n FROM imessage_sensor_state WHERE cursor_rowid = -1",
    );
    expect(Number(state.rows[0].n)).toBe(0);
  });

  // ------------------------------------------------------------- health

  it("health with the grant: 200 + paired_handles body, state upsert, audit entry", async () => {
    // Pair one handle so the response body carries a real canonical handle.
    const paired = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [`yusra-${randomUUID().slice(0, 8)}`],
    );
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [paired.rows[0].id, "c".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', '+15550003333', now(), now(), $2::uuid)`,
      [paired.rows[0].id, session.rows[0].id],
    );

    const health = {
      health_process: "healthy",
      health_database: "healthy",
      health_decoder: "healthy",
      health_cursor: "healthy",
      health_shadow: "healthy",
      details: { uptimeSeconds: 120 },
    };
    const res = await app.inject({
      method: "POST",
      url: "/harness/imessage/health",
      headers: { ...sensorHeaders(ingestToken), "content-type": "application/json" },
      payload: JSON.stringify(health),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ paired_handles: ["+15550003333"] });

    const state = (
      await db.pool.query("SELECT * FROM imessage_sensor_state")
    ).rows[0];
    expect(state).toBeDefined();
    expect(state.health_process).toBe("healthy");
    expect(state.health_shadow).toBe("healthy");

    const degraded = await app.inject({
      method: "POST",
      url: "/harness/imessage/health",
      headers: { ...sensorHeaders(ingestToken), "content-type": "application/json" },
      payload: JSON.stringify({ ...health, health_decoder: "degraded" }),
    });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toEqual({ paired_handles: ["+15550003333"] });
    const after = (await db.pool.query("SELECT health_decoder FROM imessage_sensor_state")).rows[0];
    expect(after.health_decoder).toBe("degraded");

    const audits = await db.pool.query(
      "SELECT outputs_ref::jsonb AS o FROM audit_log WHERE action = 'imessage.sensor.health'",
    );
    expect(audits.rows.length).toBe(2);
    expect(audits.rows[0].o).toMatchObject({ details: { uptimeSeconds: 120 } });
  });

  it("health with malformed dims maps to 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/harness/imessage/health",
      headers: { ...sensorHeaders(ingestToken), "content-type": "application/json" },
      payload: JSON.stringify({
        health_process: "on-fire",
        health_database: "healthy",
        health_decoder: "healthy",
        health_cursor: "healthy",
        health_shadow: "healthy",
      }),
    });
    expect(res.statusCode).toBe(400);
  });
});
