/**
 * User-side notification review surface (E4): GET /notifications (list +
 * status/kind filters) and POST /notifications/:id/approve|reject. User
 * principal ONLY — the queue sits behind user review; harness principals
 * approve nothing (the harness routes are read/claim/deliver only), so the
 * shared principal-type guard 403s + audits machine principals here.
 *
 * Domain logic lives in @jehad/core (notifications service); this module
 * owns HTTP shape: 400 malformed ids/filters, 404 unknown, 409 wrong-state,
 * 200 with the resulting row.
 */

import type { FastifyInstance } from "fastify";
import type { SqlExecutor } from "@jehad/db";
import {
  InvalidNotificationStatusError,
  NotificationInputError,
  NotificationNotFoundError,
  UUID_RE,
  approveNotification,
  listNotifications,
  rejectNotification,
  type NotificationKind,
  type NotificationStatus,
} from "@jehad/core";
import { requireUser } from "./principal-guard.js";

export interface NotificationRoutesOptions {
  db: SqlExecutor;
}

function actorFor(request: { principal?: { type: string; name: string } }): string {
  const principal = request.principal;
  return principal ? `${principal.type}:${principal.name}` : "unauthenticated";
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  opts: NotificationRoutesOptions,
): void {
  const db = opts.db;

  app.get("/notifications", async (request, reply) => {
    if (!(await requireUser(db, request, reply, "notifications"))) return reply;
    const query = request.query as Record<string, string | undefined>;
    const filters: { status?: NotificationStatus; kind?: NotificationKind; limit?: number } = {};
    if (query.status !== undefined) filters.status = query.status as NotificationStatus;
    if (query.kind !== undefined) filters.kind = query.kind as NotificationKind;
    if (query.limit !== undefined) {
      const limit = Number(query.limit);
      if (!Number.isSafeInteger(limit)) {
        return await reply.code(400).send({ error: "invalid_limit" });
      }
      filters.limit = limit;
    }
    try {
      const notifications = await listNotifications(db, filters);
      return await reply.code(200).send({ notifications });
    } catch (err) {
      if (err instanceof NotificationInputError) {
        return await reply.code(400).send({ error: "invalid_filter", message: err.message });
      }
      throw err;
    }
  });

  for (const action of ["approve", "reject"] as const) {
    app.post(`/notifications/:id/${action}`, async (request, reply) => {
      if (!(await requireUser(db, request, reply, "notifications"))) return reply;
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) {
        return await reply.code(400).send({ error: "invalid_notification_id" });
      }
      const principal = request.principal!;
      try {
        const notification =
          action === "approve"
            ? await approveNotification(db, id, {
                approvedBy: principal.id,
                actor: actorFor(request),
              })
            : await rejectNotification(db, id, { actor: actorFor(request) });
        return await reply.code(200).send({ notification });
      } catch (err) {
        if (err instanceof NotificationNotFoundError) {
          return await reply.code(404).send({ error: "not_found" });
        }
        if (err instanceof InvalidNotificationStatusError) {
          return await reply.code(409).send({ error: "conflict", message: err.message });
        }
        throw err;
      }
    });
  }
}
