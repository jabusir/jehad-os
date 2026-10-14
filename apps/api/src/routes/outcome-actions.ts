/**
 * U1.4 — owner decisions on missions (the "resolving doesn't truly resolve"
 * dogfood fix). Card-level Resolve only clears the nudge; these routes drive
 * the CANONICAL outcome through its own guard-legal owner paths:
 *
 *   mission-done   verify every unmet criterion (owner-judgment evidence,
 *                  ADR-0017 honesty gate satisfied via a manual evidence row)
 *                  then waiting_user → verifying → completed, and clear the
 *                  ready nudge (resolved_by owner — undoable like any nudge)
 *   mission-failed waiting_user/blocked/verifying → failed with a reason
 *                  (state-machine guard 024: legal from all three)
 *   criterion      per-criterion verify (with evidence) / waive on detail
 *
 * Authorization: session + CSRF; principal-scoped via getOutcomeByRef — the
 * outcome service's own state guards decide legality (plan U1.4: never the
 * attention registry). No new event types; provenance = existing canonical
 * events + evidence rows.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SqlExecutor } from "@jehad/db";
import {
  getOutcomeByRef,
  listOutcomeCriteria,
  setCriterionStatus,
  transitionOutcome,
  recordEvidence,
  resolveAttention,
} from "@jehad/core";
import { verifySession, verifyCsrf } from "../session.js";

export interface OutcomeActionsRoutesOptions {
  readonly db: SqlExecutor;
}

function formBody(request: FastifyRequest): Record<string, unknown> {
  return typeof request.body === "object" && request.body !== null
    ? (request.body as Record<string, unknown>)
    : {};
}

/** Minimal remedy page for pre-U0 error style parity (matches attention-actions). */
function remedyPage(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Today</title></head><body><p>${message}</p>` +
      `<p><a href="/ui">Back to Today</a></p></body></html>`,
  );
}

export function registerOutcomeActions(app: FastifyInstance, opts: OutcomeActionsRoutesOptions): void {
  const db = opts.db;

  const sessionOf = async (request: FastifyRequest) => verifySession(db, request.headers.cookie, new Date());

  const refFrom = (body: Record<string, unknown>): string | null =>
    typeof body.ref === "string" && body.ref.trim().length > 0 ? body.ref.trim() : null;

  const recordOwnerJudgment = async (
    principalName: string,
    outcomeRef: string,
    outcomeTitle: string,
  ): Promise<string> => {
    const domain = await db.query("SELECT id FROM domains WHERE key = 'personal' LIMIT 1");
    const domainId = domain.rows[0] === undefined ? "" : String(domain.rows[0].id);
    const ev = await recordEvidence(db, {
      domainId,
      sourceType: "manual",
      sourceRef: `today:mission-done:${outcomeRef}`,
      claim: `Owner judged "${outcomeTitle}" done via Today (mission-done).`,
      observedAt: new Date(),
      confidence: 1.0,
      metadata: { outcomeRef, judgedBy: principalName },
    });
    return ev.id;
  };

  /** Best-effort: clear the ready nudge once the canonical decision is made. */
  const clearReadyNudge = async (principalId: string, outcomeId: string): Promise<void> => {
    try {
      const items = await db.query(
        `SELECT id FROM attention_items
          WHERE principal_id = $1::uuid AND source_object_id = $2
            AND state IN ('open', 'seen', 'snoozed')
          ORDER BY updated_at DESC LIMIT 1`,
        [principalId, outcomeId],
      );
      const itemId = items.rows[0] === undefined ? null : String(items.rows[0].id);
      if (itemId !== null) {
        await resolveAttention(db, principalId, itemId, { now: new Date(), actor: `owner`, by: "owner" });
      }
    } catch {
      // The canonical decision is already durable; the nudge can be cleared
      // by hand. Never mask the mission result.
    }
  };

  // ------------------------------------------------------------ mission-done
  app.post("/ui/mission-done", async (request, reply) => {
    const session = await sessionOf(request);
    if (session === null) return await remedyPage(reply, 401, "Session expired — sign in again from Today.");
    const body = formBody(request);
    if (!verifyCsrf(session, body.csrf)) return await remedyPage(reply, 403, "Invalid request token.");
    const ref = refFrom(body);
    if (ref === null) return await remedyPage(reply, 400, "Missing mission ref.");

    const outcome = await getOutcomeByRef(db, session.principal.id, ref);
    if (outcome === null) return await remedyPage(reply, 404, "Mission not found.");
    if (outcome.status !== "waiting_user" && outcome.status !== "verifying") {
      return await remedyPage(reply, 400, `"${ref}" is ${outcome.status} — only missions waiting for you can be marked done.`);
    }

    const criteria = await listOutcomeCriteria(db, session.principal.id, outcome.id);
    const unmet = criteria.filter((c) => c.status !== "verified" && c.status !== "waived_by_owner");
    for (const c of unmet) {
      const evidenceRef = await recordOwnerJudgment(session.principal.name, outcome.ref, outcome.title);
      await setCriterionStatus(db, outcome.id, c.ordinal, "verified", {
        now: new Date(),
        actor: `user:${session.principal.name}`,
        evidenceRef,
      });
    }
    if (outcome.status === "waiting_user") {
      await transitionOutcome(db, outcome.id, "verifying", {}, {
        now: new Date(),
        actor: `user:${session.principal.name}`,
      });
    }
    await transitionOutcome(db, outcome.id, "completed", {}, {
      now: new Date(),
      actor: `user:${session.principal.name}`,
    });
    await clearReadyNudge(session.principal.id, outcome.id);
    return await reply
      .code(303)
      .header("location", `/ui?done=mission-done`)
      .send("");
  });

  // ---------------------------------------------------------- mission-failed
  app.post("/ui/mission-failed", async (request, reply) => {
    const session = await sessionOf(request);
    if (session === null) return await remedyPage(reply, 401, "Session expired — sign in again from Today.");
    const body = formBody(request);
    if (!verifyCsrf(session, body.csrf)) return await remedyPage(reply, 403, "Invalid request token.");
    const ref = refFrom(body);
    if (ref === null) return await remedyPage(reply, 400, "Missing mission ref.");
    const rawReason = typeof body.reason === "string" ? body.reason.trim() : "";
    const reason = (rawReason.length > 0 ? rawReason : "Owner marked it not done.").slice(0, 500);

    const outcome = await getOutcomeByRef(db, session.principal.id, ref);
    if (outcome === null) return await remedyPage(reply, 404, "Mission not found.");
    if (outcome.status !== "waiting_user" && outcome.status !== "blocked" && outcome.status !== "verifying") {
      return await remedyPage(reply, 400, `"${ref}" is ${outcome.status} — it can't be marked failed from there.`);
    }
    await transitionOutcome(db, outcome.id, "failed", { failureReason: reason }, {
      now: new Date(),
      actor: `user:${session.principal.name}`,
    });
    await clearReadyNudge(session.principal.id, outcome.id);
    return await reply
      .code(303)
      .header("location", `/ui?done=mission-failed`)
      .send("");
  });

  // -------------------------------------------------------------- criterion
  app.post("/ui/criterion", async (request, reply) => {
    const session = await sessionOf(request);
    if (session === null) return await remedyPage(reply, 401, "Session expired — sign in again from Today.");
    const body = formBody(request);
    if (!verifyCsrf(session, body.csrf)) return await remedyPage(reply, 403, "Invalid request token.");
    const ref = refFrom(body);
    const ordinal = Number(body.ordinal);
    const verdict = body.verdict;
    if (ref === null || !Number.isSafeInteger(ordinal) || ordinal < 1 || (verdict !== "verify" && verdict !== "waive")) {
      return await remedyPage(reply, 400, "Invalid criterion update.");
    }
    const outcome = await getOutcomeByRef(db, session.principal.id, ref);
    if (outcome === null) return await remedyPage(reply, 404, "Mission not found.");
    if (outcome.status === "completed" || outcome.status === "failed" || outcome.status === "cancelled") {
      return await remedyPage(reply, 400, `"${ref}" is already finished.`);
    }
    if (verdict === "verify") {
      const evidenceRef = await recordOwnerJudgment(session.principal.name, outcome.ref, outcome.title);
      await setCriterionStatus(db, outcome.id, ordinal, "verified", {
        now: new Date(),
        actor: `user:${session.principal.name}`,
        evidenceRef,
      });
    } else {
      await setCriterionStatus(db, outcome.id, ordinal, "waived_by_owner", {
        now: new Date(),
        actor: `user:${session.principal.name}`,
      });
    }
    return await reply
      .code(303)
      .header("location", `/ui/outcome/${encodeURIComponent(ref)}`)
      .send("");
  });
}
