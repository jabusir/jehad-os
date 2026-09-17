/**
 * POST /events — authenticated event ingest (plan §15 M2; plan §13 sequence:
 * `CLI capture (authenticated) → POST /events → events row (idempotent,
 * schemaVersion)`), and GET /events/:id for reading one envelope back.
 *
 * AUTHORITY (plan A3, v1 single-user): only principal.type === "user" may
 * ingest or read events. harness/service/workflow principals get 403 +
 * audit_log — machine principals act through grant-bearing seams, never
 * through the raw event API.
 * TODO(E4/M5): grant-based ingest arrives with harness wiring — a machine
 * principal presenting a valid capability token will be authorized per
 * grant, replacing this type gate.
 *
 * All envelope validation and the events/outbox write go through
 * @jehad/core's events module — the single envelope↔column mapping point
 * (docs/event-model.md §9.1). This route owns only HTTP shape:
 * 201 + envelope on accept, 200 + existing envelope on duplicate
 * idempotency key (no-op, plan §15 M2 acceptance), deterministic 400 on a
 * malformed envelope, 404/400 on reads.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SqlExecutor } from "@jehad/db";
import {
  acceptEvent,
  DomainNotFoundError,
  getEventById,
  recordAudit,
  UUID_RE,
  validateEventIngest,
} from "@jehad/core";

export interface EventRoutesOptions {
  db: SqlExecutor;
}

/** 403 + audit row for non-user principals (plan A3; machine principals). */
async function forbidNonUser(
  db: SqlExecutor,
  request: FastifyRequest,
): Promise<{ error: "forbidden" }> {
  const principal = request.principal;
  await recordAudit(db, {
    actor: principal ? `${principal.type}:${principal.name}` : "unauthenticated",
    action: "events.forbidden",
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

export function registerEventRoutes(
  app: FastifyInstance,
  opts: EventRoutesOptions,
): void {
  app.post("/events", async (request, reply) => {
    if (request.principal?.type !== "user") {
      return await reply.code(403).send(await forbidNonUser(opts.db, request));
    }
    const validated = validateEventIngest(request.body);
    if (!validated.ok) {
      return await reply
        .code(400)
        .send({ error: "invalid_event", code: validated.error.code, message: validated.error.message });
    }
    let accepted;
    try {
      accepted = await acceptEvent(opts.db, validated.value);
    } catch (err) {
      if (err instanceof DomainNotFoundError) {
        return await reply.code(400).send({
          error: "invalid_event",
          code: err.validationCode,
          message: err.message,
        });
      }
      throw err;
    }
    return await reply
      .code(accepted.accepted ? 201 : 200)
      .send({ duplicate: !accepted.accepted, event: accepted.envelope });
  });

  app.get("/events/:id", async (request, reply) => {
    if (request.principal?.type !== "user") {
      return await reply.code(403).send(await forbidNonUser(opts.db, request));
    }
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
      return await reply.code(400).send({ error: "invalid_event_id" });
    }
    const event = await getEventById(opts.db, id);
    if (event === null) {
      return await reply.code(404).send({ error: "not_found" });
    }
    return await reply.code(200).send({ event });
  });
}
