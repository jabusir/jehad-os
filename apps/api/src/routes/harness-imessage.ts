/**
 * iMessage shadow-sensor harness surface (gateway Phase A, Lane B) —
 * EXACTLY two routes, both behind the dedicated `imessage:ingest`
 * capability (a separate grant from send_channel:imessage: the observer
 * and the sender are different principals; neither token validates at the
 * other's seam):
 *
 *   POST /harness/imessage/ingest   grant imessage:ingest (resource imessage)
 *   POST /harness/imessage/health   same grant
 *
 * PRIVACY RULE (shadow phase): ingest stores metadata, lengths, hashes,
 * decoder status ONLY — third-party message CONTENT never enters the
 * control plane. The schema has no content column and the service nulls
 * any decoded-text hash arriving on a non-own row.
 *
 * Ingest is idempotent on guid (at-least-once sensor → exactly-once
 * control plane); the cursor upsert rides the same transaction. Health
 * reports upsert the five-dim state + write an audit entry.
 */

import type { FastifyInstance } from "fastify";
import type { PromotionDb } from "@jehad/core";
import {
  HARNESS_CAPABILITIES,
  ImessageInputError,
  ingestBatch,
  recordAudit,
  recordHealth,
  type ImessageCursorInput,
  type ImessageHealthInput,
  type ImessageTransportEventInput,
} from "@jehad/core";
import { requireHarnessGrant } from "./harness.js";

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
      try {
        const report = await ingestBatch(
          db,
          body.batch as readonly ImessageTransportEventInput[], // runtime-validated below the route
          body.cursor as ImessageCursorInput,
          { actor: actorFor(request) },
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
      try {
        await recordHealth(db, request.body as ImessageHealthInput, {
          actor: actorFor(request),
        });
        return await reply.code(204).send();
      } catch (err) {
        if (err instanceof ImessageInputError) {
          return await reply.code(400).send({ error: "invalid_health_body", message: err.message });
        }
        throw err;
      }
    },
  );
}
