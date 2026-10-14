/**
 * U1 attention action routes (Today UX overhaul Lane B; ADR-0021) — the two
 * POSTs that deliberately live OUTSIDE /ui/action and the actions registry:
 *
 * - POST /ui/snooze — snooze presets (evening | tomorrow | 1h) or explicit
 *   minutes. /ui/action's storedActionMatches gate 403s non-stored args by
 *   design (ADR-0018 §1.5 finding 5); preset minutes are chosen at submit
 *   time and must never be producer-storable. Tokens translate at POST time,
 *   server-local, per the shared time-token map (overhaul plan §2); the
 *   <30-min evening roll to next-day 20:00 is a snooze-floor artifact of THIS
 *   endpoint only.
 * - POST /ui/reopen — owner-initiated undo of a terminal attention item
 *   (ADR-0021). NOT a registry key: registry refs are producer-stored row
 *   data, and reopen must never be producer-storable; /ui/action's
 *   listOpenAttention ownership gate excludes the terminal states undo must
 *   reach, so ownership is enforced principal-scoped inside the service.
 *
 * Status-code behavior mirrors /ui/action exactly: no session → 401, bad
 * CSRF → 403, malformed request → 400 (inline remedy, plain message + back
 * link), unknown/foreign item → 404 (fail-closed, indistinguishable).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { SqlExecutor } from "@jehad/db";
import {
  AttentionReopenError,
  UUID_RE,
  listOpenAttention,
  reopenAttentionByOwner,
  snoozeAttention,
} from "@jehad/core";
import { escapeHtml } from "../escape-html.js";
import { verifyCsrf, verifySession } from "../session.js";

export interface AttentionActionsRoutesOptions {
  db: SqlExecutor;
}

/** ADR-0019 contract value — identical to ui.ts's CSP (kept verbatim here;
 *  ui.ts's constant is that module's, this file must not refactor it). */
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

function sendHtml(reply: FastifyReply, code: number, html: string): FastifyReply {
  return reply
    .code(code)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", CSP)
    .send(html);
}

/** Minimal page consistent with ui.ts's helper (this file stays standalone;
 *  Lane A's shared error-page helper may land separately). */
