// iMessage shadow-sensor service integration tests (gateway Phase A, Lane
// B). Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set
// (per-file isolated db). Covers: guid-idempotent ingest (redelivery →
// duplicates counted, no double rows), the same-tx cursor upsert, §5.2
// fingerprint correlation (hash + 10-minute window, GUID backfill), the
// privacy rule (no content column; non-own hashes dropped), health upsert
// + audit, and input validation.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { createNotification } from "../notifications/service.js";
import {
  DEFAULT_NOTIFICATIONS_CONFIG,
} from "../notifications/config.js";
import {
  ImessageInputError,
  ingestBatch,
  recordHealth,
  type ImessageTransportEventInput,
} from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const T0 = new Date("2026-09-18T12:00:00.000Z");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function event(
  overrides: Partial<ImessageTransportEventInput> = {},
): ImessageTransportEventInput {
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

describe.skipIf(!TEST_DATABASE_URL)("imessage sensor service (integration)", () => {
  let db: IsolatedDb;
  let userPrincipalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igsensor");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    userPrincipalId = String(user.rows[0].id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    // Clean Lane B's tables between tests (audit_log is append-only history;
    // assertions there always filter by action).
    await db.pool.query(`
      DELETE FROM imessage_transport_events;
      DELETE FROM sent_message_fingerprints;
      DELETE FROM imessage_sensor_state;
    `);
  });

  async function countEvents(): Promise<number> {
    const result = await db.pool.query("SELECT count(*)::int AS n FROM imessage_transport_events");
    return Number(result.rows[0].n);
  }

  async function seedFingerprint(input: {
    renderedTextSha256: string;
    deliveredAt: string;
    recipient?: string;
  }): Promise<{ fingerprintId: string; notificationId: string }> {
    const notification = await createNotification(db.pool, {
      kind: "brief",
      title: "Seed brief",
      payload: { content: "sent text" },
      sourceType: "brief",
      sourceId: randomUUID(),
      createdBy: userPrincipalId,
    }, { config: DEFAULT_NOTIFICATIONS_CONFIG, now: () => T0 });
    const fingerprint = await db.pool.query(
      `INSERT INTO sent_message_fingerprints (notification_id, recipient, rendered_text_sha256, delivered_at)
       VALUES ($1::uuid, $2, $3, $4::timestamptz) RETURNING id`,
      [notification.id, input.recipient ?? "+15550001111", input.renderedTextSha256, input.deliveredAt],
    );
    return { fingerprintId: String(fingerprint.rows[0].id), notificationId: notification.id };
  }

  // ------------------------------------------------------------- ingest

  it("ingest is guid-idempotent: same batch twice → duplicates counted, no double rows", async () => {
    const batch = [
      event({ guid: "dup-1", rowid: 1 }),
      event({ guid: "dup-2", rowid: 2 }),
      event({ guid: "dup-3", rowid: 3, is_from_me: true, decoded_status: "own-ok" }),
    ];
    const first = await ingestBatch(db.pool, batch, { rowid: 3 });
    expect(first).toEqual({ accepted: 3, duplicates: 0, fingerprint_matches: [], quarantined: [] });
    expect(await countEvents()).toBe(3);

    const second = await ingestBatch(db.pool, batch, { rowid: 3 });
    expect(second).toEqual({ accepted: 0, duplicates: 3, fingerprint_matches: [], quarantined: [] });
    expect(await countEvents()).toBe(3); // exactly-once, not double rows
  });

  it("duplicate guids WITHIN one batch are counted, not double-inserted", async () => {
    const twice = [event({ guid: "same", rowid: 7 }), event({ guid: "same", rowid: 7 })];
    const report = await ingestBatch(db.pool, twice, { rowid: 7 });
    expect(report.accepted).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(await countEvents()).toBe(1);
  });

  it("a poison row is quarantined, not fatal: good rows ingest and the cursor advances (adversary 8c)", async () => {
    const poison = { ...event({ guid: "poison-1", rowid: 11 }), content: "A".repeat(5001) };
    const good = event({ guid: "good-8c", rowid: 12 });
    const report = await ingestBatch(db.pool, [poison, good], { rowid: 12 });
    expect(report.accepted).toBe(1);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]).toMatchObject({ guid: "poison-1" });
    // The good row's cursor persisted — the sensor will never resend.
    const cursor = await db.pool.query("SELECT cursor_rowid FROM imessage_sensor_state");
    expect(Number(cursor.rows[0].cursor_rowid)).toBe(12);
    // ...and the quarantine is audited.
    const q = await db.pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'imessage.ingest.quarantined'",
    );
    expect(q.rows[0].n).toBe(1);
  });

  it("cursor upserts in the same transaction: one singleton row, latest cursor wins", async () => {
    await ingestBatch(db.pool, [event({ guid: "c-1" })], {
      rowid: 100,
      db_generation: "gen-1",
      schema_fingerprint: "fp-1",
    });
    let state = await db.pool.query("SELECT * FROM imessage_sensor_state");
    expect(state.rows.length).toBe(1);
    expect(Number(state.rows[0].cursor_rowid)).toBe(100);
    expect(state.rows[0].db_generation).toBe("gen-1");
    expect(state.rows[0].schema_fingerprint).toBe("fp-1");

    await ingestBatch(db.pool, [event({ guid: "c-2" })], {
      rowid: 200,
      db_generation: "gen-2",
      schema_fingerprint: "fp-1", // unchanged fields persist through the upsert
    });
    state = await db.pool.query("SELECT * FROM imessage_sensor_state");
    expect(state.rows.length).toBe(1);
    expect(Number(state.rows[0].cursor_rowid)).toBe(200);
    expect(state.rows[0].db_generation).toBe("gen-2");
    expect(state.rows[0].schema_fingerprint).toBe("fp-1");
  });

  it("correlates own-message hashes on hash + 10-minute window and backfills the GUID", async () => {
    const { fingerprintId } = await seedFingerprint({
      renderedTextSha256: HASH_A,
      deliveredAt: new Date(T0.getTime() - 2 * 60_000).toISOString(), // 2 min before observation
    });
    const report = await ingestBatch(
      db.pool,
      [event({ guid: "own-1", rowid: 10, is_from_me: true, decoded_status: "own-ok", normalized_text_sha256: HASH_A })],
      { rowid: 10 },
    );
    expect(report.fingerprint_matches).toEqual([
      { guid: "own-1", fingerprint_id: fingerprintId },
    ]);
    const row = (
      await db.pool.query("SELECT fingerprint_id FROM imessage_transport_events WHERE guid = 'own-1'")
    ).rows[0];
    expect(String(row.fingerprint_id)).toBe(fingerprintId);
    const fingerprint = (
      await db.pool.query("SELECT imessage_guid FROM sent_message_fingerprints WHERE id = $1::uuid", [fingerprintId])
    ).rows[0];
    expect(fingerprint.imessage_guid).toBe("own-1");
  });

  it("no correlation outside the window: too late, or delivered after observed", async () => {
    await seedFingerprint({
      renderedTextSha256: HASH_B,
      deliveredAt: new Date(T0.getTime() - 15 * 60_000).toISOString(), // 15 min before → outside
    });
    const late = await ingestBatch(
      db.pool,
      [event({ guid: "late-1", rowid: 11, is_from_me: true, normalized_text_sha256: HASH_B })],
      { rowid: 11 },
    );
    expect(late.fingerprint_matches).toEqual([]);

    await seedFingerprint({
      renderedTextSha256: HASH_B,
      deliveredAt: new Date(T0.getTime() + 5 * 60_000).toISOString(), // after observation → outside
    });
    const future = await ingestBatch(
      db.pool,
      [event({ guid: "late-2", rowid: 12, is_from_me: true, normalized_text_sha256: HASH_B })],
      { rowid: 12 },
    );
    expect(future.fingerprint_matches).toEqual([]);
  });

  it("redelivered own-message rows correlate late (fingerprint arrived after first ingest)", async () => {
    const own = event({ guid: "own-late", rowid: 13, is_from_me: true, normalized_text_sha256: HASH_A });
    const first = await ingestBatch(db.pool, [own], { rowid: 13 });
    expect(first.fingerprint_matches).toEqual([]); // no fingerprint yet
    await seedFingerprint({
      renderedTextSha256: HASH_A,
      deliveredAt: new Date(T0.getTime() - 60_000).toISOString(),
    });
    const second = await ingestBatch(db.pool, [own], { rowid: 13 });
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(second.fingerprint_matches).toEqual([
      { guid: "own-late", fingerprint_id: expect.any(String) },
    ]);
  });

  it("PRIVACY: no content column exists; non-own hashes are dropped before storage", async () => {
    const columns = await db.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'imessage_transport_events'`,
    );
    const names = columns.rows.map((r) => String(r.column_name));
    expect(names).not.toContain("content"); // privacy rule, structurally
    await ingestBatch(
      db.pool,
      [event({ guid: "third-1", is_from_me: false, normalized_text_sha256: HASH_A })],
      { rowid: 1 },
    );
    const row = (
      await db.pool.query("SELECT normalized_text_sha256 FROM imessage_transport_events WHERE guid = 'third-1'")
    ).rows[0];
    expect(row.normalized_text_sha256).toBeNull();
  });

  it("rejects malformed batches with ImessageInputError (row-level invalids quarantine instead)", async () => {
    const quarantinedRow = await ingestBatch(
      db.pool,
      [event({ decoded_status: "garbage" as never })],
      { rowid: 1 },
    );
    expect(quarantinedRow.quarantined).toHaveLength(1);
    const quarantinedHash = await ingestBatch(
      db.pool,
      [event({ normalized_text_sha256: "not-a-hash" })],
      { rowid: 1 },
    );
    expect(quarantinedHash.quarantined).toHaveLength(1);
    const quarantinedTime = await ingestBatch(
      db.pool,
      [event({ observed_at: "yesterday-ish" })],
      { rowid: 1 },
    );
    expect(quarantinedTime.quarantined).toHaveLength(1);
    await expect(ingestBatch(db.pool, [], { rowid: -5 })).rejects.toBeInstanceOf(ImessageInputError);
    await expect(
      ingestBatch(db.pool, "not-an-array" as never, { rowid: 1 }),
    ).rejects.toBeInstanceOf(ImessageInputError);
    // No events persisted (all row-level invalids quarantined), and the
    // quarantine path itself advanced the cursor exactly once (rowid 1).
    expect(await countEvents()).toBe(0);
    const state = await db.pool.query(
      "SELECT count(*)::int AS n, max(cursor_rowid)::int AS cur FROM imessage_sensor_state",
    );
    expect(Number(state.rows[0].n)).toBe(1);
    expect(Number(state.rows[0].cur)).toBe(1);
  });

  // ------------------------------------------------------------- health

  it("recordHealth upserts the five dims + writes an audit entry", async () => {
    const before = await db.pool.query("SELECT count(*)::int AS n FROM imessage_sensor_state");
    expect(Number(before.rows[0].n)).toBe(0);

    await recordHealth(db.pool, {
      health_process: "healthy",
      health_database: "healthy",
      health_decoder: "healthy",
      health_cursor: "healthy",
      health_shadow: "healthy",
      details: { note: "first report" },
    }, { actor: "harness:imessage-sensor", now: () => T0 });

    let state = (
      await db.pool.query("SELECT * FROM imessage_sensor_state")
    ).rows[0];
    expect(Number(state.cursor_rowid)).toBe(0); // health-first insert sentinel
    expect(state.health_process).toBe("healthy");
    expect(state.health_shadow).toBe("healthy");

    // Upsert (health dims scoped; a cursor written in between survives).
    await db.pool.query(`
      INSERT INTO imessage_sensor_state (singleton, cursor_rowid, updated_at)
      VALUES (true, 777, now())
      ON CONFLICT (singleton) DO UPDATE SET cursor_rowid = 777
    `);
    await recordHealth(db.pool, {
      health_process: "degraded",
      health_database: "healthy",
      health_decoder: "failed",
      health_cursor: "healthy",
      health_shadow: "healthy",
    }, { actor: "harness:imessage-sensor", now: () => T0 });

    const rows = (await db.pool.query("SELECT * FROM imessage_sensor_state")).rows;
    expect(rows.length).toBe(1);
    state = rows[0];
    expect(state.health_process).toBe("degraded");
    expect(state.health_decoder).toBe("failed");
    expect(Number(state.cursor_rowid)).toBe(777); // cursor untouched by health

    const audits = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log
       WHERE action = 'imessage.sensor.health' ORDER BY created_at`,
    );
    expect(audits.rows.length).toBe(2);
    expect(audits.rows[0].o).toMatchObject({
      health_process: "healthy",
      health_shadow: "healthy",
      details: { note: "first report" },
    });
    expect(audits.rows[1].o).toMatchObject({ health_process: "degraded", health_decoder: "failed" });
  });

  it("recordHealth rejects malformed dims and non-object details", async () => {
    await expect(
      recordHealth(db.pool, {
        health_process: "on-fire" as never,
        health_database: "healthy",
        health_decoder: "healthy",
        health_cursor: "healthy",
        health_shadow: "healthy",
      }),
    ).rejects.toBeInstanceOf(ImessageInputError);
    await expect(
      recordHealth(
        db.pool,
        {
          health_process: "healthy",
          health_database: "healthy",
          health_decoder: "healthy",
          health_cursor: "healthy",
          health_shadow: "healthy",
          details: ["no arrays"] as never,
        },
      ),
    ).rejects.toBeInstanceOf(ImessageInputError);
    const state = await db.pool.query("SELECT count(*)::int AS n FROM imessage_sensor_state");
    expect(Number(state.rows[0].n)).toBe(0); // nothing persisted
  });
});
