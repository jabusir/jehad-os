/**
 * Today — the private tailnet web read-out (ADR-0019; W1 contract §"API
 * contract"). Server-rendered HTML plus exactly ONE hash-pinned inline
 * enhancement script (ADR-0022, ui-script.ts): no SPA, no framework, no
 * external assets. Four hard rules from ADR-0019 §2 are enforced here:
 *
 * 1. Identity gate: one-time bearer-credential paste → stateless signed
 *    session cookie (Secure+HttpOnly+SameSite=Strict; see session.ts).
 * 2. CSRF token on every state-changing POST (session-scoped, constant-time
 *    compare). POST /ui/session is the pre-auth login endpoint: no session
 *    (hence no session-scoped CSRF token) exists yet; SameSite=Strict plus
 *    the one-time credential itself close the login-CSRF window.
 * 3. Every string derived from external content escapes through the single
 *    escapeHtml helper; the ADR-0022 CSP (TODAY_CSP) on every response.
 * 4. Actions render from the ADR-0018 §1.6 registry descriptors only —
 *    never from row-stored endpoints; unknown keys render nothing and
 *    dispatch nothing (fail-closed).
 *
 * U0 foundations (docs/plans/today-ux-overhaul.md, Lane A): design tokens,
 * language map, relative times, remedy-oriented error pages, CTA empty
 * states, and the primary-action card structure (one filled primary button +
 * a `⋯` details sheet) all live in ui-presentation.ts — this module stays
 * the behavior boundary (session, CSRF, ownership, dispatch, redirects).
 * CSRF failures re-render the originating form with an inline banner and a
 * fresh token: never a dead end.
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
  storedActionMatches,
  snoozeAttention,
} from "@jehad/core";
import { escapeHtml } from "../escape-html.js";
import { issueSession, verifyCsrf, verifySession, type TodaySession } from "../session.js";
import { loadTodayAuthPolicy, resolveTailscalePrincipal } from "../tailscale-auth.js";
import { scriptTags, TODAY_CSP } from "./ui-script.js";
import { createAndDispatchOutcome, createWorkflowRuntime, type OutcomeDispatchPort } from "@jehad/workflow";
import { outcomesPolicyOf, parsePolicyV1 } from "@jehad/core";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  doneBannerText,
  emptyState,
  errorPage,
  flashBanner,
  formatLocalTime,
  humanizeCriterion,
  page,
  relativeTime,
  statusPill,
  timeAttr,
} from "./ui-presentation.js";

export interface UiRoutesOptions {
  db: SqlExecutor;
  /** Defaults to the real WorkflowRuntime; tests inject a counting fake. */
  dispatch?: OutcomeDispatchPort;
}

/**
 * ADR-0022 CSP (amends ADR-0019's `default-src 'none'`) — sent on every
 * Today response. Hash-pinned to the inline enhancement script it serves;
 * see ui-script.ts for the script, the hash, and the directive rationale.
 */

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
    .header("content-security-policy", TODAY_CSP)
    .send(html);
}

// ------------------------------------------------------------ action forms

type CardAction = TodayItem["actions"][number];

/**
 * The registry-form for one stored action. Field names, endpoint, and hidden
 * values are the action contract — they never change with the styling.
 */