function page(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;margin:1rem auto;max-width:40rem;padding:0 1rem;color:#111;background:#fafafa;overflow-wrap:break-word}
nav{display:flex;gap:1rem;padding:.5rem 0;border-bottom:1px solid #ddd;margin-bottom:.5rem;font-size:1.05rem}
h1{font-size:1.4rem}
</style>
</head>
<body>
<nav><a href="/ui">Today</a></nav>
${body}
</body>
</html>`;
}

/** Inline-remedy error page: what happened → the way back. Never a dead end. */
function remedyPage(message: string): string {
  return page(`<h1>TODAY</h1><p>${escapeHtml(message)} <a href="/ui">Back to Today</a>.</p>`);
}

const SNOOZE_FLOOR_MINUTES = 5;
const SNOOZE_CEILING_MINUTES = 4320;
/** §2 snooze-floor artifact: "evening" closer than this rolls to the NEXT
 *  day's 20:00. Applies ONLY to /ui/snooze token translation, never to U2
 *  deadlines (deadlines have no floor — their only rule is "in the future"). */
export const EVENING_HOUR = 20;
export const TOMORROW_HOUR = 9;
const EVENING_ROLL_THRESHOLD_MINUTES = 30;

function localAtHour(now: Date, hour: number, dayOffset: number): Date {
  const target = new Date(now);
  target.setDate(target.getDate() + dayOffset);
  target.setHours(hour, 0, 0, 0);
  return target;
}

/**
 * Shared time-token map (overhaul plan §2), snooze side: evening=20:00
 * server-local today (with the <30-min roll to next-day 20:00),
 * tomorrow=09:00 next server-local day, 1h=60. Unknown token → null
 * (fail-closed: the route 400s, it never guesses). Wall-clock tokens ceil to
 * whole minutes so the landing instant is never BEFORE the pinned hour.
 */
export function snoozeTokenToMinutes(token: string, now: Date): number | null {
  switch (token) {
    case "1h":
      return 60;
    case "evening": {
      let target = localAtHour(now, EVENING_HOUR, 0);
      if ((target.getTime() - now.getTime()) / 60_000 < EVENING_ROLL_THRESHOLD_MINUTES) {
        target = localAtHour(now, EVENING_HOUR, 1);
      }
      return Math.ceil((target.getTime() - now.getTime()) / 60_000);
    }
    case "tomorrow": {
      const target = localAtHour(now, TOMORROW_HOUR, 1);
      return Math.ceil((target.getTime() - now.getTime()) / 60_000);
    }
    default:
      return null;
  }
}

function formBody(request: { body: unknown }): Record<string, unknown> {
  return typeof request.body === "object" && request.body !== null
    ? (request.body as Record<string, unknown>)
    : {};
}

export function registerAttentionActions(app: FastifyInstance, opts: AttentionActionsRoutesOptions): void {
  const db = opts.db;

  // ------------------------------------------------------------ snooze
  app.post("/ui/snooze", async (request, reply) => {
    const session = await verifySession(db, request.headers.cookie, new Date());
    if (session === null) {
      return await sendHtml(reply, 401, remedyPage("Session expired — sign in again from Today."));
    }
    const body = formBody(request);
    if (!verifyCsrf(session, body.csrf)) {
      return await sendHtml(reply, 403, remedyPage("Invalid request token."));
    }
    const itemId = body.itemId;
    if (typeof itemId !== "string" || !UUID_RE.test(itemId)) {
      return await sendHtml(reply, 400, remedyPage("Invalid request."));
    }
    // Token presets translate at POST time, server-local (plan §2); an
    // explicit minutes value passes through. Either way the route bounds the
    // result 5..4320 — a translation landing outside fails to the remedy page.
    let minutes: number;
    if (typeof body.preset === "string") {
      const translated = snoozeTokenToMinutes(body.preset, new Date());
      if (translated === null) {
        return await sendHtml(reply, 400, remedyPage("Unknown snooze preset."));
      }
      minutes = translated;
    } else if (body.minutes !== undefined) {
      minutes = Number(body.minutes);
    } else {
      return await sendHtml(reply, 400, remedyPage("Pick a snooze length."));
    }
    if (!Number.isSafeInteger(minutes) || minutes < SNOOZE_FLOOR_MINUTES || minutes > SNOOZE_CEILING_MINUTES) {
      return await sendHtml(reply, 400, remedyPage(`Snooze must be ${SNOOZE_FLOOR_MINUTES}..${SNOOZE_CEILING_MINUTES} minutes.`));
    }
    // Fail-closed ownership gate, same open-set fetch /ui/action uses: the
    // item must be in this principal's actionable set.
    const principalId = session.principal.id;
    const now = new Date();
    const items = await listOpenAttention(db, principalId, { now, includeSnoozed: true });
    if (!items.some((i) => i.id === itemId)) {
      return await sendHtml(reply, 404, remedyPage("Not found."));
    }
    const updated = await snoozeAttention(db, principalId, itemId, minutes, {
      now,
      actor: `user:${session.principal.name}`,
    });
    if (updated === null) {
      return await sendHtml(reply, 404, remedyPage("Not found."));
    }
    return await reply.code(303).header("location", "/ui?done=snooze").send("");
  });

  // ------------------------------------------------------------ reopen
  app.post("/ui/reopen", async (request, reply) => {
    const session = await verifySession(db, request.headers.cookie, new Date());
    if (session === null) {
      return await sendHtml(reply, 401, remedyPage("Session expired — sign in again from Today."));
    }
    const body = formBody(request);
    if (!verifyCsrf(session, body.csrf)) {
      return await sendHtml(reply, 403, remedyPage("Invalid request token."));
    }
    const itemId = body.itemId;
    if (typeof itemId !== "string" || !UUID_RE.test(itemId)) {
      return await sendHtml(reply, 400, remedyPage("Invalid request."));
    }
    try {
      // Principal-scoped inside the service: foreign/unknown → null → 404;
      // illegal (non-terminal, producer-closed, >24h) → typed error → 400.
      // Delivers nothing (ADR-0021: the owner is standing in the UI).
      const updated = await reopenAttentionByOwner(db, session.principal.id, itemId, {
        now: new Date(),
        actor: `user:${session.principal.name}`,
      });
      if (updated === null) {
        return await sendHtml(reply, 404, remedyPage("Not found."));
      }
      return await reply.code(303).header("location", "/ui?done=reopen").send("");
    } catch (err) {
      if (err instanceof AttentionReopenError) {
        return await sendHtml(reply, 400, remedyPage(err.message + "."));
      }
      throw err;
    }
  });
}
