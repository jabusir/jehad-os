/**
 * iMessage shadow-sensor harness surface (gateway Phase A Lane B; pairing +
 * conversation wiring, multi-principal Lane P) — EXACTLY two routes, both
 * behind the dedicated `imessage:ingest` capability (a separate grant from
 * send_channel:imessage: the observer and the sender are different
 * principals; neither token validates at the other's seam):
 *
 *   POST /harness/imessage/ingest   grant imessage:ingest (resource imessage)
 *   POST /harness/imessage/health   same grant
 *
 * PRIVACY RULE: ingest stores metadata, lengths, hashes, decoder status
 * ONLY — third-party message CONTENT never persists. Paired-handle content
 * is transient: it rides memory to the conversation handler (below) and no
 * further; content on an unpaired handle is discarded + audited (violation).
 *
 * Ingest is idempotent on guid (at-least-once sensor → exactly-once
 * control plane); the cursor upsert rides the same transaction. Health
 * reports upsert the five-dim state + write an audit entry, and the
 * response carries `paired_handles` (canonical, all principals) so the
 * sensor knows which handles may batch decoded CONTENT vs pairing hashes
 * (Lane R contract; the server enforces it regardless of the sensor).
 */

import type { FastifyInstance } from "fastify";
import type { ModelProvider } from "@jehad/adapters";
import { createOpenRouterProvider } from "@jehad/adapters";
import type { PromotionDb } from "@jehad/core";
import {
  HARNESS_CAPABILITIES,
  ImessageInputError,
  handleInbound,
  ingestBatch,
  loadConversationPrincipalPolicy,
  loadEgressPolicyRegistry,
  pairedHandles,
  recordAudit,
  recordHealth,
  type ImessageCursorInput,
  type ImessageHealthInput,
  type ImessageTransportEventInput,
} from "@jehad/core";
import { requireHarnessGrant } from "./harness.js";
import {
  createGoogleCalendarWriteProvider,
  envOrKeychainTokenProvider,
} from "@jehad/adapters";

export interface ImessageHarnessRoutesOptions {
  /** Structural pg.Pool: query + connect() (ingest runs a transaction). */
  db: PromotionDb;
}

function actorFor(request: { principal?: { type: string; name: string } }): string {
  const principal = request.principal;
  return principal ? `${principal.type}:${principal.name}` : "unauthenticated";
}

const SENSOR_GRANT = {
  capabilities: [HARNESS_CAPABILITIES.ingestImessage],
  resource: "imessage",
} as const;

interface IngestRequestBody {
  batch?: unknown;
  cursor?: unknown;
}

/**
 * Conversation deps (Lane P): the real provider + egress registry + policy
 * budgets, resolved lazily once per process — the sensor surface has no
 * conversations to serve until the first paired message arrives, and the
 * OpenRouter key is only read at dispatch time.
 */
let conversationDeps: Promise<{
  db: PromotionDb;
  provider: ModelProvider;
  registry: Awaited<ReturnType<typeof loadEgressPolicyRegistry>>;
  principalPolicy: Awaited<ReturnType<typeof loadConversationPrincipalPolicy>>;
  actionProvider: unknown;
}> | null = null;

export function registerImessageHarnessRoutes(
  app: FastifyInstance,
  opts: ImessageHarnessRoutesOptions,
): void {
  const db = opts.db;

  app.post(
    "/harness/imessage/ingest",
    { preHandler: [requireHarnessGrant(db, SENSOR_GRANT.capabilities, SENSOR_GRANT.resource)] },
    async (request, reply) => {
      const body = (request.body ?? null) as IngestRequestBody;
      if (body === null || typeof body !== "object" || !Array.isArray(body.batch)) {
        return await reply.code(400).send({ error: "invalid_ingest_body", message: "body must be { batch: [...], cursor: {...} }" });
      }
      if (conversationDeps === null) {
        conversationDeps = Promise.all([
          loadEgressPolicyRegistry(),
          loadConversationPrincipalPolicy(),
        ])
          .then(([registry, principalPolicy]) => ({
            db,
            provider: createOpenRouterProvider(),
            registry,
            principalPolicy,
            actionProvider: createGoogleCalendarWriteProvider({
              tokenProvider: envOrKeychainTokenProvider,
              calendarId: process.env.GCALENDAR_ID ?? "primary",
            }),
          }))
          .catch((err: unknown) => {
            // Reset memoization on failure: a transient (or loud, at
            // startup-surface) config error must not wedge every later
            // inbound until restart — the next request retries.
            conversationDeps = null;
            throw err;
          });
      }
      try {
        const report = await ingestBatch(
          db,
          body.batch as readonly ImessageTransportEventInput[], // runtime-validated below the route
          body.cursor as ImessageCursorInput,
          {
            actor: actorFor(request),
            onInbound: async (message) => {
              const deps = await conversationDeps!;
              await handleInbound(deps, message);
            },
          },
        );
        await recordAudit(db, {
          actor: actorFor(request),
          action: "imessage.ingest",
          reversible: true,
          grantId: request.harnessGrantId ?? null,
          outputsRef: JSON.stringify({
            batchSize: report.accepted + report.duplicates,
            accepted: report.accepted,
            duplicates: report.duplicates,
            fingerprintMatches: report.fingerprint_matches.length,
          }),
        });
        return await reply.code(200).send({
          accepted: report.accepted,
          duplicates: report.duplicates,
          fingerprint_matches: report.fingerprint_matches,
          quarantined: report.quarantined,
        });
      } catch (err) {
        if (err instanceof ImessageInputError) {
          return await reply.code(400).send({ error: "invalid_ingest_body", message: err.message });
        }
        throw err;
      }
    },
  );

  app.post(
    "/harness/imessage/health",
    { preHandler: [requireHarnessGrant(db, SENSOR_GRANT.capabilities, SENSOR_GRANT.resource)] },
    async (request, reply) => {
      // Same shape guard as ingest: a non-object body (null/array/scalar)
      // would otherwise surface as a 500 TypeError below the route; the
      // core module owns dim/details validation and maps to 400 via
      // ImessageInputError.
      const body = (request.body ?? null) as ImessageHealthInput | null;
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return await reply.code(400).send({
          error: "invalid_health_body",
          message: "body must be a health report object",
        });
      }
      try {
        await recordHealth(db, body, {
          actor: actorFor(request),
          grantId: request.harnessGrantId ?? null,
        });
        return await reply.code(200).send({
          paired_handles: await pairedHandles(db),
        });
      } catch (err) {
        if (err instanceof ImessageInputError) {
          return await reply.code(400).send({ error: "invalid_health_body", message: err.message });
        }
        throw err;
      }
    },
  );
}
