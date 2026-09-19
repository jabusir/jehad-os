// iMessage pairing service (gateway multi-principal Lane P —
// docs/plans/ig-multiprincipal-contracts.md; imessage-gateway.md §5.1/§5.1.1).
//
// A handle is PROOF, never configuration: transport_identities rows exist
// only through here — a 6-digit code shown ONCE by the CLI (never persisted
// plaintext; only sha256), 5-minute TTL, single-use (the first handle that
// proves it consumes it), two-layer guess throttle (per-handle lockout at 3
// wrong + session-wide total-guess cap, default 5). Every successful pairing
// immediately notifies the owner so a code hijack is visible within seconds.
//
// The pre-auth surface (§5.1.1) is exactly attemptPairing: an unpaired
// handle presenting a sha256 attempt hash gets hash-equality ONLY — no LLM,
// no parsing, no router. Everything else is the caller's drop+audit path.

import { createHash, randomInt } from "node:crypto";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { createNotification } from "../notifications/service.js";
import type { ImessageDb } from "./service.js";

/** Pairing codes live five minutes (contracts §migration 011). */
export const PAIRING_SESSION_TTL_MS = 5 * 60_000;

/** Per-handle wrong-attempt lockout (§5.1 two-layer throttle, layer 1). */
export const PAIRING_HANDLE_MAX_WRONG = 3;

/** Default session-wide total guess cap (layer 2 — defeats spray). */
export const PAIRING_DEFAULT_MAX_TOTAL_GUESSES = 5;

export const PAIRING_PURPOSES = ["pair", "add-handle"] as const;
export type PairingPurpose = (typeof PAIRING_PURPOSES)[number];

export type PairingRejectionReason =
  | "no-active-session"
  | "already-paired"
  | "handle-locked"
  | "session-exhausted"
  | "wrong-code";

export interface PairingSessionHandle {
  /** The 6-digit code — returned exactly once, never persisted plaintext. */
  readonly code: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface CreatePairingSessionInput {
  readonly principalId: string;
  readonly purpose: PairingPurpose;
  readonly maxTotalGuesses?: number;
}

export type PairingAttemptResult =
  | { readonly paired: true; readonly principalId: string; readonly handle: string; readonly sessionId: string }
  | { readonly paired: false; readonly reason: PairingRejectionReason; readonly sessionId: string | null };

export interface PairingOptions {
  readonly actor?: string;
  readonly now?: () => Date;
}

export class PairingInputError extends Error {
  readonly code = "PAIRING_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "PairingInputError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const GATEWAY_SERVICE_PRINCIPAL = "service/imessage-gateway";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Handle canonicalization — formats ONLY (E.164 shape, case); it never
 * merges an unproven handle onto a principal (§5.1). Emails lowercase;
 * phone-shaped input collapses to +digits; anything else passes through
 * trimmed (and will simply never pair unless texted exactly).
 */
export function canonicalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length >= 7 && (plus || digits.length >= 10)) {
    return `+${digits}`;
  }
  return trimmed;
}

/** Mints one pairing session. Single active session per principal: prior
 *  unconsumed, unexpired sessions for the principal die now (audited). */
