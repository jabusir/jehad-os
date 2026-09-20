// Hardening regression tests for the multi-principal verification fixes
// (2026-09-19): pairing consume-race single-use, claim-time recipient
// recheck (adversary F1), and the per-principal turn lock bounding
// concurrent budget overshoot (adversary F2). Needs PostgreSQL 16.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import { FakeModelProvider } from "@jehad/adapters";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { attemptPairing, createPairingSession, sha256Hex } from "./pairing.js";
import {
  claimNextApprovedNotification,
  createNotification,
} from "../notifications/service.js";
import { handleInbound, CONVERSE_CAPABILITY, type ConversationDeps } from "./conversation.js";
import { issueGrant } from "../policy/grants.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const HANDLE = "+15550003333";
const HANDLE_2 = "+15550003444";
const HANDLE_3 = "+15550003555";
const FOREIGN_HANDLE = "+15550009999";

async function mkPrincipal(pool: IsolatedDb["pool"], name: string): Promise<string> {
  const row = await pool.query("INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id", [name]);
  return String(row.rows[0].id);
}

async function mkVerified(pool: IsolatedDb["pool"], principalId: string, handle: string): Promise<void> {
  const session = await pool.query(
    `INSERT INTO imessage_pairing_sessions (principal_id, purpose, code_hash, created_at, expires_at, consumed_at, consumed_handle)
     VALUES ($1::uuid, 'pair', 'deadbeef', now(), now() + interval '5 minutes', now(), $2)
     RETURNING id`,
    [principalId, handle],
  );
  await pool.query(
    `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
     VALUES ($1::uuid, 'imessage', $2, now(), now(), $3::uuid)`,
    [principalId, handle, String(session.rows[0].id)],
  );
}

