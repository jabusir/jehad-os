/**
 * Today — the private tailnet web read-out (ADR-0019; W1 contract §"API
 * contract"). Server-rendered HTML only: no SPA, no client-side JS, no
 * external assets. Four hard rules from ADR-0019 §2 are enforced here:
 *
 * 1. Identity gate: one-time bearer-credential paste → stateless signed
 *    session cookie (Secure+HttpOnly+SameSite=Strict; see session.ts).
 * 2. CSRF token on every state-changing POST (session-scoped, constant-time
 *    compare). POST /ui/session is the pre-auth login endpoint: no session
 *    (hence no session-scoped CSRF token) exists yet; SameSite=Strict plus
 *    the one-time credential itself close the login-CSRF window.
 * 3. Every string derived from external content escapes through the single
 *    escapeHtml helper; CSP `default-src 'none'` on every response.
 * 4. Actions render from the ADR-0018 §1.6 registry descriptors only —
 *    never from row-stored endpoints; unknown keys render nothing and
 *    dispatch nothing (fail-closed).
 *
 * NOTE(lane D): listOpenAttention/resolve/dismiss/markSeen/snooze and
 * getActionDescriptor come from the attention service (lane B) — the only
 * import surface that does not compile standalone until that lane merges
 * (expected gap). Everything here is principal-scoped and fail-closed:
 * foreign ids 404, they are never an error leak.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SqlExecutor } from "@jehad/db";
import {
  FeedbackInputError,
  UUID_RE,
  getOutcomeByRef,
  isFeedbackVerdict,
  listOutcomeCriteria,
  recordFeedback,
} from "@jehad/core";
import { findPrincipalByCredentialHash, sha256Hex } from "@jehad/db";
import { timingSafeEqual } from "node:crypto";
import {
  dismissAttention,
  getActionDescriptor,
  listOpenAttention,
  markSeen,
  resolveAttention,
  snoozeAttention,
} from "@jehad/core";
import { escapeHtml } from "../escape-html.js";
import { issueSession, verifyCsrf, verifySession } from "../session.js";

export interface UiRoutesOptions {
  db: SqlExecutor;
}

/** ADR-0019 CSP — sent on every Today response (contract-mandated value). */
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

/** Structural view of AttentionItemRow + registry descriptor (types.ts at merge). */
interface TodayItem {
  readonly id: string;
  readonly state: string;
  readonly title: string;
  readonly whyItMatters: string | null;
  readonly evidenceRefs: readonly { readonly type: string; readonly id: string }[];
  readonly actions: readonly {
    readonly key: string;
    readonly args?: Readonly<Record<string, string | number>>;
  }[];
  readonly occurrences: number;
  readonly firstRaisedAt: Date;
}

interface ActionDescriptor {
  readonly kind: "resolve" | "dismiss" | "snooze" | "seen" | "feedback" | "link";
  readonly defaultArgs?: Readonly<Record<string, string | number>>;
  readonly validateArgs?: (args?: Readonly<Record<string, string | number>>) => boolean;
  readonly label: (args?: Readonly<Record<string, string | number>>) => string;
}

const CRITERION_GLYPHS: Record<string, string> = {
  pending: "○",
  verified: "✓",
  failed: "✗",
  unverified: "◌",
  waived_by_owner: "⊘",
};

function sendHtml(reply: FastifyReply, code: number, html: string): FastifyReply {
  return reply
    .code(code)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", CSP)
    .send(html);
}