export async function createPairingSession(
  db: ImessageDb,
  input: CreatePairingSessionInput,
  opts: PairingOptions = {},
): Promise<PairingSessionHandle> {
  if (!UUID_RE.test(input.principalId)) {
    throw new PairingInputError("principalId must be a uuid");
  }
  if (!(PAIRING_PURPOSES as readonly string[]).includes(input.purpose)) {
    throw new PairingInputError(`purpose must be one of ${PAIRING_PURPOSES.join("|")}`);
  }
  const maxTotalGuesses = input.maxTotalGuesses ?? PAIRING_DEFAULT_MAX_TOTAL_GUESSES;
  if (!Number.isSafeInteger(maxTotalGuesses) || maxTotalGuesses < 1) {
    throw new PairingInputError("maxTotalGuesses must be a positive integer");
  }
  const now = opts.now?.() ?? new Date();
  // crypto-random 6 digits — the code is returned ONCE; only sha256 lands in the row.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const superseded = await client.query(
      `UPDATE imessage_pairing_sessions
          SET expires_at = $2::timestamptz
        WHERE principal_id = $1::uuid AND consumed_at IS NULL AND expires_at > $2::timestamptz
        RETURNING id`,
      [input.principalId, now.toISOString()],
    );
    const inserted = await client.query(
      `INSERT INTO imessage_pairing_sessions
         (principal_id, purpose, code_hash, created_at, expires_at, max_total_guesses)
       VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6)
       RETURNING id, expires_at`,
      [
        input.principalId,
        input.purpose,
        sha256Hex(code),
        now.toISOString(),
        new Date(now.getTime() + PAIRING_SESSION_TTL_MS).toISOString(),
        maxTotalGuesses,
      ],
    );
    await client.query("COMMIT");
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("createPairingSession: insert returned no row");
    await recordAudit(db, {
      actor: opts.actor ?? `principal:${input.principalId}`,
      action: "imessage.pairing.session_created",
      reversible: true,
      outputsRef: JSON.stringify({
        sessionId: String(row.id),
        principalId: input.principalId,
        purpose: input.purpose,
        superseded: superseded.rows.length,
        expiresAt: new Date(row.expires_at as string).toISOString(),
      }),
    });
    return {
      code,
      sessionId: String(row.id),
      expiresAt: new Date(row.expires_at as string),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The single newest unconsumed, unexpired session (any principal — the CLI
 *  runs one pairing at a time; newest wins if several somehow exist). */
async function activeSession(
  db: SqlExecutor,
  now: Date,
): Promise<{ id: string; codeHash: string; guessesUsed: number; maxTotalGuesses: number; lockouts: Record<string, number> } | null> {
  const result = await db.query(
    `SELECT id::text AS id, code_hash, guesses_used, max_total_guesses, handle_lockouts
       FROM imessage_pairing_sessions
      WHERE consumed_at IS NULL AND expires_at > $1::timestamptz
      ORDER BY created_at DESC
      LIMIT 1`,
    [now.toISOString()],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const lockouts =
    row.handle_lockouts !== null && typeof row.handle_lockouts === "object"
      ? (row.handle_lockouts as Record<string, number>)
      : {};
  return {
    id: String(row.id),
    codeHash: String(row.code_hash),
    guessesUsed: Number(row.guesses_used),
    maxTotalGuesses: Number(row.max_total_guesses),
    lockouts,
  };
}

/**
 * The §5.1.1 pre-auth exception, whole and entire: EXACT sha256-equality of
 * the attempt hash against the active session's code_hash — no LLM, no
 * parsing, no fallback. Every branch (wrong/paired/locked/exhausted) audits;
 * only success writes transport_identities + consumes the session (single
 * use: the code dies on first success) + notifies the owner.
 *
 * Runs inside the CALLER'S transaction when composed with ingest; the
 * exported attemptPairing below wraps it in its own.
 */
export async function attemptPairingInTx(
  db: SqlExecutor,
  input: { handle: string; attemptHash: string },
  opts: PairingOptions = {},
): Promise<PairingAttemptResult> {
  const handle = canonicalizeHandle(input.handle);
  if (handle.length === 0 || handle.length > 255) {
    throw new PairingInputError("handle must be a non-empty string of at most 255 chars");
  }
  if (!SHA256_HEX_RE.test(input.attemptHash)) {
    throw new PairingInputError("attemptHash must be a sha256 hex string");
  }
  const now = opts.now?.() ?? new Date();
  const actor = opts.actor ?? "harness:imessage-sensor";
  const audit = (outputs: Record<string, unknown>): Promise<void> =>
    recordAudit(db, {
      actor,
      action: "imessage.pairing.rejected",
      reversible: true,
      outputsRef: JSON.stringify({ handle, ...outputs }),
    });

  const session = await activeSession(db, now);
  if (session === null) {
    await audit({ reason: "no-active-session" });
    return { paired: false, reason: "no-active-session", sessionId: null };
  }
  const wrongCount = Number(session.lockouts[handle] ?? 0);

  const existing = await db.query(
    "SELECT principal_id::text AS principal_id FROM transport_identities WHERE transport = 'imessage' AND handle = $1",
    [handle],
  );
  if (existing.rows[0] !== undefined) {
    await audit({ reason: "already-paired", sessionId: session.id });
    return { paired: false, reason: "already-paired", sessionId: session.id };
  }
  if (wrongCount >= PAIRING_HANDLE_MAX_WRONG) {
    await audit({ reason: "handle-locked", sessionId: session.id, wrongCount });
    return { paired: false, reason: "handle-locked", sessionId: session.id };
  }
  if (session.guessesUsed >= session.maxTotalGuesses) {
    await audit({ reason: "session-exhausted", sessionId: session.id, guessesUsed: session.guessesUsed });
    return { paired: false, reason: "session-exhausted", sessionId: session.id };
  }

  if (input.attemptHash !== session.codeHash) {
    // Two-layer throttle: bump BOTH the per-handle wrong count and the
    // session-wide guess counter; no identity is written.
    const lockouts = { ...session.lockouts, [handle]: wrongCount + 1 };
    await db.query(
      `UPDATE imessage_pairing_sessions
          SET guesses_used = guesses_used + 1, handle_lockouts = $2::jsonb
        WHERE id = $1::uuid`,
      [session.id, JSON.stringify(lockouts)],
    );
    await audit({ reason: "wrong-code", sessionId: session.id, wrongCount: wrongCount + 1 });
    return { paired: false, reason: "wrong-code", sessionId: session.id };
  }

  // Exact match → consume (single use), write the identity, notify the owner.
  const principal = await db.query(
    "SELECT id::text AS id, name FROM principals WHERE id = (SELECT principal_id FROM imessage_pairing_sessions WHERE id = $1::uuid)",
    [session.id],
  );
  const principalRow = principal.rows[0];
  if (principalRow === undefined) {
    throw new Error("attemptPairing: session principal vanished");
  }
  const principalId = String(principalRow.id);
  await db.query(
    `UPDATE imessage_pairing_sessions
        SET consumed_at = $2::timestamptz, consumed_handle = $3
      WHERE id = $1::uuid AND consumed_at IS NULL`,
    [session.id, now.toISOString(), handle],
  );
  await db.query(
    `INSERT INTO transport_identities (principal_id, transport, handle, verified_at, last_seen_at, paired_via_session)
     VALUES ($1::uuid, 'imessage', $2, $3::timestamptz, $3::timestamptz, $4::uuid)`,
    [principalId, handle, now.toISOString(), session.id],
  );
  await recordAudit(db, {
    actor,
    action: "imessage.pairing.paired",
    reversible: true,
    outputsRef: JSON.stringify({ handle, principalId, sessionId: session.id }),
  });
  await notifyOwnerOfPairing(db, {
    principalName: String(principalRow.name),
    handle,
    now,
  });
  return { paired: true, principalId, handle, sessionId: session.id };
}

/** Owner brief over the E4 channel (kind≠reply → edge default target). */
async function notifyOwnerOfPairing(
  db: SqlExecutor,
  input: { principalName: string; handle: string; now: Date },
): Promise<void> {
  const upsert = await db.query(
    `WITH ins AS (
       INSERT INTO principals (type, name) VALUES ('service', $1)
       ON CONFLICT (name) DO NOTHING
       RETURNING id
     )
     SELECT id FROM ins
     UNION ALL
     SELECT id FROM principals WHERE name = $1
     LIMIT 1`,
    [GATEWAY_SERVICE_PRINCIPAL],
  );
  const createdBy = upsert.rows[0]?.id;
  if (createdBy === undefined) {
    throw new Error("notifyOwnerOfPairing: could not resolve the gateway service principal");
  }
  await createNotification(
    db,
    {
      kind: "brief",
      title: `iMessage pairing: ${input.principalName} paired ${input.handle}`,
      payload: { content: "If this pairing was not expected, revoke the identity." },
      sourceType: "brief",
      createdBy: String(createdBy),
    },
    { actor: "service:imessage-gateway", now: () => input.now },
  );
}

/** Standalone pairing attempt (own transaction). */
export async function attemptPairing(
  db: ImessageDb,
  input: { handle: string; attemptHash: string },
  opts: PairingOptions = {},
): Promise<PairingAttemptResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await attemptPairingInTx(client, input, opts);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Canonical verified handles for a principal (may be empty). */
export async function verifiedHandles(db: SqlExecutor, principalId: string): Promise<readonly string[]> {
  const result = await db.query(
    `SELECT handle FROM transport_identities
      WHERE principal_id = $1::uuid AND transport = 'imessage'
      ORDER BY verified_at, handle`,
    [principalId],
  );
  return result.rows.map((row) => String(row.handle));
}

/** All paired canonical handles across principals (health projection). */
export async function pairedHandles(db: SqlExecutor): Promise<readonly string[]> {
  const result = await db.query(
    `SELECT handle FROM transport_identities WHERE transport = 'imessage' ORDER BY handle`,
  );
  return result.rows.map((row) => String(row.handle));
}

export interface PrincipalForHandle {
  readonly principalId: string;
  readonly name: string;
  readonly type: string;
}

/** The principal a canonical handle is paired to (null when unpaired). */
export async function principalForHandle(
  db: SqlExecutor,
  handle: string,
): Promise<PrincipalForHandle | null> {
  const result = await db.query(
    `SELECT p.id::text AS principal_id, p.name, p.type
       FROM transport_identities ti JOIN principals p ON p.id = ti.principal_id
      WHERE ti.transport = 'imessage' AND ti.handle = $1
      LIMIT 1`,
    [canonicalizeHandle(handle)],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { principalId: String(row.principal_id), name: String(row.name), type: String(row.type) };
}
