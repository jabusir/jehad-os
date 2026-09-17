// packages/core/src/policy/grants.ts — capability grant service
// (policy-model.md §3; ADR-0007 extended; plan §9, plan §7 capability_grants).
//
// Deny by default: a run acts only through capability_grants issued at
// dispatch. Grants are per principal+run, short-lived, revoked at run end,
// and revocable by domain (kill switch, plan §11 T7). Possession is verified
// by the opaque capability token primitive (@jehad/adapters policy-token):
// the row stores only token_hash; the plaintext token is returned by
// issueGrant exactly once and never persisted or logged.

import {
  hashCapabilityToken,
  mintCapabilityToken,
  parseCapabilityToken,
} from "@jehad/adapters";

/** Structural subset of pg.Pool/PoolClient — no dependency on pg here. */
export interface SqlExecutor {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface GrantRecord {
  id: string;
  principalId: string;
  runId: string | null;
  capability: string;
  resource: string;
  domainId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  tokenHash: string;
}

export type GrantDenialReason =
  | "malformed_token"
  | "unknown_token"
  | "claims_mismatch"
  | "revoked"
  | "expired"
  | "wrong_principal"
  | "wrong_capability"
  | "wrong_resource"
  | "wrong_domain";

export type GrantDecision =
  | { allowed: true; grant: GrantRecord }
  | { allowed: false; reason: GrantDenialReason };

export interface IssueGrantInput {
  principalId: string;
  runId: string | null;
  capability: string;
  resource: string;
  domainId: string;
  /** Absolute expiry (ISO string or Date). Mutually exclusive with ttlMs. */
  expiresAt?: string | Date;
  /** Lifetime in milliseconds from now. Mutually exclusive with expiresAt. */
  ttlMs?: number;
  /** Injection point for tests / determinism; defaults to Date.now. */
  now?: () => number;
}

export interface IssuedGrant {
  grant: GrantRecord;
  /** Plaintext token — shown once, to the grantee; only the hash is stored. */
  token: string;
}

const GRANT_COLUMNS = "id, principal_id, run_id, capability, resource, domain_id, expires_at, revoked_at, token_hash";

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function mapGrantRow(row: Record<string, unknown>): GrantRecord {
  return {
    id: String(row["id"]),
    principalId: String(row["principal_id"]),
    runId: row["run_id"] === null || row["run_id"] === undefined ? null : String(row["run_id"]),
    capability: String(row["capability"]),
    resource: String(row["resource"]),
    domainId: String(row["domain_id"]),
    expiresAt: toDate(row["expires_at"]),
    revokedAt:
      row["revoked_at"] === null || row["revoked_at"] === undefined
        ? null
        : toDate(row["revoked_at"]),
    tokenHash: String(row["token_hash"]),
  };
}

/**
 * Issues a grant at dispatch: mints the capability token, stores the row with
 * token_hash ONLY, and returns the plaintext token exactly once. Expiry must
 * be explicit (expiresAt or ttlMs) — grants are short-lived by construction.
 */
export async function issueGrant(
  db: SqlExecutor,
  input: IssueGrantInput,
): Promise<IssuedGrant> {
  if (input.expiresAt !== undefined && input.ttlMs !== undefined) {
    throw new TypeError("issueGrant: pass expiresAt or ttlMs, not both");
  }
  if (input.expiresAt === undefined && input.ttlMs === undefined) {
    throw new TypeError("issueGrant: an explicit expiry is required (expiresAt or ttlMs)");
  }
  const now = input.now?.() ?? Date.now();
  const expiresAt =
    input.expiresAt !== undefined
      ? toDate(input.expiresAt)
      : new Date(now + input.ttlMs!);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new TypeError("issueGrant: invalid expiresAt");
  }
  if (expiresAt.getTime() <= now) {
    throw new RangeError("issueGrant: expiresAt must be in the future");
  }

