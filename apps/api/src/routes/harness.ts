/**
 * Harness surface (E4 OpenClaw attach) — EXACTLY three routes, each behind
 * the harness grant guard (core policy/harness-guard.ts):
 *
 *   GET  /harness/state-summary           grant read:state-summary
 *   POST /harness/notifications/claim     grant deliver:notifications
 *                                         OR send_channel:imessage (E4-S alias)
 *   POST /harness/notifications/:id/delivered   same alias as claim
 *
 * The delivered report may carry a loop-defense fingerprint (Phase A):
 * { recipient, rendered_text_sha256 } — stored as a sent_message_fingerprints
 * row (table owned by migration 010) for sensor-side loop correlation. A
 * body-less report still records delivery (legacy edge shape, test-pinned).
 *
 * The E4-S alias lets a send-only iMessage edge principal hold a grant that
 * says exactly `send_channel:imessage` (nothing generic); the guard accepts
 * either capability and the audit chain records which one authorized the
 * call (grant_id → capability_grants.capability, plus the explicit
 * grantCapability on claim/delivered audit rows).
 *
 * The harness authenticates with BOTH its bearer credential (setupAuth) and
 * its capability token (x-capability-token); the grant check is server-side
 * against capability_grants — scoped, expiring, auditable, revocable. User
 * principals bypass the grant layer (owner). Every other route in the app
 * rejects harness principals via the shared principal-type guard.
 *
 * state-summary is a federated-style projection ONLY: counts and one bool.
 * NO content, NO titles, NO domain-scoped reads — the harness learns THAT
 * something waits, never WHAT it says. Payloads leave only through claim,
 * and only after user review approved them (policy auto-approve aside).
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PromotionDb } from "@jehad/core";
import {
  HARNESS_CAPABILITIES,
  InvalidNotificationStatusError,
  NotificationExpiredError,
  NotificationNotFoundError,
  UUID_RE,
  checkHarnessGrant,
  claimNextApprovedNotification,
  markDelivered,
  recordAudit,
} from "@jehad/core";

export interface HarnessRoutesOptions {
  /** Structural pg.Pool: query + connect() (claim/deliver run transactions). */
  db: PromotionDb;
}

const CAPABILITY_TOKEN_HEADER = "x-capability-token";

/** The claim/delivered seam's accepted capabilities (E4-S alias included). */
const DELIVER_CAPABILITIES: readonly string[] = [
  HARNESS_CAPABILITIES.deliverNotifications,
  HARNESS_CAPABILITIES.sendChannelImessage,
];

declare module "fastify" {
  interface FastifyRequest {
    /** Grant that authorized the current harness call (guard output). */
    harnessGrantId?: string | null;
    /** Capability that authorized the current harness call (guard output). */
    harnessCapability?: string | null;
  }
}

function actorFor(request: FastifyRequest): string {
  const principal = request.principal;
  return principal ? `${principal.type}:${principal.name}` : "unauthenticated";
}

/** Fastify preHandler type (structural — avoids importing internals). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Fastify preHandler factory composing the core guard with the auth
 * middleware: for principal.type === "harness" every route here additionally
 * demands a verified capability token; users pass as owner; everyone else
 * 403s. Denials are audited inside the guard (harness.grant_denied).
 * Shared by the iMessage sensor surface (harness-imessage.ts).
 */
export function requireHarnessGrant(
  db: PromotionDb,
  capabilities: readonly string[],
  resource: string,
): PreHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers[CAPABILITY_TOKEN_HEADER];
    const decision = await checkHarnessGrant(db, {
      principalId: request.principal?.id,
      principalType: request.principal?.type,
      principalName: request.principal?.name,
      capabilityToken: typeof header === "string" ? header : undefined,
    }, { capabilities, resource });
    if (!decision.allowed) {
      return await reply
        .code(decision.status)
        .send({ error: "forbidden", code: decision.code });
    }
    request.harnessGrantId = decision.grantId;
    request.harnessCapability = decision.capability;
  };
}

/** Fixed shape: counts + one bool. Asserted by tests; change = a break. */
interface StateSummary {
  pendingReviews: number;
  openEscalations: Readonly<Record<"blocker" | "critical" | "high" | "medium" | "low" | "unranked", number>>;
  todayBriefReady: boolean;
}