function actionForm(
  item: TodayItem,
  action: CardAction,
  descriptor: ActionDescriptor,
  csrf: string,
  buttonClass: string,
): string {
  const args = action.args ?? descriptor.defaultArgs ?? {};
  const button = buttonClass === "" ? "" : ` class="${buttonClass}"`;
  return (
    `<form method="post" action="/ui/action">` +
    `<input type="hidden" name="itemId" value="${escapeHtml(item.id)}">` +
    `<input type="hidden" name="key" value="${escapeHtml(action.key)}">` +
    `<input type="hidden" name="args" value="${escapeHtml(JSON.stringify(args))}">` +
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<button type="submit"${button}>${escapeHtml(descriptor.label(args))}</button></form>`
  );
}

/** Registry-known actions only; unknown keys render nothing (fail-closed). */
function knownActions(item: TodayItem): { action: CardAction; descriptor: ActionDescriptor }[] {
  const out: { action: CardAction; descriptor: ActionDescriptor }[] = [];
  for (const action of item.actions) {
    const descriptor = getActionDescriptor(action.key) as ActionDescriptor | null;
    if (descriptor !== null) out.push({ action, descriptor });
  }
  return out;
}

/** Outcome cards carry an outcome link/outcome evidence; everything else is a watch card. */
function isOutcomeCard(item: TodayItem): boolean {
  return (
    item.actions.some((a) => a.key === "outcome.open") ||
    item.evidenceRefs.some((r) => r.type === "outcome")
  );
}

function evidenceText(item: TodayItem): string {
  return item.evidenceRefs
    .map((r) => (r.type === "outcome" ? `Outcome ${r.id}` : `${r.type} ${r.id}`))
    .join(" · ");
}

/**
 * One card = title, whyItMatters, humanized meta, and the action area: ONE
 * filled primary button (context-aware — resolve on outcome cards, seen on
 * watch cards) + every remaining action inside a `⋯` details sheet, with
 * Dismiss red and separated at the end.
 */
function card(item: TodayItem, csrf: string, now: Date): string {
  const known = knownActions(item);
  const prefKeys = isOutcomeCard(item)
    ? ["attention.resolve", "attention.seen"]
    : ["attention.seen", "attention.resolve"];
  let primary: { action: CardAction; descriptor: ActionDescriptor } | undefined;
  for (const prefKey of prefKeys) {
    primary = known.find((d) => d.action.key === prefKey);
    if (primary !== undefined) break;
  }
  if (primary === undefined) {
    primary = known.find((d) => d.descriptor.kind !== "dismiss") ?? known[0];
  }
  const rest = primary === undefined ? [] : known.filter((d) => d !== primary);
  const sheetMid = rest.filter((d) => d.descriptor.kind !== "dismiss");
  const sheetDismiss = rest.filter((d) => d.descriptor.kind === "dismiss");

  const primaryForm =
    primary === undefined
      ? ""
      : actionForm(
          item,
          primary.action,
          primary.descriptor,
          csrf,
          primary.descriptor.kind === "dismiss" ? "btn-danger" : "btn-primary",
        );
  const sheetEntries = [...sheetMid, ...sheetDismiss];
  const sheet =
    sheetEntries.length === 0
      ? ""
      : `<details class="sheet">` +
        `<summary class="sheet-toggle" aria-label="More actions">⋯</summary>` +
        `<div class="sheet-body">` +
        sheetEntries
          .map((d) => {
            const danger = d.descriptor.kind === "dismiss";
            return (
              (danger ? `<div class="sheet-danger">` : `<div>`) +
              actionForm(item, d.action, d.descriptor, csrf, danger ? "btn-danger" : "btn-secondary") +
              `</div>`
            );
          })
          .join("") +
        `</div></details>`;

  const meta = [
    `<time ${timeAttr(item.firstRaisedAt.toISOString())}>${relativeTime(item.firstRaisedAt, now)}</time>`,
  ];
  if (item.occurrences > 1) meta.push(`×${item.occurrences} occurrences`);
  const evidence = evidenceText(item);
  if (evidence.length > 0) meta.push(escapeHtml(evidence));
  if (item.state === "snoozed" && item.snoozedUntil !== null) {
    const until = new Date(item.snoozedUntil);
    if (!Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) {
      meta.push(
        `back <time ${timeAttr(until.toISOString())}>${formatLocalTime(until)}</time>`,
      );
    }
  }
  return (
    `<article class="card" id="item-${escapeHtml(item.id)}">` +
    `<h3>${escapeHtml(item.title)}</h3>` +
    (item.whyItMatters ? `<p>${escapeHtml(item.whyItMatters)}</p>` : "") +
    `<p class="meta">${meta.join(" · ")}</p>` +
    primaryForm +
    sheet +
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

/** Remedy-oriented error body for card-action failures (way back = Today). */
function actionError(heading: string, what: string, remedy: string): string {
  return errorPage({
    heading,
    what,
    remedy,
    backHref: "/ui",
    backLabel: "Back to Today",
    navPath: "/ui",
  });
}

/**
 * CSRF failure on a card action → the originating form re-rendered with an
 * inline banner and a FRESH session token: a legitimate stale page retries
 * with one tap; an attacker gains nothing (no auto-submit, no JS, and the
 * token is only ever readable by the already-authenticated session itself).
 */
function csrfRetryPage(session: TodaySession, body: Record<string, unknown>): string {
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  const key = typeof body.key === "string" ? body.key : "";
  const args = typeof body.args === "string" ? body.args : "";
  return errorPage({
    heading: "One more tap needed",
    what:
      "This action was not completed: its form token didn't match this session, so it was refused. Nothing changed.",
    remedy:
      "If this is what you meant to do, submit it again below — the form now carries a fresh token.",
    formHtml:
      `<div class="banner-error" role="alert"><p>Not completed — the security token was stale or missing.</p></div>` +
      `<div class="error-form"><form method="post" action="/ui/action">` +
      `<input type="hidden" name="itemId" value="${escapeHtml(itemId)}">` +
      `<input type="hidden" name="key" value="${escapeHtml(key)}">` +
      `<input type="hidden" name="args" value="${escapeHtml(args)}">` +
      `<input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">` +
      `<button type="submit" class="btn-primary">Try the action again</button>` +
      `</form></div>`,
    backHref: "/ui",
    backLabel: "Back to Today",
    navPath: "/ui",
  });
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
    errorPage({
      heading: "Today",
      what: "Not signed in — Today is private to allowlisted devices on your tailnet.",
      remedy: "Open this tailnet URL from an allowlisted device, or use recovery sign-in below.",
      backHref: "/ui/recovery",
      backLabel: "recovery sign-in",
    });

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
    const query = request.query as { done?: string } | undefined;
    const flashText =
      typeof query === "object" && query !== null && typeof query.done === "string"
        ? doneBannerText(query.done)
        : null;
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
      `<h1>Today</h1>` +
      (flashText !== null ? flashBanner(flashText) : "") +
      `<h2>Needs you</h2>` +
      (needs.length > 0
        ? needs.map((i) => card(i, session.csrfToken, now)).join("")
        : emptyState(
            "Nothing needs you right now. Delegated work is running — or you could hand something off.",
            "Delegate something",
            "/ui/delegate",
          )) +
      `<h2>Snoozed</h2>` +
      (snoozed.length > 0
        ? snoozed.map((i) => card(i, session.csrfToken, now)).join("")
        : emptyState("Nothing snoozed. Cards you snooze come back here on time."));
    return await sendHtml(reply, 200, page(body, { path: "/ui" }));
  });

  // -------------------------------------------------------------- action
  app.post("/ui/action", async (request, reply) => {
    const session = await verifySession(db, request.headers.cookie, new Date());
    if (session === null) {
      return await sendHtml(reply, 401, pasteFormPage("Session expired — paste your credential again to keep going."));
    }
    const body = (typeof request.body === "object" && request.body !== null
      ? (request.body as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    if (!verifyCsrf(session, body.csrf)) {
      return await sendHtml(reply, 403, csrfRetryPage(session, body));
    }
    const itemId = body.itemId;
    if (typeof itemId !== "string" || !UUID_RE.test(itemId)) {
      return await sendHtml(reply, 400, actionError(
        "That request was incomplete",
        "The action didn't include a valid card id, so nothing could be matched.",
        "Go back to Today and tap the action on its card.",
      ));
    }
    const key = body.key;
    const descriptor = (typeof key === "string" ? getActionDescriptor(key) : null) as ActionDescriptor | null;
    if (descriptor === null) {
      return await sendHtml(reply, 400, actionError(
        "Unknown action",
        "That action isn't one this server offers, so it was refused.",
        "Go back to Today and use the buttons shown on the card.",
      ));
    }
    const args = parseArgs(body.args);
    if (args === null) {
      return await sendHtml(reply, 400, actionError(
        "That action couldn't be validated",
        "The action's saved details arrived in a form this server couldn't read.",
        "Go back to Today and try the action from its card.",
      ));
    }
    if (descriptor.validateArgs !== undefined && !descriptor.validateArgs(args)) {
      return await sendHtml(reply, 400, actionError(
        "That action couldn't be validated",
        "The action's saved details didn't meet this action's requirements.",
        "Go back to Today and try the action from its card.",
      ));
    }
    const principalId = session.principal.id;
    const actor = `user:${session.principal.name}`;
    const now = new Date();
    // Fail-closed ownership gate: the item must be in this principal's open
    // set (open/seen/snoozed are exactly the actionable states).
    const items = (await listOpenAttention(db, principalId, { now, includeSnoozed: true })) as readonly TodayItem[];
    const item = items.find((i) => i.id === itemId);
    if (item === undefined) {
      return await sendHtml(reply, 404, actionError(
        "That card isn't available",
        "It may already be resolved or dismissed, or it belongs to a different account.",
        "Reopen Today to see the cards that currently need you.",
      ));
    }
    // W1.1 finding 5 — authorization is registry AND item: the submitted
    // {key,args} must match an action the producer actually stored on THIS
    // row. A registered key absent from the item (or with args the row never
    // carried) fails closed — the registry alone is not authorization.
    const storedActions = (item.actions ?? []) as readonly { key: string; args?: Record<string, string | number> }[];
    if (!storedActionMatches(storedActions, String(key), args)) {
      return await sendHtml(reply, 403, actionError(
        "That action isn't offered on this card",
        "The card's producer didn't attach this action, so it was refused.",
        "Go back to Today and use the actions shown on the card.",
      ));
    }
    switch (descriptor.kind) {
      case "resolve": {
        const updated = await resolveAttention(db, principalId, itemId, { now, actor, by: "owner" });
        if (updated === null) return await sendHtml(reply, 404, actionError(
          "That card isn't available",
          "It changed state before this action could run, so nothing happened.",
          "Reopen Today to see what still needs you.",
        ));
        return await reply.code(303).header("location", "/ui?done=resolve").send("");
      }
      case "dismiss": {
        const updated = await dismissAttention(db, principalId, itemId, { now, actor });
        if (updated === null) return await sendHtml(reply, 404, actionError(
          "That card isn't available",
          "It changed state before this action could run, so nothing happened.",
          "Reopen Today to see what still needs you.",
        ));
        return await reply.code(303).header("location", "/ui?done=resolve").send("");
      }
      case "seen": {
        const updated = await markSeen(db, principalId, itemId, { now, actor });
        if (updated === null) return await sendHtml(reply, 404, actionError(
          "That card isn't available",
          "It changed state before this action could run, so nothing happened.",
          "Reopen Today to see what still needs you.",
        ));
        return await reply.code(303).header("location", "/ui?done=resolve").send("");
      }
      case "snooze": {
        const minutes = Number(args.minutes ?? descriptor.defaultArgs?.minutes);
        if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 4320) {
          return await sendHtml(reply, 400, actionError(
            "That snooze length isn't allowed",
            "Snoozes work between 5 minutes and 3 days (4320 minutes).",
            "Go back to Today and snooze again with a length in that range.",
          ));
        }
        const updated = await snoozeAttention(db, principalId, itemId, minutes, { now, actor });
        if (updated === null) return await sendHtml(reply, 404, actionError(
          "That card isn't available",
          "It changed state before this action could run, so nothing happened.",
          "Reopen Today to see what still needs you.",
        ));
        return await reply.code(303).header("location", "/ui?done=snooze").send("");
      }
      case "feedback": {
        const verdict = args.verdict;
        if (!isFeedbackVerdict(verdict)) {
          return await sendHtml(reply, 400, actionError(
            "That feedback wasn't recorded",
            "The feedback verdict wasn't one of the allowed kinds.",
            "Go back to Today and send feedback from the card.",
          ));
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
            return await sendHtml(reply, 400, actionError(
              "That feedback wasn't recorded",
              "The feedback verdict wasn't one of the allowed kinds.",
              "Go back to Today and send feedback from the card.",
            ));
          }
          throw err;
        }
        return await reply.code(303).header("location", "/ui?done=feedback").send("");
      }
      case "link": {
        const ref = args.ref;
        if (typeof ref !== "string" || ref.length === 0) {
          return await sendHtml(reply, 400, actionError(
            "That link target wasn't valid",
            "The card's link didn't carry a usable mission reference.",
            "Go back to Today and open the card again.",
          ));
        }
        const outcome = await getOutcomeByRef(db, principalId, ref);
        if (outcome === null) {
          return await sendHtml(reply, 404, actionError(
            "That mission isn't available",
            "The linked mission doesn't exist for your account.",
            "Reopen Today to see the cards that currently need you.",
          ));
        }
        return await reply.code(302).header("location", `/ui/outcome/${encodeURIComponent(ref)}`).send("");
      }
    }
  });


  // ------------------------------------------------------- delegate (W1.2)
  // Explicit structured Outcome creation — NOT a chatbot. The user chooses
  // the verb (Delegate); natural language is only the CONTENT of bounded
  // fields. No model calls, no intent inference, no josctl shell-out: the
  // route uses the SAME canonical seam as the CLI (createAndDispatchOutcome).
  const DELEGATE_ROWS = 4;
  const rowInputs = (name: string, labels: readonly string[]): string =>
    labels
      .map((label, i) => {
        const n = i + 1;
        return (
          `<label>${label} ${n}<br>` +
          `<input type="text" name="${name}${n}" maxlength="2000" autocomplete="off"></label>`
        );
      })
      .join("");

  app.get("/ui/delegate", async (request, reply) => {
    const session = await todaySession(request, reply);
    if (session === null) return await sendHtml(reply, 401, unauthorizedPage());
    const body =
      `<p><a href="/ui">← Today</a></p>` +
      `<h1>NEW MISSION</h1>` +
      `<form method="post" action="/ui/delegate">` +
      `<input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">` +
      `<input type="hidden" name="submissionId" value="${randomUUID()}">` +
      `<label>What do you want owned?<br>` +
      `<input type="text" name="goal" maxlength="2000" required autocomplete="off"></label>` +
      `<h2>Done means</h2>` +
      rowInputs("criterion", Array.from({ length: DELEGATE_ROWS }, () => "")) +
      `<h2>Constraints</h2>` +
      rowInputs("constraint", Array.from({ length: DELEGATE_ROWS }, () => "")) +
      `<h2>Deadline</h2>` +
      `<label>Optional date/time<br><input type="datetime-local" name="deadline" autocomplete="off"></label>` +
      `<p><button type="submit">Delegate</button></p>` +
      `</form>`;
    return await sendHtml(reply, 200, page(body));
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
    const goal = typeof body.goal === "string" ? body.goal : "";
    const criteria = Array.from({ length: DELEGATE_ROWS }, (_v, i) =>
      typeof body[`criterion${i + 1}`] === "string" ? String(body[`criterion${i + 1}`]) : "",
    );
    const constraints = Array.from({ length: DELEGATE_ROWS }, (_v, i) =>
      typeof body[`constraint${i + 1}`] === "string" ? String(body[`constraint${i + 1}`]) : "",
    );
    let deadlineAt: string | undefined;
    if (typeof body.deadline === "string" && body.deadline.trim().length > 0) {
      const parsed = new Date(body.deadline);
      if (Number.isNaN(parsed.getTime())) {
        return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Malformed deadline.</p>`));
      }
      if (parsed.getTime() <= Date.now()) {
        return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>Deadline must be in the future.</p>`));
      }
      deadlineAt = parsed.toISOString();
    }
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
          criteria,
          constraints,
          deadlineAt,
          submissionId,
          policy: loadOutcomesPolicy(),
        },
        { now: new Date(), actor: `user:${session.principal.name}` },
      );
      const ref = escapeHtml(mission.outcome.ref);
      const banner = mission.alreadyRequested
        ? `<p>Already delegated — showing the existing mission ${ref}.</p>`
        : `<p>Mission ${ref} delegated — the executor is running it.</p>`;
      return await sendHtml(
        reply,
        200,
        page(
          `<p><a href="/ui">← Today</a> · <a href="/ui/missions">Missions</a></p>` +
            `<h1>DELEGATED</h1>${banner}` +
            `<p><a href="/ui/missions">Open Missions</a></p>`,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "delegation failed";
      return await sendHtml(reply, 400, page(`<h1>TODAY</h1><p>${escapeHtml(message)}</p>`));
    }
  });

  // -------------------------------------------------------- missions (W1.2)
  // Read-only projection of existing Outcomes — no new state.
  app.get("/ui/missions", async (request, reply) => {
    const session = await todaySession(request, reply);
    if (session === null) return await sendHtml(reply, 401, unauthorizedPage());
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
      `<article class="card">` +
      `<h3><a href="/ui/outcome/${encodeURIComponent(r.ref)}">${escapeHtml(r.title)}</a></h3>` +
      `<p class="meta">${escapeHtml(r.ref)} · ${statusPill(r.status)} · updated <time ${timeAttr(asOf(r.updated_at).toISOString())}>${relativeTime(asOf(r.updated_at), now)}</time>` +
      (r.deadline_at !== null ? ` · deadline <time ${timeAttr(asOf(r.deadline_at).toISOString())}>${formatLocalTime(asOf(r.deadline_at))}</time>` : "") +
      `</p></article>`;
    const needs = rows.filter((r) => NEEDS_YOU.has(r.status));
    const running = rows.filter((r) => RUNNING.has(r.status));
    const finished = rows
      .filter((r) => FINISHED.has(r.status) && asOf(r.updated_at).getTime() >= recentCutoff)
      .slice(0, 20);
    const section = (title: string, list: Row[], empty: string): string =>
      `<h2>${title}</h2>` + (list.length > 0 ? list.map(cardHtml).join("") : `<p>${empty}</p>`);
    const body =
      `<h1>Missions</h1>` +
      (rows.length === 0
        ? emptyState(
            "No missions yet. Delegate work with a definition of done and follow along here.",
            "Create your first mission",
            "/ui/delegate",
          )
        : section("Needs you", needs, "Nothing is waiting on you.") +
          section("Running", running, "Nothing is in motion right now.") +
          section("Recently finished", finished, "Nothing finished in the last 7 days."));
    return await sendHtml(reply, 200, page(body, { path: "/ui/missions" }));
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
      return await sendHtml(reply, 400, errorPage({
        heading: "Missing mission reference",
        what: "This view needs a mission ref to show anything.",
        remedy: "Open Missions and pick the mission there.",
        backHref: "/ui/missions",
        backLabel: "Back to Missions",
        navPath: "/ui/missions",
      }));
    }
    const outcome = await getOutcomeByRef(db, session.principal.id, ref);
    if (outcome === null) {
      return await sendHtml(reply, 404, errorPage({
        heading: "That mission isn't available",
        what: "No mission with that reference exists for your account — foreign refs 404, never a leak.",
        remedy: "Open Missions to see the missions that belong to you.",
        backHref: "/ui/missions",
        backLabel: "Back to Missions",
        navPath: "/ui/missions",
      }));
    }
    const criteria = await listOutcomeCriteria(db, session.principal.id, outcome.id);
    const list = criteria
      .map((c) => {
        const glyph = CRITERION_GLYPHS[c.status] ?? "·";
        return `<li><span class="glyph">${escapeHtml(glyph)}</span> ${escapeHtml(c.criterion)} <span class="meta">(${escapeHtml(humanizeCriterion(c.status))})</span></li>`;
      })
      .join("");
    const body =
      `<p class="crumb"><a href="/ui/missions">← Missions</a></p>` +
      `<h1>${escapeHtml(outcome.title)}</h1>` +
      `<p class="meta">${escapeHtml(outcome.ref)} · ${statusPill(outcome.status)}</p>` +
      `<p class="meta">Created <time ${timeAttr(outcome.createdAt)}>${formatLocalTime(outcome.createdAt)}</time> · Updated <time ${timeAttr(outcome.updatedAt)}>${formatLocalTime(outcome.updatedAt)}</time></p>` +
      `<h2>Criteria</h2><ul class="criteria">${list}</ul>`;
    return await sendHtml(reply, 200, page(body, { path: "/ui/missions" }));
  };
  // Query-shape route is what cookie-browsers hit: auth.ts's publicPaths
  // exact-match can only exempt static paths, so buildApp rewrites the
  // contract path /ui/outcome/:ref onto it before the bearer gate runs.
  app.get("/ui/outcome", outcomeView);
  app.get("/ui/outcome/:ref", outcomeView); // contract shape; bearer clients (or post-merge hook changes)
}

/**
 * Recovery/credential-paste form (break-glass) — the originating form for
 * pre-auth 401s, re-rendered remedy-style with the way forward inline.
 */
function pasteFormPage(message: string): string {
  return errorPage({
    heading: "Recovery sign-in",
    what: message,
    remedy: "Paste a one-time credential below. It opens a private Today session on this device.",
    formHtml:
      `<div class="error-form"><form method="post" action="/ui/session">` +
      `<input type="password" name="token" autocomplete="off" required>` +
      `<button type="submit" class="btn-primary">Open Today</button>` +
      `</form></div>`,
  });
}
