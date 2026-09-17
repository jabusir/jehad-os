/**
 * POST /events — authenticated event ingest (plan §15 M2; plan §13 sequence:
 * `CLI capture (authenticated) → POST /events → events row (idempotent,
 * schemaVersion)`), and GET /events/:id for reading one envelope back.
 *
 * All envelope validation and the events/outbox write go through
 * @jehad/core's events module — the single envelope↔column mapping point
 * (docs/event-model.md §9.1). This route owns only HTTP shape:
 * 201 + envelope on accept, 200 + existing envelope on duplicate
 * idempotency key (no-op, plan §15 M2 acceptance), deterministic 400 on a
 * malformed envelope, 404/400 on reads.
 */

import type { FastifyInstance } from "fastify";
import type { SqlExecutor } from "@jehad/db";
import {
  acceptEvent,
  DomainNotFoundError,
  getEventById,
  UUID_RE,
  validateEventIngest,
} from "@jehad/core";

export interface EventRoutesOptions {
  db: SqlExecutor;
}

export function registerEventRoutes(
  app: FastifyInstance,
  opts: EventRoutesOptions,
): void {
  app.post("/events", async (request, reply) => {
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
