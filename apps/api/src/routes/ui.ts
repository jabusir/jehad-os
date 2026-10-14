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
  listActiveOutcomes,
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
  storedActionMatches,
  snoozeAttention,
} from "@jehad/core";
import { escapeHtml } from "../escape-html.js";
import { issueSession, verifyCsrf, verifySession, type TodaySession } from "../session.js";
import { loadTodayAuthPolicy, resolveTailscalePrincipal } from "../tailscale-auth.js";
import { createAndDispatchOutcome, createWorkflowRuntime, type OutcomeDispatchPort } from "@jehad/workflow";
import { outcomesPolicyOf, parsePolicyV1 } from "@jehad/core";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface UiRoutesOptions {
  db: SqlExecutor;
  /** Defaults to the real WorkflowRuntime; tests inject a counting fake. */
  dispatch?: OutcomeDispatchPort;
}

/** ADR-0019 CSP — sent on every Today response (contract-mandated value). */
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

function loadOutcomesPolicy() {
  const moduleDefault = fileURLToPath(new URL("../../../../policy.yaml", import.meta.url));
  const file = process.env.POLICY_YAML_PATH ?? moduleDefault;
  return outcomesPolicyOf(parsePolicyV1(readFileSync(file, "utf8")));
}

let outcomeRuntime: ReturnType<typeof createWorkflowRuntime> | null = null;
let injectedDispatch: OutcomeDispatchPort | null = null;
function dispatchPort(): OutcomeDispatchPort {
  if (injectedDispatch !== null) return injectedDispatch;
  if (outcomeRuntime === null) outcomeRuntime = createWorkflowRuntime();
  return outcomeRuntime;
}

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
  readonly snoozedUntil: Date | string | null;
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
body{font-family:system-ui,sans-serif;margin:1rem auto;max-width:40rem;padding:0 1rem;color:#111;background:#fafafa;overflow-wrap:break-word}
nav{display:flex;gap:1rem;padding:.5rem 0;border-bottom:1px solid #ddd;margin-bottom:.5rem;font-size:1.05rem}
label{display:block;margin:.5rem 0;font-size:1rem}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.5rem;border-bottom:1px solid #ddd;padding-bottom:.25rem}
article{background:#fff;border:1px solid #ddd;border-radius:8px;padding:.75rem 1rem;margin:.75rem 0}
.meta{color:#555;font-size:.85rem;margin:.25rem 0}
form{display:inline-block;margin:.25rem .5rem 0 0}
button{padding:.35rem .8rem;font-size:.9rem}
ul{padding-left:1.25rem}.glyph{font-weight:bold}
input[type=password]{width:100%;padding:.5rem;margin:.5rem 0;box-sizing:border-box}
input[type=text],input[type=datetime-local],textarea{width:100%;padding:.5rem;margin:.25rem 0 .75rem;box-sizing:border-box;font-size:16px}
button{min-height:44px;min-width:44px}
.field-error{color:#b3261e;margin:.25rem 0}
.deadline-custom{display:none}
form:has(input[name="deadlinePick"][value="custom"]:checked) .deadline-custom{display:block}
@keyframes createdPulse{0%{outline:3px solid #4a90d9;outline-offset:2px}100%{outline:3px solid transparent;outline-offset:8px}}
.created-pulse{animation:createdPulse 1.2s ease-out 2}
@media(prefers-reduced-motion:reduce){.created-pulse{animation:none}}
</style>
</head>
<body>
<nav><a href="/ui">Today</a><a href="/ui/delegate">Delegate</a><a href="/ui/missions">Missions</a></nav>
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

/**
 * Shared time-token map (UX plan §2, deadline side), resolved at POST time:
 * Tonight = 20:00 server-local (NO snooze-floor roll), Tomorrow = next day
 * 09:00, Next week = +7 days 09:00 — all server-local via setHours/setDate.
 * The route rejects a resolved target that is already past (only Tonight can
 * be); exported pure for deterministic mapping tests.
 */
export function resolveDeadlinePick(pick: string, now: Date): Date | null {
  const target = new Date(now);
  if (pick === "tonight") {
    target.setHours(20, 0, 0, 0);
  } else if (pick === "tomorrow" || pick === "nextweek") {
    target.setDate(target.getDate() + (pick === "tomorrow" ? 1 : 7));
    target.setHours(9, 0, 0, 0);
  } else {
    return null;
  }
  return target;
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
  injectedDispatch = opts.dispatch ?? null;

  /**
   * W1.2 normal flow: valid Today session → use it; else a valid allowlisted
   * Tailscale-User-Login maps to the exact user principal and mints a NORMAL
   * Today session (same cookie, same CSRF, same scoping). Fail closed.
   */
  const todaySession = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<TodaySession | null> => {
    const existing = await verifySession(db, request.headers.cookie, new Date());
    if (existing !== null) return existing;
    const principal = await resolveTailscalePrincipal(
      db,
      request.headers as Record<string, unknown> | undefined,
      await loadTodayAuthPolicy(),
    );
    if (principal === null) return null;
    const issued = issueSession(principal.id, principal.credentialHash!, new Date());
    reply.header("set-cookie", issued.cookie);
    return {
      principal: { id: principal.id, type: principal.type, name: principal.name },
      expiryMs: issued.expiryMs,
      csrfToken: issued.csrfToken,
    };
  };

  /** Fail-closed page — never the credential form on the normal path. */
  const unauthorizedPage = (): string =>
    page(
      `<h1>TODAY</h1>` +
        `<p>Not signed in. Open this tailnet URL from an allowlisted device, ` +
        `or use <a href="/ui/recovery">recovery sign-in</a>.</p>`,
    );

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

  // -------------------------------------------------- recovery (break-glass)
  // The credential-paste flow is now RECOVERY/ADMIN access, not the normal
  // product path (W1.2). POST /ui/session is preserved for compatibility.
  app.get("/ui/recovery", async (_request, reply) => {
    return await sendHtml(reply, 200, pasteFormPage("Recovery sign-in — paste a one-time credential to open Today."));
  });

  // --------------------------------------------------------------- today
  app.get("/ui", async (request, reply) => {
    const session = await todaySession(request, reply);
    if (session === null) {
      return await sendHtml(reply, 401, unauthorizedPage());
    }
    const now = new Date();
    const items = (await listOpenAttention(db, session.principal.id, {
      now,
      includeSnoozed: true,
    })) as readonly TodayItem[];
    // W1.1 correction — snooze sectioning matches the listOpenAttention
    // contract: an EXPIRED snooze is needs-you NOW (even before the ≤5-min
    // liveness wake flips the stored state to open); only a LIVE snooze
    // renders under Snoozed.
    const snoozeLive = (i: TodayItem): boolean => {
      if (i.state !== "snoozed") return false;
      const until = i.snoozedUntil === null ? null : new Date(i.snoozedUntil);
      return until !== null && until.getTime() > now.getTime();
    };
    const needs = items.filter((i) => !snoozeLive(i));
    const snoozed = items.filter(snoozeLive);
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
    // W1.1 finding 5 — authorization is registry AND item: the submitted
    // {key,args} must match an action the producer actually stored on THIS
    // row. A registered key absent from the item (or with args the row never
    // carried) fails closed — the registry alone is not authorization.
    const storedActions = (item.actions ?? []) as readonly { key: string; args?: Record<string, string | number> }[];
    if (!storedActionMatches(storedActions, String(key), args)) {
      return await sendHtml(reply, 403, page(`<h1>TODAY</h1><p>That action is not available on this item. <a href="/ui">Back to Today</a>.</p>`));
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


  // ------------------------------------------------------- delegate (U2)
  // Explicit structured Outcome creation — NOT a chatbot. The user chooses
  // the verb (Delegate); natural language is only the CONTENT of bounded
  // fields. No model calls, no intent inference, no josctl shell-out: the
  // route uses the SAME canonical seam as the CLI (createAndDispatchOutcome),
  // with the principal taken ONLY from the session and submissionId
  // idempotency unchanged. U2 additions are render-time only: grouped form,
  // helper lines, deadline quick-picks (resolved at POST time, §2 map),
  // policy-slot context, inline-remedy re-renders with preserved input.
  const DELEGATE_ROWS = 4;
  const DEADLINE_PICKS: readonly string[] = ["none", "tonight", "tomorrow", "nextweek", "custom"];

  interface DelegateFormState {
    goal: string;
    criteria: string[];
    constraints: string[];
    deadlinePick: string;
    deadline: string;
  }

  interface DelegateFormErrors {
    goal?: string;
    criteria?: string;
    deadline?: string;
    form?: string;
  }

  const emptyDelegateState = (): DelegateFormState => ({
    goal: "",
    criteria: Array.from({ length: DELEGATE_ROWS }, () => ""),
    constraints: Array.from({ length: DELEGATE_ROWS }, () => ""),
    deadlinePick: "none",
    deadline: "",
  });

  const fieldError = (message: string): string =>
    `<p class="field-error">${escapeHtml(message)}</p>`;

  const textRow = (name: string, label: string, n: number, value: string, extra: boolean): string =>
    `<label${extra ? " data-extra" : ""}>${label} ${n}<br>` +
    `<input type="text" name="${name}${n}" maxlength="2000" autocomplete="off" value="${escapeHtml(value)}"></label>`;

  // Rows 2-4 stay in the DOM (same bounded 4-row form contract as W1.2),
  // each marked data-extra for Lane D's reveal script; the no-JS affordance
  // is a plain <details> "Add another" wrapper — deliberately boring.
  const extraRows = (name: string, label: string, values: readonly string[]): string =>
    `<details class="extra-rows"><summary>Add another</summary>` +
    Array.from({ length: DELEGATE_ROWS - 1 }, (_v, i) =>
      textRow(name, label, i + 2, values[i + 1] ?? "", true),
    ).join("") +
    `</details>`;

  const delegateFormBody = (
    csrf: string,
    state: DelegateFormState,
    errors: DelegateFormErrors,
    cap: number,
    used: number,
  ): string => {
    const atCap = used >= cap;
    const pickRadio = (value: string, label: string): string =>
      `<label class="pick"><input type="radio" name="deadlinePick" value="${value}"${state.deadlinePick === value ? " checked" : ""}> ${label}</label>`;
    // At cap the notice replaces the submit button — prevent, don't reject.
    const submitSlot = atCap
      ? `<p class="field-error">You're at the policy cap — ${used} of ${cap} mission slots used. Resolve or cancel a mission, then come back.</p>`
      : `<p><button type="submit">Delegate — an executor starts immediately.</button></p>`;
    return (
      `<p><a href="/ui">← Today</a></p>` +
      `<h1>NEW MISSION</h1>` +
      `<p class="meta">${used} of ${cap} mission slots used</p>` +
      `<form method="post" action="/ui/delegate">` +
      `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
      // Fresh id on every render: a validation-failed attempt never consumed
      // the previous one (route pre-checks run before the seam), and a fresh
      // uuid keeps retries clean even if a prior POST reached the seam.
      `<input type="hidden" name="submissionId" value="${randomUUID()}">` +
      `<label>What do you want owned?<br>` +
      `<input type="text" name="goal" maxlength="2000" required autocomplete="off" value="${escapeHtml(state.goal)}"></label>` +
      (errors.goal !== undefined ? fieldError(errors.goal) : "") +
      `<h2>Done means</h2>` +
      `<p class="meta">How will you judge this? You verify it later.</p>` +
      textRow("criterion", "Criterion", 1, state.criteria[0] ?? "", false) +
      (errors.criteria !== undefined ? fieldError(errors.criteria) : "") +
      extraRows("criterion", "Criterion", state.criteria) +
      `<h2>Limits</h2>` +
      `<p class="meta">Rules the executor must respect.</p>` +
      textRow("constraint", "Limit", 1, state.constraints[0] ?? "", false) +
      extraRows("constraint", "Limit", state.constraints) +
      `<h2>Deadline</h2>` +
      pickRadio("none", "None") +
      pickRadio("tonight", "Tonight") +
      pickRadio("tomorrow", "Tomorrow") +
      pickRadio("nextweek", "Next week") +
      pickRadio("custom", "Custom") +
      // Revealed by CSS when Custom is checked (:has) — no JS on this route.
      `<div class="deadline-custom">` +
      `<label>Custom date/time<br><input type="datetime-local" name="deadline" autocomplete="off" value="${escapeHtml(state.deadline)}"></label>` +
      `</div>` +
      (errors.deadline !== undefined ? fieldError(errors.deadline) : "") +
      (errors.form !== undefined ? fieldError(errors.form) : "") +
      submitSlot +
      `</form>`
    );
  };

  const delegateSlots = async (principalId: string): Promise<{ cap: number; used: number }> => {
    const cap = loadOutcomesPolicy().maxActivePerPrincipal;
    const used = (await listActiveOutcomes(db, principalId)).length;
    return { cap, used };
  };

  app.get("/ui/delegate", async (request, reply) => {
    const session = await todaySession(request, reply);
    if (session === null) return await sendHtml(reply, 401, unauthorizedPage());
    const { cap, used } = await delegateSlots(session.principal.id);
    return await sendHtml(
      reply,
      200,
      page(delegateFormBody(session.csrfToken, emptyDelegateState(), {}, cap, used)),
    );
  });

  app.post("/ui/delegate", async (request, reply) => {
    const session = await todaySession(request, reply);
    if (session === null) return await sendHtml(reply, 401, unauthorizedPage());
    const body = request.body as Record<string, unknown> | undefined;
    if (body === null || typeof body !== "object") {
      return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Invalid submission.</p>`));
    }
    if (!verifyCsrf(session, body.csrf)) {
      return await sendHtml(reply, 403, page(`<h1>TODAY</h1><p>Invalid CSRF token.</p>`));
    }
    const submissionId = typeof body.submissionId === "string" && UUID_RE.test(body.submissionId)
      ? body.submissionId
      : null;
    if (submissionId === null) {
      return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Invalid submission id.</p>`));
    }
    const state: DelegateFormState = {
      goal: typeof body.goal === "string" ? body.goal : "",
      criteria: Array.from({ length: DELEGATE_ROWS }, (_v, i) =>
        typeof body[`criterion${i + 1}`] === "string" ? String(body[`criterion${i + 1}`]) : "",
      ),
      constraints: Array.from({ length: DELEGATE_ROWS }, (_v, i) =>
        typeof body[`constraint${i + 1}`] === "string" ? String(body[`constraint${i + 1}`]) : "",
      ),
      deadlinePick:
        typeof body.deadlinePick === "string" && DEADLINE_PICKS.includes(body.deadlinePick)
          ? body.deadlinePick
          : "none",
      deadline: typeof body.deadline === "string" ? body.deadline : "",
    };
    // A typed datetime submitted without a pick (or under None) renders back
    // under Custom so the preserved value stays visible.
    if (state.deadline.trim().length > 0 && state.deadlinePick === "none") {
      state.deadlinePick = "custom";
    }

    // Inline-remedy re-render: same form, submitted values preserved, the
    // message next to the offending field — never a bare 400 page.
    const reRenderForm = async (errors: DelegateFormErrors): Promise<FastifyReply> => {
      const { cap, used } = await delegateSlots(session.principal.id);
      return await sendHtml(reply, 400, page(delegateFormBody(session.csrfToken, state, errors, cap, used)));
    };

    const now = new Date();
    const goal = state.goal.trim();
    if (goal.length === 0) {
      return await reRenderForm({ goal: "Enter what you want owned — one short line the executor starts from." });
    }
    if (goal.length < 4) {
      return await reRenderForm({ goal: "Give a little more detail — at least 4 characters, or the executor cannot act on it." });
    }
    if (state.criteria.every((c) => c.trim().length === 0)) {
      return await reRenderForm({ criteria: `Add at least one "Done means" row — how will you judge this done?` });
    }

    // Deadline: quick-picks resolve at POST time (§2 map, server-local);
    // Custom/legacy keeps the raw datetime-local contract.
    let deadlineAt: string | undefined;
    if (state.deadlinePick === "tonight" || state.deadlinePick === "tomorrow" || state.deadlinePick === "nextweek") {
      const target = resolveDeadlinePick(state.deadlinePick, now);
      if (target === null || target.getTime() <= now.getTime()) {
        return await reRenderForm({ deadline: "That quick pick already passed — choose another, or set a custom time." });
      }
      deadlineAt = target.toISOString();
    } else if (state.deadlinePick === "custom" || state.deadline.trim().length > 0) {
      if (state.deadline.trim().length === 0) {
        return await reRenderForm({ deadline: "You chose Custom — pick a date and time, or choose None for the default." });
      }
      const parsed = new Date(state.deadline);
      if (Number.isNaN(parsed.getTime())) {
        return await reRenderForm({ deadline: "That date and time could not be read — use the picker or type YYYY-MM-DD HH:MM." });
      }
      if (parsed.getTime() <= now.getTime()) {
        return await reRenderForm({ deadline: "That deadline already passed — pick a time in the future, or None for the default." });
      }
      deadlineAt = parsed.toISOString();
    }

    // Cap stays the SEAM's authority (it checks idempotency FIRST, so a
    // duplicate retry at cap still recovers the prior mission instead of
    // being rejected); a genuine cap rejection lands in the catch below and
    // re-renders inline with the notice in the submit slot.
    const policy = loadOutcomesPolicy();

    try {
      // Principal comes ONLY from the authenticated session — never the form.
      const mission = await createAndDispatchOutcome(
        db,
        dispatchPort(),
        {
          principalId: session.principal.id,
          principalName: session.principal.name,
          goal,
          directive: goal,
          criteria: state.criteria,
          constraints: state.constraints,
          deadlineAt,
          submissionId,
          policy,
        },
        { now, actor: `user:${session.principal.name}` },
      );
      // No confirmation page: land on the mission itself (one-time highlight).
      return await reply
        .code(303)
        .header("location", `/ui/missions?created=${encodeURIComponent(mission.outcome.ref)}`)
        .send("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "delegation failed";
      return await reRenderForm({ form: `Could not delegate: ${message}` });
    }
  });

  // -------------------------------------------------------- missions (W1.2)
  // Read-only projection of existing Outcomes — no new state. ?created=REF
  // (set by POST /ui/delegate's 303) applies a one-time CSS highlight pulse
  // to that mission's card; only a ref owned by THIS principal can match,
  // and anything else renders unhighlighted (fail-closed, never a leak).
  app.get("/ui/missions", async (request, reply) => {
    const session = await todaySession(request, reply);
    if (session === null) return await sendHtml(reply, 401, unauthorizedPage());
    const query = request.query as { created?: string } | undefined;
    const createdRef =
      typeof query?.created === "string" && query.created.length > 0 ? query.created : null;
    const now = new Date();
    const result = await db.query(
      `SELECT ref, title, status, deadline_at, updated_at
         FROM outcomes
        WHERE principal_id = $1::uuid
        ORDER BY (status IN ('completed','failed','cancelled')), updated_at DESC`,
      [session.principal.id],
    );
    type Row = { ref: string; title: string; status: string; deadline_at: string | Date | null; updated_at: string | Date };
    const rows = result.rows as Row[];
    const NEEDS_YOU = new Set(["waiting_user", "blocked"]);
    const RUNNING = new Set(["accepted", "queued", "running", "waiting_external", "verifying"]);
    const FINISHED = new Set(["completed", "failed", "cancelled"]);
    const recentCutoff = now.getTime() - 7 * 86_400_000;
    const asOf = (v: string | Date): Date => (v instanceof Date ? v : new Date(v));
    const cardHtml = (r: Row): string =>
      `<article${createdRef !== null && r.ref === createdRef ? ` class="created-pulse"` : ""}>` +
      `<h3><a href="/ui/outcome/${encodeURIComponent(r.ref)}">${escapeHtml(r.title)}</a></h3>` +
      `<p class="meta">${escapeHtml(r.ref)} · ${escapeHtml(r.status)} · updated ${escapeHtml(relativeAge(asOf(r.updated_at), now))}` +
      (r.deadline_at !== null ? ` · deadline ${escapeHtml(asOf(r.deadline_at).toISOString().slice(0, 16).replace("T", " "))}` : "") +
      `</p></article>`;
    const needs = rows.filter((r) => NEEDS_YOU.has(r.status));
    const running = rows.filter((r) => RUNNING.has(r.status));
    const finished = rows
      .filter((r) => FINISHED.has(r.status) && asOf(r.updated_at).getTime() >= recentCutoff)
      .slice(0, 20);
    const section = (title: string, list: Row[], empty: string): string =>
      `<h2>${title}</h2>` + (list.length > 0 ? list.map(cardHtml).join("") : `<p>${empty}</p>`);
    const body =
      `<p><a href="/ui">← Today</a></p>` +
      `<h1>MISSIONS</h1>` +
      section("Needs you", needs, "Nothing needs you.") +
      section("Running", running, "Nothing running.") +
      section("Recently finished", finished, "Nothing finished recently.");
    return await sendHtml(reply, 200, page(body));
  });

  // ------------------------------------------------------- outcome view
  const outcomeView = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const session = await todaySession(request, reply);
    if (session === null) {
      return await sendHtml(reply, 401, unauthorizedPage());
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
