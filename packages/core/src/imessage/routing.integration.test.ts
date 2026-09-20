// Ingest ROUTING integration tests (multi-principal Lane P — contracts
// "Ingest routing"). Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL
// is set (per-file isolated db). Covers the §3 ladder: own rows unchanged;
// paired handle + converse grant → conversation handler receives the
// TRANSIENT content; paired handle without grant → drop + audit; unpaired
// with no session → drop + audit; unpaired + active session + right
// pairing_attempt_hash → PAIRED; content on an unpaired handle → discarded
// + audited violation. And the hard invariant: NO content column receives
// the text — an information_schema scan of EVERY text-bearing column in
// EVERY public table.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { createPairingSession, sha256Hex, type InboundConversationMessage } from "./index.js";
import { ingestBatch, type ImessageTransportEventInput } from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Wall-relative (fixed dates detonate when real time passes them).
const T0 = new Date();
const YUSRA_HANDLE = "+15550002222";

describe.skipIf(!TEST_DATABASE_URL)("imessage ingest routing (integration)", () => {
  let db: IsolatedDb;
  let yusraId: string;
  let ownerId: string;
  let personalDomainId: string;
  const inbound: InboundConversationMessage[] = [];

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igroute");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const yusra = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [`yusra-${randomUUID().slice(0, 8)}`],
    );
    yusraId = String(yusra.rows[0].id);
    const owner = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id",
      [`owner-${randomUUID().slice(0, 8)}`],
    );
    ownerId = String(owner.rows[0].id);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    personalDomainId = String(domain.rows[0].id);
    // Pair yusra's handle (direct seed — the pairing lifecycle has its own suite).
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [yusraId, "d".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', $2, $3::timestamptz, $3::timestamptz, $4::uuid)`,
      [yusraId, YUSRA_HANDLE, T0.toISOString(), session.rows[0].id],
    );
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    await db.pool.query(`
      DELETE FROM imessage_transport_events;
      DELETE FROM sent_message_fingerprints;
      DELETE FROM imessage_sensor_state;
      DELETE FROM imessage_pairing_sessions;
      DELETE FROM notifications;
      DELETE FROM capability_grants WHERE capability = 'imessage:converse';
    `);
    inbound.length = 0;
  });

  function event(overrides: Partial<ImessageTransportEventInput> = {}): ImessageTransportEventInput {
    return {
      guid: `guid-${randomUUID().slice(0, 8)}`,
      rowid: 216995,
      is_from_me: false,
      transport_handle: YUSRA_HANDLE,
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

  async function ingest(
    batch: readonly ImessageTransportEventInput[],
    opts: { onInbound?: boolean } = {},
  ) {
    return ingestBatch(db.pool, batch, { rowid: 216996 }, {
      actor: "harness:imessage-sensor",
      ...(opts.onInbound ? { onInbound: async (message: InboundConversationMessage) => { inbound.push(message); } } : {}),
    });
  }

  async function auditActions(): Promise<string[]> {
    const rows = await db.pool.query(
      "SELECT action FROM audit_log WHERE action LIKE 'imessage.%' ORDER BY created_at, id",
    );
    return rows.rows.map((row) => String(row.action));
  }

  async function issueConverseGrant(principalId: string): Promise<void> {
    const { issueGrant } = await import("../policy/grants.js");
    await issueGrant(db.pool, {
      principalId,
      runId: null,
      capability: "imessage:converse",
      resource: "imessage",
      domainId: personalDomainId,
      ttlMs: 60 * 60_000,
    });
  }

  /** THE content-scan: no text-bearing column in ANY public table holds the needle. */
  async function scanAllColumnsFor(needle: string): Promise<string[]> {
    const columns = await db.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'character', 'name', 'uuid', 'jsonb', 'json')`,
    );
    const hits: string[] = [];
    for (const { table_name, column_name } of columns.rows) {
      const result = await db.pool.query(
        `SELECT count(*)::int AS n FROM ${table_name} WHERE ${column_name}::text LIKE $1`,
        [`%${needle}%`],
      );
      if (Number(result.rows[0].n) > 0) hits.push(`${table_name}.${column_name}`);
    }
    return hits;
  }

  it("paired handle + converse grant → conversation handler receives the transient content", async () => {
    await issueConverseGrant(yusraId);
    const report = await ingest(
      [event({ content: "what is for dinner tonight darling" })],
      { onInbound: true },
    );
    expect(report.accepted).toBe(1);
    expect(inbound).toEqual([
      { principalId: yusraId, handle: YUSRA_HANDLE, text: "what is for dinner tonight darling" },
    ]);
    expect(await auditActions()).toContain("imessage.inbound.routed");
  });

  it("paired handle WITHOUT grant → content dropped + audited; handler never called", async () => {
    const report = await ingest([event({ content: "let me in please" })], { onInbound: true });
    expect(report.accepted).toBe(1);
    expect(inbound).toEqual([]);
    const rows = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log WHERE action = 'imessage.inbound.dropped'`,
    );
    expect(rows.rows[0].o).toMatchObject({
      reason: "no-converse-grant",
      handle: YUSRA_HANDLE,
      principalId: yusraId,
    });
  });

  it("unpaired handle, no session, no hash → drop + audit metadata row", async () => {
    const report = await ingest([event({ transport_handle: "+15559990000" })]);
    expect(report.accepted).toBe(1); // the metadata row is stored
    const rows = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log WHERE action = 'imessage.inbound.unpaired'`,
    );
    expect(rows.rows[0].o).toEqual({ handle: "+15559990000" });
  });

  it("unpaired handle + active session + EXACT pairing_attempt_hash → paired", async () => {
    const newHandle = "+15550003333";
    const session = await createPairingSession(
      db.pool,
      { principalId: yusraId, purpose: "pair" },
      { now: () => T0 },
    );
    const report = await ingest([
      event({ transport_handle: newHandle, pairing_attempt_hash: sha256Hex(session.code) }),
    ]);
    expect(report.accepted).toBe(1);
    const identity = await db.pool.query(
      `SELECT principal_id::text AS principal_id FROM transport_identities WHERE handle = $1`,
      [newHandle],
    );
    expect(identity.rows[0]?.principal_id).toBe(yusraId);
    // The attempt hash is on the metadata row; the session is consumed.
    const row = (
      await db.pool.query("SELECT pairing_attempt_hash FROM imessage_transport_events ORDER BY ingested_at DESC LIMIT 1")
    ).rows[0];
    expect(String(row.pairing_attempt_hash)).toBe(sha256Hex(session.code));
    expect(await auditActions()).toContain("imessage.pairing.paired");
  });

  it("unpaired handle + WRONG pairing_attempt_hash → not paired; counters bump; audited", async () => {
    const newHandle = "+15550004444";
    await createPairingSession(db.pool, { principalId: yusraId, purpose: "pair" }, { now: () => T0 });
    await ingest([event({ transport_handle: newHandle, pairing_attempt_hash: sha256Hex("000000") })]);
    const identity = await db.pool.query(
      "SELECT count(*)::int AS n FROM transport_identities WHERE handle = $1",
      [newHandle],
    );
    expect(Number(identity.rows[0].n)).toBe(0);
    const rejected = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log WHERE action = 'imessage.pairing.rejected'`,
    );
    expect(rejected.rows[0].o).toMatchObject({ reason: "wrong-code", handle: newHandle });
  });

  it("content on an UNPAIRED handle → discarded + audited violation; nothing forwarded", async () => {
    const secret = "SPYCONTENT-do-not-store-7f3a9";
    const report = await ingest(
      [event({ transport_handle: "+15559998888", content: secret, text_length: secret.length })],
      { onInbound: true },
    );
    expect(report.accepted).toBe(1); // metadata row still lands
    expect(inbound).toEqual([]); // never forwarded
    const violation = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log WHERE action = 'imessage.content_violation'`,
    );
    expect(violation.rows[0].o).toMatchObject({ handle: "+15559998888", textLength: secret.length });
    // And the violation audit carries NO content either.
    expect(JSON.stringify(violation.rows[0].o)).not.toContain(secret);
    expect(await scanAllColumnsFor(secret)).toEqual([]);
  });

  it("HARD INVARIANT: INGEST itself persists no content — every text-bearing column of every public table scanned (the approved canonical path is the conversation handler's interaction_messages, covered in threads.integration)", async () => {
    await issueConverseGrant(yusraId);
    const secret = "TRANSIENTCONTENT-b2c4d6-never-anywhere";
    await ingest([event({ content: secret, text_length: secret.length })], { onInbound: true });
    expect(inbound).toHaveLength(1); // it DID reach the (stub) handler
    expect(await scanAllColumnsFor(secret)).toEqual([]);
  });

  it("own rows ride the unchanged Phase-A path: content/hash fields are ignored, loop correlation intact", async () => {
    const { createNotification } = await import("../notifications/service.js");
    const { DEFAULT_NOTIFICATIONS_CONFIG } = await import("../notifications/config.js");
    const secret = "OWNROWCONTENT-8811";
    const notification = await createNotification(db.pool, {
      kind: "brief",
      title: "Seed brief",
      payload: { content: "sent text" },
      sourceType: "brief",
      sourceId: randomUUID(),
      createdBy: ownerId,
    }, { config: DEFAULT_NOTIFICATIONS_CONFIG, now: () => T0 });
    await db.pool.query(
      `INSERT INTO sent_message_fingerprints (notification_id, recipient, rendered_text_sha256, delivered_at)
       VALUES ($1::uuid, $2, $3, $4::timestamptz)`,
      [notification.id, YUSRA_HANDLE, "e".repeat(64), new Date(T0.getTime() - 60_000).toISOString()],
    );
    const report = await ingest([
      event({
        guid: `own-${randomUUID().slice(0, 8)}`,
        is_from_me: true,
        decoded_status: "own-ok",
        normalized_text_sha256: "e".repeat(64),
        content: secret, // ignored on own rows
        observed_at: new Date(T0.getTime() + 30_000).toISOString(),
      }),
      event({
        guid: `own-${randomUUID().slice(0, 8)}`,
        is_from_me: true,
        decoded_status: "own-ok",
        pairing_attempt_hash: "f".repeat(64), // ignored on own rows too
        observed_at: new Date(T0.getTime() + 31_000).toISOString(),
      }),
    ]);
    expect(report.fingerprint_matches).toHaveLength(1);
    expect(inbound).toEqual([]);
    expect(await scanAllColumnsFor(secret)).toEqual([]);
  });

  it("duplicate redelivery never re-dispatches a conversation turn (guid idempotency, exactly-once)", async () => {
    await issueConverseGrant(yusraId);
    const row = event({ content: "hello again" });
    await ingest([row], { onInbound: true });
    await ingest([row], { onInbound: true }); // at-least-once sensor redelivery
    expect(inbound).toHaveLength(1);
  });

  it("content + pairing_attempt_hash together → quarantined, never processed (fail closed, batch survives)", async () => {
    // Adversary 8c contract: a bad row is rejected WITHOUT killing the
    // batch (the old whole-batch throw froze the sensor cursor forever).
    const report = await ingest([event({ content: "x", pairing_attempt_hash: "a".repeat(64) })]);
    expect(report.accepted).toBe(0);
    expect(report.quarantined).toHaveLength(1);
  });

  // ADVERSARIAL (pre-auth §5.1.1): unpaired sender with CONTENT while a
  // pairing session is LIVE — the content is the actual 6-digit code as
  // plaintext, the "attack" hoping text-shaped code input pairs like the
  // hash probe would. Pairing is hash-equality ONLY: content is a privacy
  // violation regardless of session state, and the session must survive
  // unconsumed with its guess counters untouched.
  it("adversarial: unpaired content = the live 6-digit code plaintext → discarded + audited; session NOT consumed", async () => {
    const handle = "+15557770000";
    const session = await createPairingSession(
      db.pool,
      { principalId: yusraId, purpose: "pair" },
      { now: () => T0 },
    );
    const report = await ingest([
      event({ transport_handle: handle, content: session.code, text_length: session.code.length }),
    ]);
    expect(report.accepted).toBe(1);
    expect(inbound).toEqual([]);
    const identity = await db.pool.query(
      "SELECT count(*)::int AS n FROM transport_identities WHERE handle = $1",
      [handle],
    );
    expect(Number(identity.rows[0].n)).toBe(0);
    const violation = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log
        WHERE action = 'imessage.content_violation' AND outputs_ref::jsonb->>'handle' = $1`,
      [handle],
    );
    expect(violation.rows[0].o).toMatchObject({ handle, textLength: session.code.length });
    const surviving = await db.pool.query(
      "SELECT consumed_at, guesses_used FROM imessage_pairing_sessions WHERE id = $1::uuid",
      [session.sessionId],
    );
    expect(surviving.rows[0].consumed_at).toBeNull();
    expect(Number(surviving.rows[0].guesses_used)).toBe(0);
  });

  // ADVERSARIAL (sensor-side normalization collision, server pin): the
  // sensor's paired-handle cache lowercases non-email passthrough handles,
  // so a paired canonical "AppleIDUser" collides with raw "appleiduser"
  // sensor-side and content WOULD be forwarded from that handle. The
  // server canonicalizes passthrough handles case-sensitively: the sender
  // is unpaired here → discard + audit. Server pairing state is the only
  // authority; sensor cache over-match can never become a false pair.
  it("adversarial: case-colliding handle (AppleIDUser paired, appleiduser sends) → content violation, never routed", async () => {
    const session = await db.pool.query(
      `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, expires_at)
       VALUES ($1::uuid, 'pair', $2, now() + interval '5 minutes') RETURNING id`,
      [yusraId, "e".repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
       VALUES ($1::uuid, 'imessage', 'AppleIDUser', $2::timestamptz, $2::timestamptz, $3::uuid)`,
      [yusraId, T0.toISOString(), session.rows[0].id],
    );
    try {
      const secret = "CASECOLLISION-content-must-discard";
      const report = await ingest([
        event({ transport_handle: "appleiduser", content: secret, text_length: secret.length }),
      ], { onInbound: true });
      expect(report.accepted).toBe(1);
      expect(inbound).toEqual([]);
      const violation = await db.pool.query(
        `SELECT outputs_ref::jsonb AS o FROM audit_log
          WHERE action = 'imessage.content_violation' AND outputs_ref::jsonb->>'handle' = 'appleiduser'`,
      );
      expect(violation.rows[0].o).toMatchObject({ handle: "appleiduser" });
      expect(await scanAllColumnsFor(secret)).toEqual([]);
    } finally {
      await db.pool.query("DELETE FROM transport_identities WHERE handle = 'AppleIDUser'");
    }
  });

  it("conversation handler failure is audited and never fails the committed ingest", async () => {
    await issueConverseGrant(yusraId);
    const report = await ingestBatch(db.pool, [event({ content: "boom test" })], { rowid: 216997 }, {
      actor: "harness:imessage-sensor",
      onInbound: async () => {
        throw new Error("handler exploded");
      },
    });
    expect(report.accepted).toBe(1);
    const errors = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log WHERE action = 'imessage.inbound.handler_error'`,
    );
    expect(errors.rows[0].o).toMatchObject({ error: "Error", handle: YUSRA_HANDLE });
    expect(JSON.stringify(errors.rows[0].o)).not.toContain("boom test");
  });
});