  const minted = mintCapabilityToken({
    principal: input.principalId,
    run_id: input.runId,
    capability: input.capability,
    resource: input.resource,
    domain: input.domainId,
    expires_at: expiresAt.toISOString(),
  });

  const result = await db.query(
    `INSERT INTO capability_grants
       (principal_id, run_id, capability, resource, domain_id, expires_at, token_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${GRANT_COLUMNS}`,
    [
      input.principalId,
      input.runId,
      input.capability,
      input.resource,
      input.domainId,
      expiresAt,
      minted.tokenHash,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("issueGrant: no row returned");
  }
  return { grant: mapGrantRow(row), token: minted.token };
}

export interface VerifyGrantRequest {
  /** Authenticated caller — must be the grant's principal. */
  principalId: string;
  /** Requested capability; exact match against the grant (non-escalatable). */
  capability: string;
  /** Requested resource; exact match — unusable outside the granted resource. */
  resource: string;
  /** Requested domain; exact match — unusable outside the granted domain. */
  domainId: string;
  now?: () => number;
}

/**
 * Verifies possession + scope of a presented token against the canonical
 * grant row. Lookup is by sha256(token); every dimension must match and the
 * grant must be unexpired and unrevoked. Any failure is a denial — callers
 * translate denials to 403 + audit at the API boundary (plan §15 M4).
 */
export async function verifyGrant(
  db: SqlExecutor,
  token: string,
  request: VerifyGrantRequest,
): Promise<GrantDecision> {
  const claims = parseCapabilityToken(token);
  if (claims === null) return { allowed: false, reason: "malformed_token" };

  const result = await db.query(
    `SELECT ${GRANT_COLUMNS} FROM capability_grants WHERE token_hash = $1 LIMIT 1`,
    [hashCapabilityToken(token)],
  );
  const row = result.rows[0];
  if (row === undefined) return { allowed: false, reason: "unknown_token" };
  const grant = mapGrantRow(row);

  // Presented claims must match the canonical row exactly; a token whose
  // body disagrees with its hash's row proves nothing.
  if (
    claims.principal !== grant.principalId ||
    claims.run_id !== grant.runId ||
    claims.capability !== grant.capability ||
    claims.resource !== grant.resource ||
    claims.domain !== grant.domainId ||
    claims.expires_at !== grant.expiresAt.toISOString()
  ) {
    return { allowed: false, reason: "claims_mismatch" };
  }

  const now = request.now?.() ?? Date.now();
  if (grant.revokedAt !== null) return { allowed: false, reason: "revoked" };
  if (grant.expiresAt.getTime() <= now) return { allowed: false, reason: "expired" };
  if (request.principalId !== grant.principalId) {
    return { allowed: false, reason: "wrong_principal" };
  }
  if (request.capability !== grant.capability) {
    return { allowed: false, reason: "wrong_capability" };
  }
  if (request.resource !== grant.resource) {
    return { allowed: false, reason: "wrong_resource" };
  }
  if (request.domainId !== grant.domainId) {
    return { allowed: false, reason: "wrong_domain" };
  }
  return { allowed: true, grant };
}

/** Revokes a single grant (sets revoked_at). Idempotent. */
export async function revokeGrant(
  db: SqlExecutor,
  grantId: string,
): Promise<GrantRecord | null> {
  const result = await db.query(
    `UPDATE capability_grants
     SET revoked_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING ${GRANT_COLUMNS}`,
    [grantId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapGrantRow(row);
}

/** Run-end revocation: grants die with the run (plan §9). Returns count. */
export async function revokeGrantsForRun(
  db: SqlExecutor,
  runId: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE capability_grants
     SET revoked_at = now(), updated_at = now()
     WHERE run_id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [runId],
  );
  return result.rows.length;
}

/** Kill switch: revoke every live grant in a domain (plan §11 T7). Returns count. */
export async function revokeGrantsByDomain(
  db: SqlExecutor,
  domainId: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE capability_grants
     SET revoked_at = now(), updated_at = now()
     WHERE domain_id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [domainId],
  );
  return result.rows.length;
}
