/**
 * Shared principal-type guard (E4 generalization). Only principal.type ===
 * "user" may touch non-harness routes; harness/service/workflow principals
 * get 403 + audit_log (plan A3) — machine principals act ONLY through the
 * grant-bearing seams in routes/harness.ts. Extracted from the per-route
 * copies in events.ts/review.ts so every current and future route enforces
 * the same rule; the audit action stays `<route>.forbidden` (stable shape).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { SqlExecutor } from "@jehad/db";
import { recordAudit } from "@jehad/core";

/** 403 + audit row for non-user principals. Returns the error body. */
export async function forbidNonUser(
  db: SqlExecutor,
  request: FastifyRequest,
  route: string,
): Promise<{ error: "forbidden" }> {
  const principal = request.principal;
  await recordAudit(db, {
    actor: principal ? `${principal.type}:${principal.name}` : "unauthenticated",
    action: `${route}.forbidden`,
    reversible: true,
    outputsRef: JSON.stringify({
      reason: "principal_type_forbidden",
      principalType: principal?.type ?? null,
      method: request.method,
      url: request.url.split("?")[0] ?? request.url,
    }),
  });
  return { error: "forbidden" };
}

/** True when the request carries a user principal; otherwise sends 403. */
export async function requireUser(
  db: SqlExecutor,
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
): Promise<boolean> {
  if (request.principal?.type !== "user") {
    await reply.code(403).send(await forbidNonUser(db, request, route));
    return false;
  }
  return true;
}
