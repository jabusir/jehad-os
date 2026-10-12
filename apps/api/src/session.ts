/**
 * Today session + CSRF (ADR-0019 §2; W1 contract "API contract" section).
 *
 * W1 has no sessions table: the cookie is STATELESS and restart-safe. The
 * signing key is derived from the principal's own credential hash (the only
 * secret material the API keeps — auth.ts stores sha256(credential)), so a
 * cookie verifies only while that principal's credential is unchanged:
 *
 *   key   = HMAC-SHA256("jehad-ui-session-v1", credentialHash)
 *   value = base64url( principalId | expiryMs | HMAC(principalId|expiryMs, key) )
 *   csrf  = HMAC( "csrf" | principalId | expiryMs, key )
 *
 * Cookie flags: Secure + HttpOnly + SameSite=Strict, Path=/ (tailnet HTTPS;
 * ADR-0019). The CSRF token is session-scoped and embedded in every form;
 * state-changing POSTs compare it in constant time.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Principal, SqlExecutor } from "@jehad/db";
import { UUID_RE } from "@jehad/core";

export const SESSION_COOKIE = "jehad_session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Session-key separation constant — never reuse the raw credential hash. */
const SESSION_KEY_DOMAIN = "jehad-ui-session-v1";

export interface TodaySession {
  readonly principal: Principal;
  readonly expiryMs: number;
  readonly csrfToken: string;
}

function sessionKey(credentialHash: string): Buffer {
  return createHmac("sha256", SESSION_KEY_DOMAIN).update(credentialHash, "utf8").digest();
}

function macFor(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function csrfTokenFor(principalId: string, expiryMs: number, credentialHash: string): string {
  return macFor(sessionKey(credentialHash), `csrf|${principalId}|${expiryMs}`);
}

export interface IssuedSession {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly expiryMs: number;
}

/** Mints the Set-Cookie header value + the session's CSRF token. */
export function issueSession(
  principalId: string,
  credentialHash: string,
  now: Date,
): IssuedSession {
  const expiryMs = now.getTime() + SESSION_TTL_MS;
  const payload = `${principalId}|${expiryMs}`;
  const mac = macFor(sessionKey(credentialHash), payload);
  const value = Buffer.from(`${payload}|${mac}`, "utf8").toString("base64url");
  return {
    cookie:
      `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; ` +
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    csrfToken: csrfTokenFor(principalId, expiryMs, credentialHash),
    expiryMs,
  };
}

/** Reads one cookie out of a raw Cookie header (fastify core does not parse). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (typeof header !== "string" || header.length === 0) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Verifies a session cookie against the LIVE principal row (fail-closed:
 * unknown id, null credential, bad mac, expiry, or non-user principal ⇒ null).
 */
export async function verifySession(
  db: SqlExecutor,
  cookieHeader: string | undefined,
  now: Date,
): Promise<TodaySession | null> {
  const value = readCookie(cookieHeader, SESSION_COOKIE);
  if (value === null) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split("|");
  if (parts.length !== 3) return null;
  const [principalId, expiryRaw, mac] = parts as [string, string, string];
  if (!UUID_RE.test(principalId)) return null;
  const expiryMs = Number(expiryRaw);
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= now.getTime()) return null;

  const result = await db.query(
    "SELECT id, type, name, credential_hash FROM principals WHERE id = $1::uuid LIMIT 1",
    [principalId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const credentialHash =
    row.credential_hash === null || row.credential_hash === undefined
      ? null
      : String(row.credential_hash);
  if (credentialHash === null) return null;
  if (String(row.type) !== "user") return null;

  const expected = macFor(sessionKey(credentialHash), `${principalId}|${expiryMs}`);
  if (!safeEqual(mac, expected)) return null;

  return {
    principal: { id: String(row.id), type: String(row.type) as Principal["type"], name: String(row.name) },
    expiryMs,
    csrfToken: csrfTokenFor(principalId, expiryMs, credentialHash),
  };
}

/** Constant-time CSRF check (contract: "constant-time compare"). */
export function verifyCsrf(session: TodaySession, presented: unknown): boolean {
  return typeof presented === "string" && safeEqual(presented, session.csrfToken);
}
