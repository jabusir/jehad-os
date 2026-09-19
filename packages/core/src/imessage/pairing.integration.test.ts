// Pairing service integration tests (multi-principal Lane P). Needs
// PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set (per-file
// isolated db). Covers the §5.1 lifecycle: single-use codes (second
// success dies), 5-minute expiry, per-handle lockout at 3 wrong, session
// death at 5 total guesses, already-paired rejection, owner notification
// on success, full audit trail, and the helpers (verifiedHandles /
// principalForHandle / pairedHandles). The CODE never persists plaintext —
// only its sha256 lands in imessage_pairing_sessions.

import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db";
import {
  attemptPairing,
  attemptPairingInTx,
  canonicalizeHandle,
  createPairingSession,
  pairedHandles,
  principalForHandle,
  sha256Hex,
  verifiedHandles,
} from "./pairing.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const T0 = new Date("2026-09-19T12:00:00.000Z");
const HANDLE = "+15550001111";
const OTHER_HANDLE = "+15550002222";

const codeHashOf = (code: string): string => sha256Hex(code);

async function principalId(db: IsolatedDb["pool"], name: string): Promise<string> {
  const row = await db.query("INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id", [name]);
  return String(row.rows[0].id);
}

describe.skipIf(!TEST_DATABASE_URL)("imessage pairing (integration)", () => {
  let db: IsolatedDb;
  let ownerId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "igpair");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    ownerId = await principalId(db.pool, `owner-${randomUUID().slice(0, 8)}`);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    await db.pool.query(`
      DELETE FROM transport_identities;
      DELETE FROM imessage_pairing_sessions;
      DELETE FROM notifications WHERE kind = 'brief' AND title LIKE 'iMessage pairing%';
    `);
  });

  async function audits(action: string): Promise<Record<string, unknown>[]> {
    const rows = await db.pool.query(
      `SELECT outputs_ref::jsonb AS o FROM audit_log WHERE action = $1 ORDER BY created_at, id`,
      [action],
    );
    return rows.rows.map((row) => row.o as Record<string, unknown>);
  }

  it("success: right hash pairs, consumes the session (single-use), writes the identity, notifies the owner, audits", async () => {
    const session = await createPairingSession(
      db.pool,
      { principalId: ownerId, purpose: "pair" },
      { now: () => T0, actor: `user:owner` },
    );
    expect(session.code).toMatch(/^\d{6}$/);
    expect(new Date(session.expiresAt).getTime()).toBe(T0.getTime() + 5 * 60_000);

    const result = await attemptPairing(
      db.pool,
      { handle: HANDLE, attemptHash: codeHashOf(session.code) },
      { now: () => new Date(T0.getTime() + 30_000) },
    );
    expect(result).toEqual({ paired: true, principalId: ownerId, handle: HANDLE, sessionId: session.sessionId });

    // Identity written; session consumed exactly once.
    expect(await verifiedHandles(db.pool, ownerId)).toEqual([HANDLE]);
    const row = (
      await db.pool.query("SELECT consumed_at, consumed_handle FROM imessage_pairing_sessions WHERE id = $1::uuid", [session.sessionId])
    ).rows[0];
    expect(row.consumed_handle).toBe(HANDLE);
    expect(row.consumed_at).not.toBeNull();

    // Owner brief (kind≠reply → edge default target), auto-approved.
    const brief = (
      await db.pool.query(
        `SELECT title, status FROM notifications WHERE kind = 'brief' AND title LIKE 'iMessage pairing%'`,
      )
    ).rows[0];
    expect(brief).toBeDefined();
    expect(brief.status).toBe("approved");
    expect(String(brief.title)).toContain(HANDLE);

    // Full audit trail: session created, paired.
    expect((await audits("imessage.pairing.session_created")).length).toBe(1);
    expect(await audits("imessage.pairing.paired")).toEqual([
      { handle: HANDLE, principalId: ownerId, sessionId: session.sessionId },
    ]);
  });

  it("single-use: a second successful-looking attempt on a consumed session is dead", async () => {
    const session = await createPairingSession(
      db.pool,
      { principalId: ownerId, purpose: "pair" },
      { now: () => T0 },
    );
    const first = await attemptPairing(
      db.pool,
      { handle: HANDLE, attemptHash: codeHashOf(session.code) },
      { now: () => new Date(T0.getTime() + 10_000) },
    );
    expect(first.paired).toBe(true);

    // Same code, another handle, inside the TTL — the session is consumed.
    const second = await attemptPairing(
      db.pool,
      { handle: OTHER_HANDLE, attemptHash: codeHashOf(session.code) },
      { now: () => new Date(T0.getTime() + 20_000) },
    );
    expect(second).toMatchObject({ paired: false, reason: "no-active-session" });
    expect(await verifiedHandles(db.pool, ownerId)).toEqual([HANDLE]);
  });

  it("wrong code: counters bump; per-handle lockout at 3 wrong; audits every attempt", async () => {
    const session = await createPairingSession(
      db.pool,
      { principalId: ownerId, purpose: "pair" },
      { now: () => T0 },
    );
    const now = () => new Date(T0.getTime() + 10_000);
    for (let i = 1; i <= 3; i += 1) {
      const wrong = await attemptPairing(db.pool, { handle: HANDLE, attemptHash: codeHashOf("000000") }, { now });
      expect(wrong).toMatchObject({ paired: false, reason: "wrong-code" });
    }
    // 4th attempt from the same handle (wrong OR right): locked out.
    const locked = await attemptPairing(db.pool, { handle: HANDLE, attemptHash: codeHashOf("000000") }, { now });
    expect(locked).toMatchObject({ paired: false, reason: "handle-locked" });
    const right = await attemptPairing(db.pool, { handle: HANDLE, attemptHash: codeHashOf(session.code) }, { now });
    expect(right).toMatchObject({ paired: false, reason: "handle-locked" });

    const stored = (
      await db.pool.query("SELECT guesses_used, handle_lockouts FROM imessage_pairing_sessions WHERE id = $1::uuid", [session.sessionId])
    ).rows[0];
    expect(Number(stored.guesses_used)).toBe(3); // locked attempts stop counting
    expect(stored.handle_lockouts).toEqual({ [HANDLE]: 3 });
    const rejections = await audits("imessage.pairing.rejected");
    // audit_log is append-only across tests — filter to THIS handle's trail.
    expect(
      rejections.filter((r) => r.handle === HANDLE).map((r) => r.reason),
    ).toEqual(["wrong-code", "wrong-code", "wrong-code", "handle-locked", "handle-locked"]);
  });

  it("session-total throttle: 5 wrong guesses ACROSS handles kills the session (distributed spray)", async () => {
    const session = await createPairingSession(
      db.pool,
      { principalId: ownerId, purpose: "pair" },
      { now: () => T0 },
    );
    const now = () => new Date(T0.getTime() + 10_000);
    const burner = (n: number) => `+1555000${String(n).padStart(4, "0")}`;
    for (let i = 0; i < 5; i += 1) {
      const wrong = await attemptPairing(db.pool, { handle: burner(i), attemptHash: codeHashOf("000000") }, { now });
      expect(wrong).toMatchObject({ paired: false, reason: "wrong-code" });
    }
    // 6th burner (fresh handle, under its own per-handle limit) → exhausted.
    const sixth = await attemptPairing(db.pool, { handle: burner(9), attemptHash: codeHashOf("000000") }, { now });
    expect(sixth).toMatchObject({ paired: false, reason: "session-exhausted" });
    // The right code is dead too — the session has no guesses left.
    const right = await attemptPairing(db.pool, { handle: burner(8), attemptHash: codeHashOf(session.code) }, { now });
    expect(right).toMatchObject({ paired: false, reason: "session-exhausted" });
    expect(await verifiedHandles(db.pool, ownerId)).toEqual([]);
  });

  it("expiry: a session past its 5-minute TTL is dead; the same code pairs nothing", async () => {
    const session = await createPairingSession(
      db.pool,
      { principalId: ownerId, purpose: "pair" },
      { now: () => T0 },
    );
    const late = await attemptPairing(
      db.pool,
      { handle: HANDLE, attemptHash: codeHashOf(session.code) },
      { now: () => new Date(T0.getTime() + 5 * 60_000 + 1_000) },
    );
    expect(late).toMatchObject({ paired: false, reason: "no-active-session" });
  });

  it("already-paired handle is rejected even with a valid code for another principal's session", async () => {
    const session = await createPairingSession(
      db.pool,
      { principalId: ownerId, purpose: "pair" },
      { now: () => T0 },
    );
    const first = await attemptPairing(
      db.pool,
      { handle: HANDLE, attemptHash: codeHashOf(session.code) },
      { now: () => new Date(T0.getTime() + 10_000) },
    );
    expect(first.paired).toBe(true);

    const secondPrincipal = await principalId(db.pool, `yusra-${randomUUID().slice(0, 8)}`);
    const session2 = await createPairingSession(
      db.pool,
      { principalId: secondPrincipal, purpose: "pair" },
      { now: () => new Date(T0.getTime() + 20_000) },
    );
    const rePair = await attemptPairing(
      db.pool,
      { handle: HANDLE, attemptHash: codeHashOf(session2.code) },
      { now: () => new Date(T0.getTime() + 30_000) },
    );
    expect(rePair).toMatchObject({ paired: false, reason: "already-paired" });
    // The owner of the handle never changed.
    expect((await principalForHandle(db.pool, HANDLE))!.principalId).toBe(ownerId);
  });

  it("no active session: an unpaired handle with a hash and no session is dropped + audited", async () => {
    const result = await attemptPairing(
      db.pool,
      { handle: HANDLE, attemptHash: codeHashOf("123456") },
      { now: () => T0 },
    );
    expect(result).toMatchObject({ paired: false, reason: "no-active-session" });
    expect((await audits("imessage.pairing.rejected"))[0]).toMatchObject({ reason: "no-active-session" });
  });

  it("createPairingSession supersedes prior active sessions (single active per principal)", async () => {
    const s1 = await createPairingSession(db.pool, { principalId: ownerId, purpose: "pair" }, { now: () => T0 });
    const s2 = await createPairingSession(db.pool, { principalId: ownerId, purpose: "add-handle" }, { now: () => new Date(T0.getTime() + 1_000) });
    // The FIRST code is worthless: the newest session is the active one, and
    // the superseded session is dead regardless.
    const old = await attemptPairing(db.pool, { handle: HANDLE, attemptHash: codeHashOf(s1.code) }, { now: () => new Date(T0.getTime() + 2_000) });
    expect(old).toMatchObject({ paired: false, reason: "wrong-code" });
    const stale = await db.pool.query(
      "SELECT expires_at FROM imessage_pairing_sessions WHERE id = $1::uuid",
      [s1.sessionId],
    );
    expect(new Date(String(stale.rows[0].expires_at)).getTime()).toBeLessThanOrEqual(T0.getTime() + 1_000);
    const fresh = await attemptPairing(db.pool, { handle: HANDLE, attemptHash: codeHashOf(s2.code) }, { now: () => new Date(T0.getTime() + 3_000) });
    expect(fresh.paired).toBe(true);
  });

  it("the CODE never persists: only sha256 is stored (scan every pairing row)", async () => {
    const session = await createPairingSession(db.pool, { principalId: ownerId, purpose: "pair" }, { now: () => T0 });
    await attemptPairing(db.pool, { handle: HANDLE, attemptHash: codeHashOf(session.code) }, { now: () => new Date(T0.getTime() + 5_000) });
    const stored = (
      await db.pool.query("SELECT code_hash FROM imessage_pairing_sessions WHERE id = $1::uuid", [session.sessionId])
    ).rows[0];
    expect(String(stored.code_hash)).toBe(createHash("sha256").update(session.code, "utf8").digest("hex"));
    // No column anywhere in the table holds the plaintext code.
    const leak = await db.pool.query(
      `SELECT count(*)::int AS n FROM imessage_pairing_sessions
        WHERE code_hash = $1 OR consumed_handle = $1`,
      [session.code],
    );
    expect(Number(leak.rows[0].n)).toBe(0);
  });

  it("handle canonicalization: formats only; emails lowercase; phones → +digits", async () => {
    expect(canonicalizeHandle("+1 (555) 000-1111")).toBe("+15550001111");
    expect(canonicalizeHandle("15550001111")).toBe("+15550001111");
    expect(canonicalizeHandle("Yusra@ICloud.com")).toBe("yusra@icloud.com");
    // A paired identity is reachable through any formatting of its handle.
    const session = await createPairingSession(db.pool, { principalId: ownerId, purpose: "pair" }, { now: () => T0 });
    const result = await attemptPairing(
      db.pool,
      { handle: "+1 (555) 000-2222", attemptHash: codeHashOf(session.code) },
      { now: () => new Date(T0.getTime() + 5_000) },
    );
    expect(result.paired).toBe(true);
    expect(await principalForHandle(db.pool, "15550002222")).not.toBeNull();
    expect(await pairedHandles(db.pool)).toEqual(["+15550002222"]);
  });

  it("attemptPairingInTx composes with a caller transaction (same client)", async () => {
    const session = await createPairingSession(db.pool, { principalId: ownerId, purpose: "pair" }, { now: () => T0 });
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await attemptPairingInTx(
        client,
        { handle: HANDLE, attemptHash: codeHashOf(session.code) },
        { now: () => new Date(T0.getTime() + 5_000) },
      );
      expect(result.paired).toBe(true);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    expect(await verifiedHandles(db.pool, ownerId)).toEqual([HANDLE]);
  });
});
