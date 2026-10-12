/**
 * Attention JSON API (W1 contract §"API contract", lane D; ADR-0018
 * semantics live in @jehad/core — this module owns only HTTP shape).
 *
 * Bearer-authed (the instance-wide auth hook) + USER-ONLY (the shared
 * principal guard, same rule as notifications/review). Every service call is
 * principal-scoped and fail-closed: an unknown or foreign item id is
 * indistinguishable from a nonexistent one → 404, never an error leak.
 *
 * NOTE(lane D): resolve/dismiss/markSeen/snooze/listOpenAttention are the
 * attention service (lane B) — the only import surface that does not compile
 * standalone until that lane merges (expected gap).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SqlExecutor } from "@jehad/db";
import {
  FeedbackInputError,
  UUID_RE,
  isFeedbackVerdict,
  recordFeedback,
} from "@jehad/core";
import {
  dismissAttention,
  listOpenAttention,
  markSeen,
  resolveAttention,
  snoozeAttention,
} from "@jehad/core";
import { requireUser } from "./principal-guard.js";

export interface AttentionRoutesOptions {
  db: SqlExecutor;
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

export function registerAttentionRoutes(
  app: FastifyInstance,
  opts: AttentionRoutesOptions,
): void {
  const db = opts.db;

  app.get("/attention", async (request, reply) => {
    if (!(await requireUser(db, request, reply, "attention"))) return reply;
    const items = await listOpenAttention(db, request.principal!.id, {
      now: new Date(),
      includeSnoozed: true, // contract: open + snoozed
    });
    return await reply.code(200).send({ items });
  });

  for (const [action, call] of [
    ["resolve", (id: string, principalId: string, actor: string) =>
      resolveAttention(db, principalId, id, { now: new Date(), actor, by: "owner" })],
    ["dismiss", (id: string, principalId: string, actor: string) =>
      dismissAttention(db, principalId, id, { now: new Date(), actor })],
    ["seen", (id: string, principalId: string, actor: string) =>
      markSeen(db, principalId, id, { now: new Date(), actor })],
  ] as const) {
    app.post(`/attention/:id/${action}`, async (request, reply) => {
      if (!(await requireUser(db, request, reply, "attention"))) return reply;
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) {
        return await reply.code(400).send({ error: "invalid_item_id" });
      }
      const item = await call(id, request.principal!.id, actorFor(request));
      if (item === null) {
        return await reply.code(404).send({ error: "not_found" });
      }
      return await reply.code(200).send({ item });
    });
  }

  app.post("/attention/:id/snooze", async (request, reply) => {
    if (!(await requireUser(db, request, reply, "attention"))) return reply;
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
      return await reply.code(400).send({ error: "invalid_item_id" });
    }
    const minutesRaw = bodyObject(request).minutes;
    const minutes = typeof minutesRaw === "number" ? minutesRaw : Number(minutesRaw);
    if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 4320) {
      return await reply.code(400).send({ error: "invalid_minutes" });
    }
    const item = await snoozeAttention(
      db, request.principal!.id, id, minutes,
      { now: new Date(), actor: actorFor(request) },
    );
    if (item === null) {
      return await reply.code(404).send({ error: "not_found" });
    }
    return await reply.code(200).send({ item });
  });

  app.post("/attention/:id/feedback", async (request, reply) => {
    if (!(await requireUser(db, request, reply, "attention"))) return reply;
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) {
      return await reply.code(400).send({ error: "invalid_item_id" });
    }
    const verdict = bodyObject(request).verdict;
    if (!isFeedbackVerdict(verdict)) {
      return await reply.code(400).send({ error: "invalid_verdict" });
    }
    // Fail-closed ownership gate: the feedback table is item_id-loose (no FK,
    // migration 008), so the route enforces principal scoping itself.
    const owned = await db.query(
      "SELECT 1 FROM attention_items WHERE id = $1::uuid AND principal_id = $2::uuid LIMIT 1",
      [id, request.principal!.id],
    );
    if (owned.rows.length === 0) {
      return await reply.code(404).send({ error: "not_found" });
    }
    try {
      const { feedback } = await recordFeedback(db, {
        itemType: "attention_item",
        itemId: id,
        verdict,
        createdBy: request.principal!.id,
      });
      return await reply.code(200).send({ feedback });
    } catch (err) {
      if (err instanceof FeedbackInputError) {
        return await reply.code(400).send({ error: "invalid_verdict", message: err.message });
      }
      throw err;
    }
  });
}
