// POST/GET /events — integration suite against a per-file isolated database
// (packages/db/tests/test-db.ts). Covers plan §15 M2 acceptance: duplicate
// idempotency key → 200-noop with no second row; fresh uuid per capture →
// two events for identical words; malformed envelopes → deterministic 400;
// unauthenticated → 401.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { cliCaptureSourceAdapter } from "@jehad/adapters";
import { UUID_RE } from "@jehad/core";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../packages/db/tests/test-db";
import { buildApp } from "../src/index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const CREDENTIAL = randomBytes(32).toString("hex");

describe.skipIf(!TEST_DATABASE_URL)("events routes (integration)", () => {
  let db: IsolatedDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "apievts");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    await upsertPrincipalCredential(db.pool, {
      type: "user",
      name: "josctl",
      credentialHash: sha256Hex(CREDENTIAL),
    });
    app = await buildApp({ db: db.pool });
  });

  afterAll(async () => {
    await app.close();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "capture.recorded",
      schemaVersion: 1,
      source: "cli.capture",
      externalId: randomUUID(),
      occurredAt: new Date().toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      payload: { text: "I'll send Jehad the migration plan Friday" },
      ...overrides,
    };
  }

  function post(body: unknown, authorize = true) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorize) headers.authorization = `Bearer ${CREDENTIAL}`;
    return app.inject({ method: "POST", url: "/events", headers, payload: JSON.stringify(body) });
  }

  async function countRows(table: "events" | "outbox"): Promise<number> {
    const result = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return result.rows[0]?.n ?? 0;
  }

  it("accepts a valid envelope with 201, stores row + pending outbox row, mints uuid v7", async () => {
    const res = await post(validBody());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.duplicate).toBe(false);
    const event = body.event;
    expect(event.id).toMatch(UUID_RE);
    expect(event.id[14]).toBe("7"); // uuid v7
    expect(event.type).toBe("capture.recorded");
    expect(event.schemaVersion).toBe(1);
    expect(event.domainId).toBe("personal");
    expect(event.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(event.runId).toBeNull();

    const row = (await db.pool.query("SELECT * FROM events WHERE id = $1", [event.id])).rows[0];
    expect(row).toBeDefined();
    expect(row.schema_version).toBe(1);
    const outboxRow = (await db.pool.query("SELECT * FROM outbox WHERE event_id = $1", [event.id])).rows[0];
    expect(outboxRow.status).toBe("pending");
    expect(outboxRow.attempts).toBe(0);
  });

  it("treats a duplicate idempotency key as a 200 no-op with no second row", async () => {
    const body = validBody();
    const first = await post(body);
    expect(first.statusCode).toBe(201);
    const second = await post({ ...body, occurredAt: new Date().toISOString() });
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().event.id).toBe(first.json().event.id);
    expect(await countRows("events")).toBeGreaterThanOrEqual(2); // prior test's row + this one
    const byKey = await db.pool.query("SELECT count(*)::int AS n FROM events WHERE idempotency_key = $1", [
      first.json().event.idempotencyKey,
    ]);
    expect(byKey.rows[0]?.n).toBe(1);
    const outboxForKey = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE event_id IN
         (SELECT id FROM events WHERE idempotency_key = $1)`,
      [first.json().event.idempotencyKey],
    );
    expect(outboxForKey.rows[0]?.n).toBe(1);
  });

  it("settles concurrent duplicate deliveries to exactly one row (201 + 200)", async () => {
    const body = validBody();
    const [a, b] = await Promise.all([post(body), post(body)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 201]);
    const byKey = await db.pool.query("SELECT count(*)::int AS n FROM events WHERE idempotency_key = $1", [
      JSON.parse(a.payload).event.idempotencyKey,
    ]);
    expect(byKey.rows[0]?.n).toBe(1);
  });

  it("never mutates an accepted event on redelivery (immutable; no UPDATE path)", async () => {
    const body = validBody();
    const first = await post(body);
    const redelivery = await post({
      ...body,
      payload: { text: "TAMPERED PAYLOAD" },
      domainId: "work",
      sensitivity: "sensitive",
    });
    expect(redelivery.statusCode).toBe(200);
    expect(redelivery.json().event.id).toBe(first.json().event.id);
    const row = (await db.pool.query("SELECT payload, domain_id FROM events WHERE id = $1", [
      first.json().event.id,
    ])).rows[0];
    expect(row.payload).toEqual({ text: "I'll send Jehad the migration plan Friday" });
  });

  it("accepts the same text captured twice via the CLI adapter as TWO distinct events", async () => {
    const text = "totally identical words";
    const first = cliCaptureSourceAdapter.normalizeExternal({ kind: "capture", text });
    const second = cliCaptureSourceAdapter.normalizeExternal({ kind: "capture", text });
    expect(first.externalId).not.toBe(second.externalId);

    const before = await countRows("events");
    const res1 = await post({ ...first, schemaVersion: 1 });
    const res2 = await post({ ...second, schemaVersion: 1 });
    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    expect(res1.json().event.id).not.toBe(res2.json().event.id);
    expect(res1.json().event.idempotencyKey).not.toBe(res2.json().event.idempotencyKey);
    expect(await countRows("events")).toBe(before + 2);
  });

  const badBodies: Array<[string, Record<string, unknown>, string]> = [
    ["unsupported future schema version", { schemaVersion: 2 }, "SCHEMA_VERSION_UNSUPPORTED"],
    ["zero schema version", { schemaVersion: 0 }, "SCHEMA_VERSION_UNSUPPORTED"],
    ["non-integer schema version", { schemaVersion: "1" }, "SCHEMA_VERSION_UNSUPPORTED"],
    ["type outside catalog v1", { type: "email.received" }, "TYPE_NOT_IN_CATALOG"],
    ["unknown source", { source: "gmail" }, "SOURCE_INVALID"],
    ["bare adapter source", { source: "adapter:" }, "SOURCE_INVALID"],
    ["relative occurredAt", { occurredAt: "yesterday" }, "OCCURRED_AT_INVALID"],
    ["unknown domain key", { domainId: "nopetopia" }, "DOMAIN_NOT_FOUND"],
    ["unknown sensitivity", { sensitivity: "top-secret" }, "SENSITIVITY_INVALID"],
    ["array payload", { payload: ["nope"] }, "PAYLOAD_INVALID"],
    ["non-uuid runId", { runId: "not-a-uuid" }, "RUN_ID_INVALID"],
    ["empty externalId", { externalId: "" }, "EXTERNAL_ID_INVALID"],
  ];

  for (const [name, overrides, code] of badBodies) {
    it(`rejects ${name} with a deterministic 400 ${code}`, async () => {
      const res = await post(validBody(overrides));
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid_event");
      expect(body.code).toBe(code);
    });
  }

  it("rejects a non-object body with 400", async () => {
    const res = await post("just a string");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_event");
    expect(res.json().code).toBe("ENVELOPE_MALFORMED");
  });

  it("rejects an unauthenticated POST /events with 401", async () => {
    const res = await post(validBody(), false);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
    expect(await countRows("events")).toBe(await countRows("events")); // unchanged
  });

  it("reads an accepted event back via GET /events/:id as the camelCase envelope", async () => {
    const created = (await post(validBody())).json().event;
    const res = await app.inject({
      method: "GET",
      url: `/events/${created.id}`,
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toEqual(created);
  });

  it("GET /events/:id returns 400 for a malformed id and 404 for an unknown one", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/events/not-a-uuid",
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "invalid_event_id" });

    const missing = await app.inject({
      method: "GET",
      url: `/events/${randomUUID()}`,
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
  });
});
