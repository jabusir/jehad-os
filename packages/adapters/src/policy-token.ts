// packages/adapters/src/policy-token.ts — capability token primitive
// (ADR-0007 extended; policy-model.md §3.1/§3.2).
//
// Phase 1 ships the PRIMITIVE only: an opaque random token whose possession
// proves the grant. No JWT/JWS/HSM machinery (that is Phase 2+). The token is
// two base64url parts — a claims body and a 32-byte random nonce that is the
// possession secret — plus a version prefix. Storage keeps ONLY the sha256 of
// the full token string (`capability_grants.token_hash`); the plaintext token
// is presented by the caller and never persisted or logged.

import { randomBytes, createHash } from "node:crypto";

/** Claims carried by a capability token (review §5; plan §9). */
export interface CapabilityTokenClaims {
  /** Principal the grant was issued to (principal id). */
  principal: string;
  /** Run the grant is bound to; grants die with the run (null = run-less). */
  run_id: string | null;
  /** Capability vocabulary entry, e.g. "read_events", "write_entity:person". */
  capability: string;
  /** Exact resource the token is usable against — nothing else. */
  resource: string;
  /** Domain id the grant is scoped to. */
  domain: string;
  /** ISO-8601 expiry; short-lived by construction. */
  expires_at: string;
  /** Random possession secret (base64url). Guarantees token uniqueness. */
  nonce: string;
}

/** Input to minting; the nonce is generated, never caller-supplied. */
export type CapabilityTokenInput = Omit<CapabilityTokenClaims, "nonce">;

export interface MintedCapabilityToken {
  token: string;
  claims: CapabilityTokenClaims;
  /** sha256 hex of the token — the ONLY value safe to persist. */
  tokenHash: string;
}

const VERSION = "v1";
const NONCE_BYTES = 32;

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function unb64url(segment: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const bytes = Buffer.from(segment, "base64url");
  // Round-trip check: base64url is lenient; reject segments that re-encode
  // differently (padding tricks / embedded garbage).
  return b64url(bytes) === segment ? bytes : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** sha256 hex of the full token string — store this, never the token. */
export function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Mints an opaque capability token for the given claims. The random nonce is
 * generated here; two mints of identical claims produce different tokens
 * (and different hashes).
 */
export function mintCapabilityToken(input: CapabilityTokenInput): MintedCapabilityToken {
  const nonce = b64url(randomBytes(NONCE_BYTES));
  const body: Omit<CapabilityTokenClaims, "nonce"> = {
    principal: input.principal,
    run_id: input.run_id,
    capability: input.capability,
    resource: input.resource,
    domain: input.domain,
    expires_at: input.expires_at,
  };
  const encoded = b64url(Buffer.from(JSON.stringify(body), "utf8"));
  const token = `${VERSION}.${encoded}.${nonce}`;
  return {
    token,
    claims: { ...body, nonce },
    tokenHash: hashCapabilityToken(token),
  };
}

/**
 * Parses and structurally validates a presented token. Returns the claims
 * (including nonce) or null for anything malformed — wrong version, bad
 * segments, non-JSON body, or a body whose fields are not strings/null.
 * This proves structure only; scope/expiry/revocation live in the grant row.
 */
export function parseCapabilityToken(token: string): CapabilityTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, bodySegment, nonceSegment] = parts as [string, string, string];
  if (version !== VERSION) return null;
  const nonceBytes = unb64url(nonceSegment);
  if (nonceBytes === null || nonceBytes.length < NONCE_BYTES) return null;
  const bodyBytes = unb64url(bodySegment);
  if (bodyBytes === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const principal = parsed["principal"];
  const runId = parsed["run_id"];
  const capability = parsed["capability"];
  const resource = parsed["resource"];
  const domain = parsed["domain"];
  const expiresAt = parsed["expires_at"];
  if (
    typeof principal !== "string" ||
    (runId !== null && typeof runId !== "string") ||
    typeof capability !== "string" ||
    typeof resource !== "string" ||
    typeof domain !== "string" ||
    typeof expiresAt !== "string"
  ) {
    return null;
  }
  if (Number.isNaN(Date.parse(expiresAt))) return null;
  return {
    principal,
    run_id: runId,
    capability,
    resource,
    domain,
    expires_at: expiresAt,
    nonce: nonceSegment,
  };
}