/** Loop-defense fingerprint pair (Phase A — imessage-gateway.md §5.2). */
interface DeliveryReport {
  readonly recipient: string;
  readonly renderedTextSha256: string;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Parses the delivered-report body.
 *   undefined → legacy report (no body): delivery recorded, NO fingerprint.
 *   null      → malformed: 400 before ANY state change.
 * When present, `recipient` and `rendered_text_sha256` must BOTH be present
 * (the fingerprint row requires both); the hash is 64 lowercase hex chars.
 */
function parseDeliveryReport(body: unknown): DeliveryReport | undefined | null {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const recipient = record["recipient"];
  const hash = record["rendered_text_sha256"];
  const hasRecipient = recipient !== undefined;
  const hasHash = hash !== undefined;
  if (!hasRecipient && !hasHash) return undefined; // {} — legacy-shape body
  const recipientOk =
    typeof recipient === "string" && recipient.trim().length > 0 && recipient.length <= 320;
  const hashOk = typeof hash === "string" && SHA256_HEX_RE.test(hash);
  if (!recipientOk || !hashOk) return null;
  return { recipient, renderedTextSha256: hash };
}

/**
 * Stores what the edge actually sent so the shadow sensor can correlate our
 * own deliveries out of the inbound stream (loop defense, defense-in-depth
 * behind the sensor's is_from_me primary guard). The
 * sent_message_fingerprints TABLE belongs to migration 010 (Lane B); this
 * write happens ONLY for delivery reports that carry the fingerprint pair.
 */
async function recordSentMessageFingerprint(
  db: PromotionDb,
  input: {
    readonly notificationId: string;
    readonly recipient: string;
    readonly renderedTextSha256: string;
    readonly deliveredAt: string;
    readonly actor: string;
    readonly grantId: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO sent_message_fingerprints
       (id, notification_id, recipient, rendered_text_sha256, delivered_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz)`,
    [
      randomUUID(),
      input.notificationId,
      input.recipient,
      input.renderedTextSha256,
      input.deliveredAt,
    ],
  );
  await recordAudit(db, {
    actor: input.actor,
    action: "notification.fingerprint_recorded",
    reversible: true,
    grantId: input.grantId,
    outputsRef: JSON.stringify({
      notificationId: input.notificationId,
      recipient: input.recipient,
      renderedTextSha256: input.renderedTextSha256,
    }),
  });
}

export function registerHarnessRoutes(
  app: FastifyInstance,
  opts: HarnessRoutesOptions,
): void {
  const db = opts.db;

  app.get(
    "/harness/state-summary",
    { preHandler: [requireHarnessGrant(db, [HARNESS_CAPABILITIES.stateSummary], "state-summary")] },
    async (request, reply) => {
      const [reviews, escalations, brief] = await Promise.all([
        db.query("SELECT count(*)::int AS n FROM memory_candidates WHERE status = 'in_review'"),
        db.query(
          `SELECT urgency, count(*)::int AS n FROM escalations
           WHERE status IN ('pending', 'batched') GROUP BY urgency`,
        ),
        db.query(
          `SELECT EXISTS (
             SELECT 1 FROM artifacts
             WHERE kind IN ('brief', 'close')
               AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
           ) AS ready`,
        ),
      ]);
      const openEscalations: Record<keyof StateSummary["openEscalations"], number> = {
        blocker: 0, critical: 0, high: 0, medium: 0, low: 0, unranked: 0,
      };
      for (const row of escalations.rows) {
        const urgency = row.urgency === null || row.urgency === undefined ? "unranked" : String(row.urgency);
        if (urgency in openEscalations) {
          openEscalations[urgency as keyof typeof openEscalations] += Number(row.n);
        } else {
          openEscalations.unranked += Number(row.n);
        }
      }
      const summary: StateSummary = {
        pendingReviews: Number(reviews.rows[0]?.n ?? 0),
        openEscalations,
        todayBriefReady: Boolean(brief.rows[0]?.ready),
      };
      await recordAudit(db, {
        actor: actorFor(request),
        action: "harness.state_summary",
        reversible: true,
        grantId: request.harnessGrantId ?? null,
        outputsRef: JSON.stringify(summary),
      });
      return await reply.code(200).send(summary);
    },
  );

  app.post(
    "/harness/notifications/claim",
    { preHandler: [requireHarnessGrant(db, DELIVER_CAPABILITIES, "notifications")] },
    async (request, reply) => {
      const principal = request.principal!;
      const notification = await claimNextApprovedNotification(db, {
        claimedBy: principal.id,
        actor: actorFor(request),
        grantId: request.harnessGrantId ?? null,
        grantCapability: request.harnessCapability ?? null,
      });
      return await reply.code(200).send({ notification });
    },
  );

  app.post(
    "/harness/notifications/:id/delivered",
    { preHandler: [requireHarnessGrant(db, DELIVER_CAPABILITIES, "notifications")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) {
        return await reply.code(400).send({ error: "invalid_notification_id" });
      }
      const report = parseDeliveryReport(request.body);
      if (report === null) {
        return await reply.code(400).send({
          error: "invalid_delivery_report",
          message:
            "body must be absent/empty or carry BOTH recipient (non-empty string) and rendered_text_sha256 (64-char lowercase sha256 hex)",
        });
      }
      const principal = request.principal!;
      try {
        const notification = await markDelivered(db, id, {
          deliveredBy: principal.id,
          actor: actorFor(request),
          grantId: request.harnessGrantId ?? null,
          grantCapability: request.harnessCapability ?? null,
        });
        if (report !== undefined) {
          if (notification.deliveredAt === null) {
            throw new Error("delivered report missing delivered_at (fingerprint not recorded)");
          }
          await recordSentMessageFingerprint(db, {
            notificationId: notification.id,
            recipient: report.recipient,
            renderedTextSha256: report.renderedTextSha256,
            deliveredAt: notification.deliveredAt,
            actor: actorFor(request),
            grantId: request.harnessGrantId ?? null,
          });
        }
        return await reply.code(200).send({ notification });
      } catch (err) {
        if (err instanceof NotificationNotFoundError) {
          return await reply.code(404).send({ error: "not_found" });
        }
        if (err instanceof NotificationExpiredError) {
          return await reply.code(409).send({ error: "expired", message: err.message });
        }
        if (err instanceof InvalidNotificationStatusError) {
          return await reply.code(409).send({ error: "conflict", message: err.message });
        }
        throw err;
      }
    },
  );
}
