/**
 * Tailscale identity-based Today login (W1.2; ADR-0019 trust boundary).
 *
 * AUTHENTICATION uses ONLY `Tailscale-User-Login`, matched against an exact
 * owner-controlled allowlist that maps an exact Tailscale login to an exact
 * Jehad OS principal NAME. The mapping deliberately lives OUTSIDE the repo
 * (personal identity): a JSON file at
 *
 *   $TODAY_AUTH_CONFIG  (default: ~/.config/jehad/today-auth.json)
 *
 *   { "tailscale": { "enabled": true,
 *                    "identities": { "<exact-tailscale-login>": "josctl" } } }
 *
 * Trust boundary (documented in docs/deploy/today-tailnet.md):
 *  - Tailscale Serve strips client-supplied Tailscale-User-* headers before
 *    adding its own; the API stays bound to 127.0.0.1 so the ONLY path to
 *    these headers is through Serve.
 *  - TAILNET ACCESS != JEHAD OS AUTHORIZATION: shared external users can
 *    also receive identity headers on a shared device. Only an exact login
 *    present in the allowlist, mapped to an exact type=user principal with
 *    a credential (session keys derive from it), gets a Today session.
 *  - A process already executing on the Mac Mini can reach localhost
 *    directly and forge headers: host compromise is outside the
 *    remote-client trust boundary (it already compromises Jehad OS state).
 *  - Fail-closed: feature disabled in config, unlisted login, missing
 *    header, tagged/no-user identity, non-user principal, or a principal
 *    without a credential ⇒ NO automatic session (recovery login remains).
 */

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { SqlExecutor } from "@jehad/db";
import { findPrincipalByName, type PrincipalRecord } from "@jehad/db";

export interface TodayAuthPolicy {
  readonly enabled: boolean;
  /** exact Tailscale login → exact Jehad OS principal name */
  readonly identities: Readonly<Record<string, string>>;
}

export const DEFAULT_TODAY_AUTH_POLICY: TodayAuthPolicy = { enabled: false, identities: {} };

function projectParsed(parsed: unknown): TodayAuthPolicy {
  if (parsed === null || typeof parsed !== "object") return DEFAULT_TODAY_AUTH_POLICY;
  const ts = (parsed as { tailscale?: unknown }).tailscale;
  if (ts === null || typeof ts !== "object") return DEFAULT_TODAY_AUTH_POLICY;
  const { enabled, identities } = ts as { enabled?: unknown; identities?: unknown };
  if (identities === null || typeof identities !== "object") {
    return { enabled: enabled === true, identities: {} };
  }
  const map: Record<string, string> = {};
  for (const [login, principalName] of Object.entries(identities as Record<string, unknown>)) {
    if (typeof login === "string" && login.length > 0 && typeof principalName === "string" && principalName.length > 0) {
      map[login] = principalName;
    }
  }
  return { enabled: enabled === true, identities: map };
}

function defaultConfigPath(): string {
  return process.env.TODAY_AUTH_CONFIG ?? path.join(os.homedir(), ".config", "jehad", "today-auth.json");
}

let cached: Promise<TodayAuthPolicy> | null = null;

/**
 * Production source: the out-of-repo JSON config, read once per process
 * (notifications-config lifecycle — an allowlist change takes effect on
 * process restart). Missing file ⇒ fail-closed defaults. Tests pass an
 * explicit path.
 */
export async function loadTodayAuthPolicy(file?: string): Promise<TodayAuthPolicy> {
  const resolved = file ?? defaultConfigPath();
  if (file === undefined) {
    cached ??= readConfig(resolved);
    return cached;
  }
  return readConfig(resolved);
}

/** Test seam — resets the memoized production policy. */
export function resetTodayAuthPolicyCache(): void {
  cached = null;
}

async function readConfig(resolved: string): Promise<TodayAuthPolicy> {
  try {
    return projectParsed(JSON.parse(await fs.readFile(resolved, "utf8")));
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_TODAY_AUTH_POLICY;
    }
    if (err instanceof SyntaxError) {
      // Malformed config fails CLOSED, not open.
      return DEFAULT_TODAY_AUTH_POLICY;
    }
    throw err;
  }
}

/** The single header used for AUTHENTICATION (never display name / profile pic). */
export function tailscaleLoginFromHeaders(headers: Record<string, unknown> | undefined): string | null {
  if (headers === undefined) return null;
  const raw = headers["tailscale-user-login"];
  if (typeof raw !== "string") return null;
  const login = raw.trim();
  return login.length > 0 ? login : null;
}

/**
 * Exact allowlist → exact principal mapping. Returns null (fail closed) for:
 * disabled policy, unlisted login, missing header, mapped principal not
 * found, non-user principal, or a user principal without a credential
 * (session keys derive from the credential hash).
 */
export async function resolveTailscalePrincipal(
  db: SqlExecutor,
  headers: Record<string, unknown> | undefined,
  policy: TodayAuthPolicy,
): Promise<PrincipalRecord | null> {
  if (!policy.enabled) return null;
  const login = tailscaleLoginFromHeaders(headers);
  if (login === null) return null;
  const principalName = policy.identities[login];
  if (principalName === undefined) return null;
  const principal = await findPrincipalByName(db, principalName);
  if (principal === null || principal.type !== "user" || principal.credentialHash === null) {
    return null;
  }
  return principal;
}