function page(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;margin:1rem auto;max-width:40rem;padding:0 1rem;color:#111;background:#fafafa}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.5rem;border-bottom:1px solid #ddd;padding-bottom:.25rem}
article{background:#fff;border:1px solid #ddd;border-radius:8px;padding:.75rem 1rem;margin:.75rem 0}
.meta{color:#555;font-size:.85rem;margin:.25rem 0}
form{display:inline-block;margin:.25rem .5rem 0 0}
button{padding:.35rem .8rem;font-size:.9rem}
ul{padding-left:1.25rem}.glyph{font-weight:bold}
input[type=password]{width:100%;padding:.5rem;margin:.5rem 0;box-sizing:border-box}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function pasteFormPage(message: string): string {
  return page(
    `<h1>TODAY</h1><p>${escapeHtml(message)}</p>` +
      `<form method="post" action="/ui/session">` +
      `<input type="password" name="token" autocomplete="off" required>` +
      `<button type="submit">Open Today</button></form>`,
  );
}

function relativeAge(from: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function evidenceText(item: TodayItem): string {
  return item.evidenceRefs
    .map((r) => (r.type === "outcome" ? `Outcome ${r.id}` : `${r.type} ${r.id}`))
    .join(" · ");
}

/** One card = title, whyItMatters, age, occurrences, evidence, registry forms. */
function card(item: TodayItem, csrf: string, now: Date): string {
  const meta = [relativeAge(item.firstRaisedAt, now)];
  if (item.occurrences > 1) meta.push(`×${item.occurrences} occurrences`);
  const evidence = evidenceText(item);
  if (evidence.length > 0) meta.push(escapeHtml(evidence));
  const forms = item.actions
    .map((action) => {
      const descriptor = getActionDescriptor(action.key) as ActionDescriptor | null;
      if (descriptor === null) return ""; // fail-closed: unknown key renders nothing
      const args = action.args ?? descriptor.defaultArgs ?? {};
      return (
        `<form method="post" action="/ui/action">` +
        `<input type="hidden" name="itemId" value="${escapeHtml(item.id)}">` +
        `<input type="hidden" name="key" value="${escapeHtml(action.key)}">` +
        `<input type="hidden" name="args" value="${escapeHtml(JSON.stringify(args))}">` +
        `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
        `<button type="submit">${escapeHtml(descriptor.label(args))}</button></form>`
      );
    })
    .join("");
  return (
    `<article id="item-${escapeHtml(item.id)}">` +
    `<h3>${escapeHtml(item.title)}</h3>` +
    (item.whyItMatters ? `<p>${escapeHtml(item.whyItMatters)}</p>` : "") +
    `<p class="meta">${meta.join(" · ")}</p>` +
    forms +
    `</article>`
  );
}

function parseArgs(raw: unknown): Record<string, string | number> | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string" && typeof v !== "number") return null;
    out[k] = v;
  }
  return out;
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function registerUiRoutes(app: FastifyInstance, opts: UiRoutesOptions): void {
  const db = opts.db;

  // Native form POSTs are urlencoded; fastify core only parses JSON. Additive,
  // scoped to exactly this media type (no new deps — ADR-0019 no-toolchain).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(String(body))) out[k] = v;
    done(null, out);
  });

  // ------------------------------------------------------------- session
  app.post("/ui/session", async (request, reply) => {
    const principal = request.principal;
    if (principal !== undefined && principal.type !== "user") {
      return await reply.code(403).send({ error: "forbidden" });
    }
    const body = request.body as Record<string, unknown> | undefined;
    const token = body !== null && typeof body === "object" ? body.token : undefined;
    if (typeof token !== "string" || token.length === 0) {
      return await sendHtml(reply, 401, pasteFormPage("Paste a one-time credential to open Today."));
    }
    const presentedHash = sha256Hex(token);
    const record = await findPrincipalByCredentialHash(db, presentedHash);
    if (record === null || record.credentialHash === null || record.type !== "user") {
      return await sendHtml(reply, 401, pasteFormPage("That credential was not recognized. Try again."));
    }
    if (!hashesMatch(presentedHash, record.credentialHash)) {
      return await sendHtml(reply, 401, pasteFormPage("That credential was not recognized. Try again."));
    }
    const issued = issueSession(record.id, record.credentialHash, new Date());
    return await reply
      .code(303)
      .header("location", "/ui")
      .header("set-cookie", issued.cookie)
      .send("");
  });

  // --------------------------------------------------------------- today
  app.get("/ui", async (request, reply) => {
    const session = await verifySession(db, request.headers.cookie, new Date());
    if (session === null) {
      return await sendHtml(reply, 401, pasteFormPage("Paste a one-time credential to open Today."));
    }
    const now = new Date();
    const items = (await listOpenAttention(db, session.principal.id, {
      now,
      includeSnoozed: true,
    })) as readonly TodayItem[];
    const needs = items.filter((i) => i.state === "open" || i.state === "seen");
    const snoozed = items.filter((i) => i.state === "snoozed");
    const body =
      `<h1>TODAY</h1>` +
      `<h2>Needs you</h2>` +
      (needs.length > 0
        ? needs.map((i) => card(i, session.csrfToken, now)).join("")
        : `<p>Nothing needs you right now.</p>`) +
      `<h2>Snoozed</h2>` +
      (snoozed.length > 0
        ? snoozed.map((i) => card(i, session.csrfToken, now)).join("")
        : `<p>Nothing snoozed.</p>`);
    return await sendHtml(reply, 200, page(body));
  });

  // -------------------------------------------------------------- action
  app.post("/ui/action", async (request, reply) => {
    const session = await verifySession(db, request.headers.cookie, new Date());
    if (session === null) {
      return await sendHtml(reply, 401, pasteFormPage("Session expired — paste your credential again."));
    }
    const body = (typeof request.body === "object" && request.body !== null
      ? (request.body as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    if (!verifyCsrf(session, body.csrf)) {
      return await sendHtml(reply, 403, page(`<h1>TODAY</h1><p>Invalid request token. <a href="/ui">Back to Today</a>.</p>`));
    }
    const itemId = body.itemId;
    if (typeof itemId !== "string" || !UUID_RE.test(itemId)) {
      return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Invalid request. <a href="/ui">Back to Today</a>.</p>`));
    }
    const key = body.key;
    const descriptor = (typeof key === "string" ? getActionDescriptor(key) : null) as ActionDescriptor | null;
    if (descriptor === null) {
      return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Unknown action. <a href="/ui">Back to Today</a>.</p>`));
    }
    const args = parseArgs(body.args);
    if (args === null) {
      return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Invalid action arguments. <a href="/ui">Back to Today</a>.</p>`));
    }
    if (descriptor.validateArgs !== undefined && !descriptor.validateArgs(args)) {
      return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Invalid action arguments. <a href="/ui">Back to Today</a>.</p>`));
    }
    const principalId = session.principal.id;
    const actor = `user:${session.principal.name}`;
    const now = new Date();
    // Fail-closed ownership gate: the item must be in this principal's open
    // set (open/seen/snoozed are exactly the actionable states).
    const items = (await listOpenAttention(db, principalId, { now, includeSnoozed: true })) as readonly TodayItem[];
    const item = items.find((i) => i.id === itemId);
    if (item === undefined) {
      return await sendHtml(reply, 404, page(`<h1>TODAY</h1><p>Not found. <a href="/ui">Back to Today</a>.</p>`));
    }
    switch (descriptor.kind) {
      case "resolve": {
        const updated = await resolveAttention(db, principalId, itemId, { now, actor, by: "owner" });
        if (updated === null) return await sendHtml(reply, 404, page(`<h1>TODAY</h1><p>Not found.</p>`));
        return await reply.code(303).header("location", "/ui").send("");
      }
      case "dismiss": {
        const updated = await dismissAttention(db, principalId, itemId, { now, actor });
        if (updated === null) return await sendHtml(reply, 404, page(`<h1>TODAY</h1><p>Not found.</p>`));
        return await reply.code(303).header("location", "/ui").send("");
      }
      case "seen": {
        const updated = await markSeen(db, principalId, itemId, { now, actor });
        if (updated === null) return await sendHtml(reply, 404, page(`<h1>TODAY</h1><p>Not found.</p>`));
        return await reply.code(303).header("location", "/ui").send("");
      }
      case "snooze": {
        const minutes = Number(args.minutes ?? descriptor.defaultArgs?.minutes);
        if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 4320) {
          return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Snooze must be 5..4320 minutes.</p>`));
        }
        const updated = await snoozeAttention(db, principalId, itemId, minutes, { now, actor });
        if (updated === null) return await sendHtml(reply, 404, page(`<h1>TODAY</h1><p>Not found.</p>`));
        return await reply.code(303).header("location", "/ui").send("");
      }
      case "feedback": {
        const verdict = args.verdict;
        if (!isFeedbackVerdict(verdict)) {
          return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Invalid verdict.</p>`));
        }
        try {
          await recordFeedback(db, {
            itemType: "attention_item",
            itemId,
            verdict,
            createdBy: principalId,
          });
        } catch (err) {
          if (err instanceof FeedbackInputError) {
            return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Invalid verdict.</p>`));
          }
          throw err;
        }
        return await reply.code(303).header("location", "/ui").send("");
      }
      case "link": {
        const ref = args.ref;
        if (typeof ref !== "string" || ref.length === 0) {
          return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Invalid link target.</p>`));
        }
        const outcome = await getOutcomeByRef(db, principalId, ref);
        if (outcome === null) {
          return await sendHtml(reply, 404, page(`<h1>TODAY</h1><p>Not found.</p>`));
        }
        return await reply.code(302).header("location", `/ui/outcome/${encodeURIComponent(ref)}`).send("");
      }
    }
  });

  // ------------------------------------------------------- outcome view
  const outcomeView = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const session = await verifySession(db, request.headers.cookie, new Date());
    if (session === null) {
      return await sendHtml(reply, 401, pasteFormPage("Session expired — paste your credential again."));
    }
    const params = request.params as { ref?: string };
    const query = request.query as { ref?: string };
    const ref = params.ref ?? query.ref;
    if (typeof ref !== "string" || ref.length === 0) {
      return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Missing outcome ref.</p>`));
    }
    const outcome = await getOutcomeByRef(db, session.principal.id, ref);
    if (outcome === null) {
      return await sendHtml(reply, 404, page(`<h1>TODAY</h1><p>Not found. <a href="/ui">Back to Today</a>.</p>`));
    }
    const criteria = await listOutcomeCriteria(db, session.principal.id, outcome.id);
    const list = criteria
      .map((c) => {
        const glyph = CRITERION_GLYPHS[c.status] ?? "·";
        return `<li><span class="glyph">${escapeHtml(glyph)}</span> ${escapeHtml(c.criterion)} <span class="meta">(${escapeHtml(c.status)})</span></li>`;
      })
      .join("");
    const body =
      `<p><a href="/ui">← Today</a></p>` +
      `<h1>${escapeHtml(outcome.title)}</h1>` +
      `<p class="meta">Outcome ${escapeHtml(outcome.ref)} · status ${escapeHtml(outcome.status)}</p>` +
      `<p class="meta">Created ${escapeHtml(outcome.createdAt)} · Updated ${escapeHtml(outcome.updatedAt)}</p>` +
      `<h2>Criteria</h2><ul>${list}</ul>`;
    return await sendHtml(reply, 200, page(body));
  };
  // Query-shape route is what cookie-browsers hit: auth.ts's publicPaths
  // exact-match can only exempt static paths, so buildApp rewrites the
  // contract path /ui/outcome/:ref onto it before the bearer gate runs.
  app.get("/ui/outcome", outcomeView);
  app.get("/ui/outcome/:ref", outcomeView); // contract shape; bearer clients (or post-merge hook changes)
}