describe.skipIf(!TEST_DATABASE_URL)("multi-principal hardening (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igmph");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });
  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("pairing: a session consumed between resolution and consume loses the race (single-use, ever)", async () => {
    const principalId = await mkPrincipal(db.pool, "race-owner");
    const { code } = await createPairingSession(db.pool, { principalId, purpose: "pair" });
    const attemptHash = sha256Hex(code);
    // Simulate the interleaving the verifier reproduced: sessionForAttempt
    // resolves the (unconsumed) session by hash, but a concurrent winner
    // consumes it first. We reproduce the post-condition of the lost race:
    // consuming manually mid-flight, then completing the attempt with the
    // SAME correct hash against the now-consumed session.
    await db.pool.query(
      `UPDATE imessage_pairing_sessions SET consumed_at = now(), consumed_handle = $2
        WHERE id = (SELECT id FROM imessage_pairing_sessions WHERE code_hash = $1)`,
      [attemptHash, "+15550001234"],
    );
    const result = await attemptPairing(db.pool, { handle: HANDLE, attemptHash });
    expect(result.paired).toBe(false);
    expect(result.reason).toBe("no-active-session");
    const identities = await db.pool.query(
      "SELECT count(*)::int AS c FROM transport_identities WHERE handle = $1",
      [HANDLE],
    );
    expect(identities.rows[0].c).toBe(0);
  });

  it("pairing: concurrent correct-hash attempts — exactly one pairs (true race)", async () => {
    const principalId = await mkPrincipal(db.pool, "race-owner-2");
    const { code } = await createPairingSession(db.pool, { principalId, purpose: "pair" });
    const attemptHash = sha256Hex(code);
    const results = await Promise.all([
      attemptPairing(db.pool, { handle: "+15550004444", attemptHash }),
      attemptPairing(db.pool, { handle: "+15550005555", attemptHash }),
    ]);
    const paired = results.filter((r) => r.paired);
    expect(paired).toHaveLength(1);
    const identities = await db.pool.query(
      "SELECT count(*)::int AS c FROM transport_identities WHERE principal_id = $1::uuid",
      [principalId],
    );
    expect(identities.rows[0].c).toBe(1);
  });

  it("claim: post-approval recipient edit is quarantined at claim time, never delivered (F1)", async () => {
    const ownerId = await mkPrincipal(db.pool, "recheck-owner");
    await mkVerified(db.pool, ownerId, HANDLE);
    const createdBy = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('service', $1) RETURNING id",
      [`recheck-gw-${randomUUID().slice(0, 8)}`],
    );
    const notification = await createNotification(
      db.pool,
      {
        kind: "reply",
        title: "Reply",
        payload: { content: "hi", recipient: HANDLE },
        recipient: HANDLE,
        sourceType: "run",
        createdBy: String(createdBy.rows[0].id),
        surface: "imessage",
        requestingPrincipalId: ownerId,
        conversationPrincipalId: ownerId,
        thirdPartyRecipient: false,
      },
    );
    expect(notification.status).toBe("approved");
    // Adversary F1: direct row mutation after approval.
    await db.pool.query("UPDATE notifications SET recipient = $2 WHERE id = $1::uuid", [
      notification.id,
      FOREIGN_HANDLE,
    ]);
    const claimed = await claimNextApprovedNotification(db.pool, { claimedBy: ownerId });
    // Either quarantined (null) or a different notification — but never this
    // row with the poisoned recipient.
    if (claimed?.id === notification.id) {
      throw new Error("F1 regression: claim honored a post-approval recipient edit");
    }
    const row = await db.pool.query(
      "SELECT status, claimed_at FROM notifications WHERE id = $1::uuid",
      [notification.id],
    );
    expect(row.rows[0].status).toBe("pending");
    expect(row.rows[0].claimed_at).toBeNull();
    const audits = await db.pool.query(
      "SELECT count(*)::int AS c FROM audit_log WHERE action = 'notification.reply_recipient_recheck_failed'",
    );
    expect(audits.rows[0].c).toBeGreaterThanOrEqual(1);
  });

  afterEach(async () => {
    // Pairing owner-briefs and prior notifications otherwise win the
    // FIFO claim in later tests.
    await db.pool.query("DELETE FROM notifications");
  });

  it("claim: legitimate reply recipient still claims normally", async () => {
    const ownerId = await mkPrincipal(db.pool, "recheck-owner-2");
    await mkVerified(db.pool, ownerId, HANDLE_2);
    const createdBy = await db.pool.query(
      "INSERT INTO principals (type, name) VALUES ('service', $1) RETURNING id",
      [`recheck2-gw-${randomUUID().slice(0, 8)}`],
    );
    await createNotification(
      db.pool,
      {
        kind: "reply",
        title: "Reply",
        payload: { content: "ok", recipient: HANDLE_2 },
        recipient: HANDLE_2,
        sourceType: "run",
        createdBy: String(createdBy.rows[0].id),
        surface: "imessage",
        requestingPrincipalId: ownerId,
        conversationPrincipalId: ownerId,
        thirdPartyRecipient: false,
      },
    );
    const claimed = await claimNextApprovedNotification(db.pool, { claimedBy: ownerId });
    expect(claimed?.recipient).toBe(HANDLE_2);
  });

  it("budget: concurrent turns cannot collectively overshoot the hourly cap (F2)", async () => {
    const ownerId = await mkPrincipal(db.pool, "budget-racer");
    await mkVerified(db.pool, ownerId, HANDLE_3);
    await issueGrant(db.pool, {
      principalId: ownerId,
      runId: null,
      capability: CONVERSE_CAPABILITY,
      resource: "imessage",
      domainId: String((await db.pool.query("SELECT id FROM domains WHERE key = 'personal'")).rows[0].id),
      ttlMs: 60 * 60_000,
    });
    const provider = new FakeModelProvider({ respond: { text: "quick answer" } });
    const deps: ConversationDeps = {
      db: db.pool,
      provider,
      registry: new ModelEgressPolicyRegistry([
        {
          id: "test-personal-normal",
          domainId: "personal",
          sensitivity: "normal",
          allowedProviders: ["fake"],
          allowRemote: false,
          requireRedaction: false,
        },
      ]),
      principalPolicy: () => ({ model: "fake/model-x", requestsPerHour: 2, costPerDay: 5, reads: [] }),
    };
    const turns = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        handleInbound(deps, { principalId: ownerId, handle: HANDLE_3, text: `msg ${i}` }).catch(() => ({
          replied: false,
        })),
      ),
    );
    const replied = turns.filter((t) => t.replied).length;
    expect(replied).toBeLessThanOrEqual(2);
  });
});
