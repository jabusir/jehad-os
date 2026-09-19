// Harness grant guard (E4 OpenClaw attach — the first harness boundary).
//
// A harness principal (principal.type === "harness", e.g. OpenClaw) acts ONLY
// through grants: every harness-reachable route additionally demands a
// capability token (x-capability-token) that verifies server-side against the
// canonical capability_grants row — scoped (principal+capability+resource+
// domain), expiring (expires_at), revocable (revoked_at), auditable. The
// harness cannot mint tokens: possession is proof, and proof is checked
// against rows only the owner issues. User principals bypass the grant layer
// (they are the owner); service/workflow principals are denied everywhere.
//
// This module is the pure decision + audit core; the API layer wraps it in a
// Fastify preHandler factory (apps/api/src/routes/harness.ts).

import { recordAudit } from "../actions/audit.js";
import { verifyGrant, type GrantDenialReason, type SqlExecutor } from "./grants.js";

/** The grant domain anchor: harness grants hang off the personal domain. */
export const HARNESS_GRANT_DOMAIN_KEY = "personal";

/** The E4 harness capability vocabulary (exact grant matches only). */
export const HARNESS_CAPABILITIES = {
  /** GET /harness/state-summary — the counts-only projection. */
  stateSummary: "read:state-summary",
  /** POST /harness/notifications/claim | /:id/delivered (generic delivery grant). */
  deliverNotifications: "deliver:notifications",
  /**
   * E4-S alias for the claim/delivered seam: a send-only iMessage edge whose
   * grant says exactly what it may do (`send_channel:imessage`) — never a
   * generic delivery capability. The claim/delivered routes accept EITHER
   * capability; every other seam accepts exactly one.
   */
  sendChannelImessage: "send_channel:imessage",
} as const;

export interface HarnessPrincipalContext {
  readonly principalId?: string;
  readonly principalType?: string;
  readonly principalName?: string;
  /** x-capability-token — the possession secret for the grant. */
  readonly capabilityToken?: string | null;
  /** Injection point for tests / determinism; defaults to Date.now. */
  readonly now?: () => number;
}

export interface HarnessGrantRequirement {
  /**
   * Capabilities accepted at this seam (exact grant matches only). Routes
   * with a capability ALIAS (claim/delivered: deliver:notifications OR
   * send_channel:imessage) list both; the presented token must match one.
   */
  readonly capabilities: readonly string[];
  readonly resource: string;
}

export type HarnessGuardDecision =
  | {
      allowed: true;
      grantId: string | null;
      bypass: "owner" | "grant";
      /** The matched capability (grant bypass) or null (owner bypass). */
      readonly capability: string | null;
    }
  | {
      allowed: false;
      status: 403;
      code: "principal_type_forbidden" | "missing_capability_token" | "domain_unavailable" | GrantDenialReason;
    };

async function auditDenial(
  db: SqlExecutor,
  context: HarnessPrincipalContext,
  requirement: HarnessGrantRequirement,
  code: string,
): Promise<void> {
  await recordAudit(db, {
    actor:
      context.principalType !== undefined && context.principalName !== undefined
        ? `${context.principalType}:${context.principalName}`
        : "unauthenticated",
    action: "harness.grant_denied",
    reversible: true,
    outputsRef: JSON.stringify({
      reason: code,
      capabilities: requirement.capabilities,
      resource: requirement.resource,
      principalType: context.principalType ?? null,
    }),
  });
}

/**
 * The single harness authorization decision. Deny-by-default; every denial
 * writes an audit row (owner's checklist: "every 403 audited too"). Grant
 * verification is server-side against capability_grants — a forged, reused,
 * wrong-scope, expired, or revoked token denies with its reason.
 *
 * Capability aliases: a seam listing several capabilities accepts a token
 * matching ANY of them. Only wrong_capability is capability-dependent, so
 * the scan tries each listed capability and stops at the first denial that
 * is NOT wrong_capability (malformed/unknown/expired/revoked/… reasons are
 * identical for every candidate). The allowed decision records WHICH
 * capability matched; the denial audit records the accepted list.
 */
export async function checkHarnessGrant(
  db: SqlExecutor,
  context: HarnessPrincipalContext,
  requirement: HarnessGrantRequirement,
): Promise<HarnessGuardDecision> {
  if (context.principalType !== "user" && context.principalType !== "harness") {
    await auditDenial(db, context, requirement, "principal_type_forbidden");
    return { allowed: false, status: 403, code: "principal_type_forbidden" };
  }
  // The owner bypasses the grant layer — every surface is theirs already.
  if (context.principalType === "user") {
    return { allowed: true, grantId: null, bypass: "owner", capability: null };
  }
  if (typeof context.capabilityToken !== "string" || context.capabilityToken.length === 0) {
    await auditDenial(db, context, requirement, "missing_capability_token");
    return { allowed: false, status: 403, code: "missing_capability_token" };
  }
  if (context.principalId === undefined) {
    await auditDenial(db, context, requirement, "wrong_principal");
    return { allowed: false, status: 403, code: "wrong_principal" };
  }

  const domain = await db.query(
    "SELECT id FROM domains WHERE key = $1",
    [HARNESS_GRANT_DOMAIN_KEY],
  );
  const domainId = domain.rows[0]?.id;
  if (domainId === undefined) {
    await auditDenial(db, context, requirement, "domain_unavailable");
    return { allowed: false, status: 403, code: "domain_unavailable" };
  }

  let reason: GrantDenialReason = "wrong_capability";
  for (const capability of requirement.capabilities) {
    const decision = await verifyGrant(db, context.capabilityToken, {
      principalId: context.principalId,
      capability,
      resource: requirement.resource,
      domainId: String(domainId),
      now: context.now,
    });
    if (decision.allowed) {
      return {
        allowed: true,
        grantId: decision.grant.id,
        bypass: "grant",
        capability: decision.grant.capability,
      };
    }
    reason = decision.reason;
    if (decision.reason !== "wrong_capability") break;
  }
  await auditDenial(db, context, requirement, reason);
  return { allowed: false, status: 403, code: reason };
}
