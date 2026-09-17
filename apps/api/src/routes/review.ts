/**
 * Review-queue HTTP surface (M6C; plan §13: "review queue: escalations +
 * semantic-promotion approvals, batched"): GET /review (the queue), POST
 * /review/:candidateId/approve|reject, GET /escalations, POST
 * /escalations/:id/resolve.
 *
 * AUTHORITY (plan A3, v1 single-user; same gate as events.ts): only
 * principal.type === "user" may act on the review queue — harness/service/
 * workflow principals get 403 + audit_log. Every approve/reject/resolve
 * writes an audit row (plan §13 acceptance item 10).
 *
 * Domain logic lives in @jehad/core (review-queue + escalations service);
 * this module owns only HTTP shape: 400 malformed ids/bodies, 404 unknown,
 * 409 wrong-state, 200 with the resulting row/outcome.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CandidateNotFoundError,
  EscalationInputError,
  EscalationNotFoundError,
  InvalidCandidateStatusError,
  InvalidEscalationStatusError,
  ModelEgressPolicyRegistry,
  UUID_RE,
  approvePromotion,
  listReviewQueue,
  loadEgressPolicyRegistry,
  recordAudit,
  rejectPromotion,
  resolveEscalation,
  type PromotionDb,
} from "@jehad/core";
import { requireUser } from "./principal-guard.js";

export interface ReviewRoutesOptions {
  /** Structural pg.Pool: query + connect() for the promotion/escalation transactions. */
  db: PromotionDb;
  /** Gate-3 egress registry for the approve path; defaults to egress-policy.yaml. */
  egressRegistry?: ModelEgressPolicyRegistry;
}

/** Lazily loaded default registry — the policy file is read once per process. */
let defaultRegistry: Promise<ModelEgressPolicyRegistry> | null = null;
function loadRegistryOnce(): Promise<ModelEgressPolicyRegistry> {
  defaultRegistry ??= loadEgressPolicyRegistry();
  return defaultRegistry;
}

function actorFor(request: FastifyRequest): string {
  const principal = request.principal;
  return principal ? `${principal.type}:${principal.name}` : "unauthenticated";
}

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export function registerReviewRoutes(
  app: FastifyInstance,
  opts: ReviewRoutesOptions,
): void {
  const db = opts.db;

  app.get("/review", async (request, reply) => {
    if (!(await requireUser(db, request, reply, "review"))) return reply;
    const queue = await listReviewQueue(db);
    return await reply.code(200).send({ queue });
  });

  app.post("/review/:candidateId/approve", async (request, reply) => {
    if (!(await requireUser(db, request, reply, "review"))) return reply;
    const { candidateId } = request.params as { candidateId: string };
    if (!UUID_RE.test(candidateId)) {
      return await reply.code(400).send({ error: "invalid_candidate_id" });
    }
    const registry = opts.egressRegistry ?? (await loadRegistryOnce());
    try {
      const outcome = await approvePromotion(db, candidateId, {
        egressRegistry: registry,
        approvedBy: request.principal!.name,
      });
      await recordAudit(db, {
        actor: actorFor(request),
        action: "review.approve",
        reversible: true,
        outputsRef: JSON.stringify({ candidateId, action: outcome.action, eventId: outcome.eventId }),
      });
      return await reply.code(200).send({ outcome });
    } catch (err) {
      if (err instanceof CandidateNotFoundError) {
        return await reply.code(404).send({ error: "not_found" });
      }
      if (err instanceof InvalidCandidateStatusError) {
        return await reply.code(409).send({ error: "conflict", message: err.message });
      }
      throw err;
    }
  });

  app.post("/review/:candidateId/reject", async (request, reply) => {
    if (!(await requireUser(db, request, reply, "review"))) return reply;
    const { candidateId } = request.params as { candidateId: string };
    if (!UUID_RE.test(candidateId)) {
      return await reply.code(400).send({ error: "invalid_candidate_id" });
    }
    const noteRaw = bodyObject(request).note;
    const note = typeof noteRaw === "string" && noteRaw.length > 0 ? noteRaw : undefined;
    const existing = await db.query(
      "SELECT 1 AS ok FROM memory_candidates WHERE id = $1::uuid",
      [candidateId],
    );
    if (existing.rows.length === 0) {
      return await reply.code(404).send({ error: "not_found" });
    }
    try {
      const rejection = await rejectPromotion(db, candidateId, {
        rejectedBy: request.principal!.name,
        note,
      });
      await recordAudit(db, {
        actor: actorFor(request),
        action: "review.reject",
        reversible: false,
        outputsRef: JSON.stringify({ candidateId, status: rejection.status, note: note ?? null }),
      });
      return await reply.code(200).send({ rejection });
    } catch (err) {
      if (err instanceof Error && /not in_review|left in_review/.test(err.message)) {
        return await reply.code(409).send({ error: "conflict", message: err.message });
      }
      throw err;
    }
  });

  app.get("/escalations", async (request, reply) => {
    if (!(await requireUser(db, request, reply, "escalations"))) return reply;
    const escalations = await db.query(
      `SELECT id, run_id, reason, urgency, consequence_of_waiting, est_human_minutes,
              blocked_run_ids, status, created_at
       FROM escalations
       WHERE status IN ('pending', 'batched')
       ORDER BY CASE urgency
                  WHEN 'blocker' THEN 5 WHEN 'critical' THEN 4 WHEN 'high' THEN 3
                  WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
                est_human_minutes ASC NULLS LAST,
                created_at ASC
       LIMIT 200`,
    );
    return await reply.code(200).send({ escalations: escalations.rows });
  });

  app.post("/escalations/:id/resolve", async (request, reply) => {
    if (!(await requireUser(db, request, reply, "escalations"))) return reply;
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
      return await reply.code(400).send({ error: "invalid_escalation_id" });
    }
    const resolutionRaw = bodyObject(request).resolution;
    if (typeof resolutionRaw !== "string" || resolutionRaw.trim().length === 0) {
      return await reply.code(400).send({ error: "invalid_resolution" });
    }
    try {
      const resolved = await resolveEscalation(db, id, { resolution: resolutionRaw });
      await recordAudit(db, {
        actor: actorFor(request),
        action: "escalation.resolve",
        reversible: true,
        outputsRef: JSON.stringify({
          escalationId: id,
          resolution: resolutionRaw,
          closedHumanWaits: resolved.closedHumanWaits,
          eventId: resolved.eventId,
        }),
      });
      return await reply.code(200).send({
        escalation: resolved.escalation,
        closedHumanWaits: resolved.closedHumanWaits,
      });
    } catch (err) {
      if (err instanceof EscalationNotFoundError) {
        return await reply.code(404).send({ error: "not_found" });
      }
      if (err instanceof InvalidEscalationStatusError) {
        return await reply.code(409).send({ error: "conflict", message: err.message });
      }
      if (err instanceof EscalationInputError) {
        return await reply.code(400).send({ error: "invalid_resolution", message: err.message });
      }
      throw err;
    }
  });
}
