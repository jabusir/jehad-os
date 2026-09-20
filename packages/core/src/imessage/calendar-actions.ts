// Phase H — consequential calendar actions, infrastructure module
// (docs/plans/ig-phase-h-contracts.md). One v1 action: calendar_create on
// the owner's primary calendar, ALWAYS-CONFIRM (ESCALATE-1 default),
// tentative insert (ESCALATE-2 default).
//
// This module owns the propose → confirm → dispatch → reconcile seam the
// orchestrator (conversation.ts) wires; it receives already-extracted
// title/start/end as parameters and makes NO model calls. The M4B chain
// (ActionService) is used UNCHANGED — H adds a request surface + policy,
// not a fork of that chain:
//
//   propose  → validate (§4 table, deterministic, no intent row on
//              violation) → createIntent('proposed') + confirm token
//   confirm  → token lookup (unresolved, unexpired, principal match —
//              wrong principal fails closed + audit) → payload-hash
//              binding check → single-use consumption (the atomic
//              proposed→approved transition; consumed_at is bookkeeping)
//              → prepare → mint act:<provider> grant (ADR-0007, ~5min)
//              → startAttempt → honest reply per outcome
//   reconcile→ UNKNOWN resolved by provider read-back via the
//              idempotencyKey extended property stamp; not-found keeps the
//              attempt `unknown` (R10) and reports not-created honestly.
//
// Audits are imessage.action.* and content-bounded: the event TITLE is the
// action payload (not conversation content) and is allowed, but always
// masked through redactContent; everything else is ids/counts/states only.
// Replies are deterministic fixed-shape strings (contract §8) — honest,
// free, cannot paraphrase into a lie.

import { createHash, randomBytes } from "node:crypto";
import type { ActionProvider } from "@jehad/adapters";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import {
  ActionService,
  GrantDeniedError,
  IntentNotFoundError,
  InvalidIntentTransitionError,
  type ActionAttemptRecord,
  type ActionIntentRecord,
} from "../actions/action-service.js";
import { issueGrant } from "../policy/grants.js";
import type { PolicyV1 } from "../policy/ceiling.js";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";
import { redactContent } from "./redact.js";

// ------------------------------------------------------------- constants

export const CALENDAR_ACTION_SURFACE = "imessage";
export const CALENDAR_ACTION_DOMAIN_KEY = "personal";
/** The one v1 action tag carried in intent payloads + quota filters. */
export const CALENDAR_ACTION_TYPE = "calendar_create";
/** Grant/attempt capability for the write provider (act:<provider.id>). */
export const CALENDAR_ACTION_CAPABILITY = "act:google-calendar";
/** Fixed v1 resource: the owner's primary calendar (not a payload field). */
export const CALENDAR_RESOURCE = "calendar:primary";
/** Per-action capability grant TTL (ADR-0007 layer 2; dispatch window). */
export const CALENDAR_GRANT_TTL_MS = 5 * 60_000;

/** Contract §4 payload bounds — server-side, non-negotiable. */
export const CALENDAR_TITLE_MAX_CHARS = 120;
export const CALENDAR_DURATION_MIN_MS = 15 * 60_000;
export const CALENDAR_DURATION_MAX_MS = 12 * 60 * 60_000;
export const CALENDAR_START_MAX_AHEAD_MS = 14 * 24 * 60 * 60_000;

const CALENDAR_ACTOR = "system:imessage-gateway";

// ------------------------------------------------------------- policy

/** policy.yaml `gateway.actions` shape (contract §7 — strict keys). */
export interface CalendarActionPolicy {
  readonly enabled: boolean;
  readonly principals: readonly string[];
  readonly maxProposalsPerDay: number;
  readonly maxDispatchesPerDay: number;
  readonly confirmTtlMinutes: number;
}

/** Contract §7/§11 defaults (ESCALATE-4: owner tunes quota + TTL). */
export const DEFAULT_CALENDAR_ACTION_POLICY: CalendarActionPolicy = {
  enabled: true,
  principals: ["josctl"],
  maxProposalsPerDay: 10,
  maxDispatchesPerDay: 5,
  confirmTtlMinutes: 10,
};

/** Projects the parsed policy.yaml gateway.actions onto the module policy. */
export function calendarActionsFromPolicyV1(
  policy: PolicyV1 | null | undefined,
): CalendarActionPolicy | null {
  const actions = policy?.gateway?.actions;
  if (actions === undefined) return null;
  return {
    enabled: actions.enabled,
    principals: actions.principals,
    maxProposalsPerDay: actions.maxProposalsPerDay,
    maxDispatchesPerDay: actions.maxDispatchesPerDay,
    confirmTtlMinutes: actions.confirmTtlMinutes,
  };
}

/** Only for principals whose policy enables the action lane (contract §6). */
export function calendarActionsEnabledFor(
  principalName: string,
  policy?: CalendarActionPolicy | null,
): boolean {
  const p = policy ?? DEFAULT_CALENDAR_ACTION_POLICY;
  return p.enabled && p.principals.includes(principalName);
}

// ------------------------------------------------------------- honest replies

/** Quota / denial / wrong-principal — deterministic, zero model calls. */
export const CALENDAR_ACTION_DENIED_REPLY =
  "I can't create calendar events from this chat — calendar actions are enabled only for Jehad on this channel.";
export const CALENDAR_ACTION_PROPOSAL_CAPPED_REPLY =
  "Daily proposal limit reached — nothing was created. Try again tomorrow.";
export const CALENDAR_ACTION_DISPATCH_CAPPED_REPLY =
  "Daily calendar-action limit reached — nothing was created. Try again tomorrow.";
/** Replay / unknown token — the replay adversary (#1) gets no state detail. */
export const CALENDAR_CONFIRM_USED_REPLY =
  "That confirmation code was already used or doesn't match anything pending — nothing was created.";
export const CALENDAR_CONFIRM_EXPIRED_REPLY =
  "Confirmation expired — nothing was created.";
export const CALENDAR_CONFIRM_MISMATCH_REPLY =
  "That confirmation doesn't match what was proposed — nothing was created. Ask again to propose a fresh event.";
export const CALENDAR_CANCELLED_REPLY = "Cancelled — nothing was created.";
export const CALENDAR_CONFIRM_EXECUTING_REPLY = "Confirmed — creating now.";
/** unknown is NEVER rendered as success (contract §8; R10). */
export const CALENDAR_UNKNOWN_REPLY =
  "The calendar may or may not have the event — I'm checking and will follow up.";
export const CALENDAR_RECONCILE_NOT_CREATED_REPLY =
  "Still unresolved — treating it as not-created; no retry without your say-so.";
export const CALENDAR_GRANT_EXPIRED_REPLY =
  "The confirmation window closed before the create went out — nothing was changed. Ask again to propose a fresh event.";

// ------------------------------------------------------------- detection

export interface CalendarActionRequestMatch {
  readonly proposed: boolean;
  /** Always null in v1 — extraction is the route pass's job (wiring seam). */
  readonly title: string | null;
}

const NEGATED_ACTION =
  /^(?:please\s+|just\s+)?(?:do\s*not|don't|dont|never)\s+(?:please\s+)?(?:schedule|add|put)\b/i;
const SCHEDULE_PREFIX = /^(?:please\s+|just\s+)?(?:can\s+you\s+)?schedule\s+\S/i;
const ADD_TO_CALENDAR =
  /^(?:please\s+|just\s+)?(?:can\s+you\s+)?add\s+.+?\s+(?:to|on)\s+(?:my|the)\s+calendar\b/i;

/**
 * Deterministic pre-pass ONLY for explicit action phrasings —
 * "schedule …" / "add … to my calendar". Returns title=null: payload
 * extraction (title/start/end) is the route pass's job later; this is the
 * wiring seam the orchestrator consults before spending a model call.
 * null = not an action request. Never reads tool output or history.
 */
export function parseActionRequest(text: string): CalendarActionRequestMatch | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.endsWith("?")) return null;
  if (NEGATED_ACTION.test(trimmed)) return null;
  if (SCHEDULE_PREFIX.test(trimmed) || ADD_TO_CALENDAR.test(trimmed)) {
    return { proposed: true, title: null };
  }
  return null;
}

// ------------------------------------------------------------- validation

export type CalendarPayloadViolation =
  | "title-missing"
  | "title-too-long"
  | "start-unparsable"
  | "end-unparsable"
  | "start-not-future"
  | "start-too-far"
  | "duration-too-short"
  | "duration-too-long"
  | "duration-not-whole-minutes";

const VIOLATION_PHRASES: Readonly<Record<CalendarPayloadViolation, string>> = {
  "title-missing": "a title is required",
  "title-too-long": `the title must be at most ${CALENDAR_TITLE_MAX_CHARS} characters`,
  "start-unparsable": "the start time must be a valid date-time",
  "end-unparsable": "the end time must be a valid date-time",
  "start-not-future": "the start must be in the future",
  "start-too-far": "the start must be within the next 14 days",
  "duration-too-short": "the duration must be at least 15 minutes",
  "duration-too-long": "the duration must be at most 12 hours",
  "duration-not-whole-minutes": "the duration must be whole minutes",
};

/**
 * Contract §4 payload table — deterministic, server-side, non-negotiable.
 * A violation means NO intent row and the fixed constraint reply; the model
 * never sees the constraints as negotiable "guidelines".
 */
export function validateCalendarPayload(
  input: { readonly title: string; readonly startIso: string; readonly endIso: string },
  now: Date,
): readonly CalendarPayloadViolation[] {
  const violations: CalendarPayloadViolation[] = [];
  const title = redactContent(input.title.replaceAll(/[\p{C}\p{Cf}]/gu, "")).trim();
  if (title.length === 0) violations.push("title-missing");
  else if (title.length > CALENDAR_TITLE_MAX_CHARS) violations.push("title-too-long");

  const start = Date.parse(input.startIso);
  if (Number.isNaN(start)) violations.push("start-unparsable");
  const end = Date.parse(input.endIso);
  if (Number.isNaN(end)) violations.push("end-unparsable");
  if (!Number.isNaN(start)) {
    if (start <= now.getTime()) violations.push("start-not-future");
    if (start > now.getTime() + CALENDAR_START_MAX_AHEAD_MS) violations.push("start-too-far");
  }
  if (!Number.isNaN(start) && !Number.isNaN(end)) {
    const durationMs = end - start;
    if (durationMs < CALENDAR_DURATION_MIN_MS) violations.push("duration-too-short");
    if (durationMs > CALENDAR_DURATION_MAX_MS) violations.push("duration-too-long");
    if (durationMs > 0 && durationMs % 60_000 !== 0) violations.push("duration-not-whole-minutes");
  }
  return violations;
}

/** Fixed constraint reply (contract §8 "invalid payload" row). */
export function calendarInvalidReply(violations: readonly CalendarPayloadViolation[]): string {
  const phrases = violations.map((v) => VIOLATION_PHRASES[v]);
  return `I can't schedule that as described: ${phrases.join("; ")}. Nothing was created — adjust and ask again.`;
}

// ------------------------------------------------------------- render helpers

/** Civil datetime in BRIEF_TIMEZONE — dates resolve server-side only (§3). */
export function formatCivilRange(startIso: string, endIso: string): string {
  return `${civilDay(startIso)}, ${civilTime(startIso)} – ${civilTime(endIso)}`;
}

function civilDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(iso));
}

function civilTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(iso));
}

/** Reconciled reply shape (§8): title + civil start. */
export function formatCivilStart(iso: string): string {
  return `${civilDay(iso)}, ${civilTime(iso)}`;
}

export function formatDurationMs(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Contract §8 "proposed / awaiting-confirm": one message, no model call. */
export function renderCalendarProposal(
  confirmToken: string,
  title: string,
  startIso: string,
  endIso: string,
): string {
  return (
    `Calendar event proposed: "${title}" · ${formatCivilRange(startIso, endIso)} ` +
    `(${formatDurationMs(Date.parse(endIso) - Date.parse(startIso))}) · your calendar.\n` +
    `[${confirmToken}] Reply: confirm ${confirmToken} · cancel ${confirmToken}`
  );
}

export function calendarSucceededReply(
  title: string,
  startIso: string,
  endIso: string,
): string {
  return (
    `Created: ${title}, ${formatCivilRange(startIso, endIso)} ` +
    `(${formatDurationMs(Date.parse(endIso) - Date.parse(startIso))}) on your calendar.`
  );
}

function sanitizedProviderError(error: string | null): string {
  return (error ?? "provider error").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ------------------------------------------------------------- confirm token

/** Crockford base32 (no I, L, O, U) — G-ref-shaped, human-typeable. */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CONFIRM_TOKEN_LENGTH = 5;

function mintConfirmToken(): string {
  const bytes = randomBytes(CONFIRM_TOKEN_LENGTH);
  let token = "";
  for (const byte of bytes) {
    token += CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length];
  }
  return token;
}

/**
 * Canonical owner-input normalization (Crockford): trim, uppercase, map
 * ambiguous glyphs I/L→1, O→0, U→V. null = not a confirm-token shape —
 * the orchestrator's resolver seam uses this before lookup.
 */
export function normalizeConfirmToken(raw: string): string | null {
  const t = raw
    .trim()
    .toUpperCase()
    .replaceAll("I", "1")
    .replaceAll("L", "1")
    .replaceAll("O", "0")
    .replaceAll("U", "V");
  return new RegExp(`^[0-9A-HJKMNP-TV-Z]{${CONFIRM_TOKEN_LENGTH}}$`).test(t) ? t : null;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Canonical JSON of the frozen action fields (sorted keys, written once). */
export function canonicalActionPayload(action: {
  readonly title: string;
  readonly startIso: string;
  readonly endIso: string;
  readonly tentative: boolean;
}): string {
  return JSON.stringify({
    action: CALENDAR_ACTION_TYPE,
    endIso: action.endIso,
    startIso: action.startIso,
    tentative: action.tentative,
    title: action.title,
  });
}

/** Payload-hash binding (contract §4): sha256(intentId + canonical). */
export function actionPayloadHash(intentId: string, action: {
  readonly title: string;
  readonly startIso: string;
  readonly endIso: string;
  readonly tentative: boolean;
}): string {
  return sha256Hex(`${intentId}:${canonicalActionPayload(action)}`);
}

// ------------------------------------------------------------- audits

function audit(
  db: SqlExecutor,
  action:
    | "imessage.action.proposed"
    | "imessage.action.denied"
    | "imessage.action.invalid"
    | "imessage.action.capped"
    | "imessage.action.rejected"
    | "imessage.action.expired"
    | "imessage.action.cancelled"
    | "imessage.action.confirmed"
    | "imessage.action.reconciled"
    | "imessage.action.unresolved",
  outputs: Record<string, unknown>,
  refs?: { readonly intentId?: string | null; readonly attemptId?: string | null },
): Promise<void> {
  return recordAudit(db, {
    actor: CALENDAR_ACTOR,
    action,
    reversible: true,
    intentId: refs?.intentId ?? null,
    attemptId: refs?.attemptId ?? null,
    outputsRef: JSON.stringify(outputs),
  });
}

// ------------------------------------------------------------- queries

function utcDayStart(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/** Proposals today (UTC day, per principal): calendar_create intents via runs. */
async function proposalsToday(db: SqlExecutor, principalId: string, now: Date): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS n
       FROM action_intents ai
       JOIN runs r ON r.id = ai.run_id
      WHERE r.principal_id = $1::uuid
        AND ai.payload->>'action' = $2
        AND ai.created_at >= $3::timestamptz`,
    [principalId, CALENDAR_ACTION_TYPE, utcDayStart(now)],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Dispatches today (UTC day, per principal): attempts via intents → runs. */
async function dispatchesToday(db: SqlExecutor, principalId: string, now: Date): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS n
       FROM action_attempts aa
       JOIN action_intents ai ON ai.id = aa.intent_id
       JOIN runs r ON r.id = ai.run_id
      WHERE r.principal_id = $1::uuid
        AND ai.payload->>'action' = $2
        AND aa.started_at >= $3::timestamptz`,
    [principalId, CALENDAR_ACTION_TYPE, utcDayStart(now)],
  );
  return Number(result.rows[0]?.n ?? 0);
}

interface IntentRow {
  readonly intent: ActionIntentRecord;
  readonly payload: {
    readonly action?: unknown;
    readonly title?: unknown;
    readonly startIso?: unknown;
    readonly endIso?: unknown;
    readonly tentative?: unknown;
    readonly provenance?: {
      readonly principalId?: unknown;
      readonly principalName?: unknown;
      readonly threadId?: unknown;
    } | null;
    readonly confirm?: {
      readonly tokenHash?: unknown;
      readonly payloadSha256?: unknown;
      readonly expiresAt?: unknown;
      readonly consumedAt?: unknown;
    } | null;
  };
}

function toIntentRow(row: Record<string, unknown>): IntentRow {
  const payload = (row.payload ?? {}) as IntentRow["payload"];
  return {
    intent: {
      id: String(row.id),
      runId: String(row.run_id),
      grantId: row.grant_id === null || row.grant_id === undefined ? null : String(row.grant_id),
      capability: String(row.capability),
      resource: String(row.resource),
      domainId: String(row.domain_id),
      payload,
      status: row.status as ActionIntentRecord["status"],
    },
    payload,
  };
}

const INTENT_COLUMNS = "id, run_id, grant_id, capability, resource, domain_id, payload, status";

async function intentByTokenHash(db: SqlExecutor, tokenHash: string): Promise<IntentRow | null> {
  const result = await db.query(
    `SELECT ${INTENT_COLUMNS} FROM action_intents
      WHERE payload->'confirm'->>'tokenHash' = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row === undefined ? null : toIntentRow(row);
}

async function personalDomainId(db: SqlExecutor): Promise<string> {
  const result = await db.query(`SELECT id FROM domains WHERE key = $1`, [
    CALENDAR_ACTION_DOMAIN_KEY,
  ]);
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("calendar-actions: personal domain is not seeded");
  }
  return String(id);
}

/** propose/confirm construct their own ActionService view of the chain. */
function nonDispatchingProvider(): ActionProvider {
  return {
    id: "google-calendar",
    dispatch(): Promise<never> {
      return Promise.reject(new Error("calendar-actions: this service view never dispatches"));
    },
  };
}

// ------------------------------------------------------------- propose

export interface ProposeCalendarActionInput {
  readonly principalId: string;
  readonly principalName: string;
  /** Already extracted by the route pass — this module never calls a model. */
  readonly title: string;
  readonly startIso: string;
  readonly endIso: string;
  readonly threadId?: string | null;
  readonly now: Date;
  readonly policy?: CalendarActionPolicy | null;
}

export type ProposeCalendarActionResult =
  | {
      readonly status: "proposed";
      readonly intentId: string;
      readonly confirmToken: string;
      readonly expiresAt: Date;
      /** sha256(intentId + payloadCanonical) — echo at confirm (binding). */
      readonly payloadHash: string;
      /** Human-readable summary + confirm/cancel ref for the reply (§8). */
      readonly render: string;
    }
  | {
      readonly status: "denied" | "invalid" | "capped";
      readonly reply: string;
      readonly violations?: readonly CalendarPayloadViolation[];
    };

/**
 * Propose one calendar event: policy gate → §4 validation (violation ⇒ NO
 * intent row) → proposal quota (flood bound) → run + M4B createIntent with
 * provenance refs → single-use Crockford-base32 confirm token bound to
 * sha256(intentId + payloadCanonical), TTL = policy.confirmTtlMinutes.
 */
export async function proposeCalendarAction(
  db: SqlExecutor,
  input: ProposeCalendarActionInput,
): Promise<ProposeCalendarActionResult> {
  const now = input.now;
  const policy = input.policy ?? DEFAULT_CALENDAR_ACTION_POLICY;

  // 1. Principal scoping — config-level standing eligibility (§2 layer 1).
  if (!calendarActionsEnabledFor(input.principalName, policy)) {
    await audit(db, "imessage.action.denied", {
      reason: "principal-not-action-enabled",
      principalId: input.principalId,
      principalName: input.principalName,
    });
    return { status: "denied", reply: CALENDAR_ACTION_DENIED_REPLY };
  }

  // 2. Payload constraints — deterministic gate before any intent exists.
  const violations = validateCalendarPayload(input, now);
  if (violations.length > 0) {
    await audit(db, "imessage.action.invalid", { violations });
    return { status: "invalid", reply: calendarInvalidReply(violations), violations };
  }

  // 3. Proposal quota — UTC-day flood bound per principal (§7).
  const proposed = await proposalsToday(db, input.principalId, now);
  if (proposed >= policy.maxProposalsPerDay) {
    await audit(db, "imessage.action.capped", {
      kind: "proposals",
      principalId: input.principalId,
      proposalsToday: proposed,
      cap: policy.maxProposalsPerDay,
    });
    return { status: "capped", reply: CALENDAR_ACTION_PROPOSAL_CAPPED_REPLY };
  }

  // 4. Run + intent via the UNCHANGED M4B chain (§3 step 3).
  const domainId = await personalDomainId(db);
  const run = await db.query(
    `INSERT INTO runs (kind, principal_id, status, intent, domain_id, started_at, ended_at, created_at, updated_at)
     VALUES ('harness', $1::uuid, 'completed', 'imessage calendar action proposal', $2::uuid,
             $3::timestamptz, $3::timestamptz, $3::timestamptz, $3::timestamptz)
     RETURNING id`,
    [input.principalId, domainId, now.toISOString()],
  );
  const runId = run.rows[0]?.id;
  if (runId === undefined) throw new Error("proposeCalendarAction: runs insert returned no row");

  const title = redactContent(input.title.replaceAll(/[\p{C}\p{Cf}]/gu, "")).trim();
  const svc = new ActionService(db, nonDispatchingProvider());
  const intent = await svc.createIntent({
    runId: String(runId),
    actionType: "external_side_effect",
    capability: CALENDAR_ACTION_CAPABILITY,
    resource: CALENDAR_RESOURCE,
    domainId,
    actor: `user:${input.principalName}`,
    payload: {
      action: CALENDAR_ACTION_TYPE,
      title,
      startIso: input.startIso,
      endIso: input.endIso,
      tentative: true, // ESCALATE-2 default
      calendar: "primary",
      provenance: {
        surface: CALENDAR_ACTION_SURFACE,
        principalId: input.principalId,
        principalName: input.principalName,
        threadId: input.threadId ?? null,
      },
    },
  });

  // 5. Confirm token: single-use, Crockford-base32, G-ref-shaped; only the
  //    sha256 is stored (payload.confirm), bound to the frozen payload hash.
  let confirmToken = mintConfirmToken();
  for (let redraw = 0; redraw < 3; redraw += 1) {
    const clash = await intentByTokenHash(db, sha256Hex(confirmToken));
    if (clash === null || clash.intent.status !== "proposed") break;
    confirmToken = mintConfirmToken();
  }
  const payloadHash = actionPayloadHash(intent.id, {
    title,
    startIso: input.startIso,
    endIso: input.endIso,
    tentative: true,
  });
  const expiresAt = new Date(now.getTime() + policy.confirmTtlMinutes * 60_000);
  await db.query(
    `UPDATE action_intents
        SET payload = jsonb_set(payload, '{confirm}', $2::jsonb), updated_at = now()
      WHERE id = $1`,
    [
      intent.id,
      JSON.stringify({
        tokenHash: sha256Hex(confirmToken),
        payloadSha256: payloadHash,
        expiresAt: expiresAt.toISOString(),
        consumedAt: null,
      }),
    ],
  );

  await audit(db, "imessage.action.proposed", {
    principalId: input.principalId,
    intentId: intent.id,
    threadId: input.threadId ?? null,
    // Title IS the action payload (not conversation content) — still masked.
    title: redactContent(title),
  });

  return {
    status: "proposed",
    intentId: intent.id,
    confirmToken,
    expiresAt,
    payloadHash,
    render: renderCalendarProposal(confirmToken, title, input.startIso, input.endIso),
  };
}

// ------------------------------------------------------------- confirm

export interface ConfirmCalendarActionInput {
  readonly principalId: string;
  readonly confirmToken: string;
  /** Optional echo of propose's payloadHash — divergence fails closed (§4). */
  readonly payloadHashEcho?: string;
  readonly now: Date;
  readonly policy?: CalendarActionPolicy | null;
  /** The write ActionProvider — dispatch rides M4B startAttempt. */
  readonly provider: ActionProvider;
}

export type ConfirmCalendarStatus =
  | "succeeded"
  | "failed"
  | "unknown"
  | "denied"
  | "already-used"
  | "cancelled"
  | "expired"
  | "payload-mismatch"
  | "capped"
  | "grant-denied";

export interface ConfirmCalendarActionResult {
  readonly status: ConfirmCalendarStatus;
  /** Deterministic honest reply for the orchestrator (contract §8). */
  readonly reply: string;
  readonly intentId: string | null;
  readonly attemptId: string | null;
  readonly providerRef: string | null;
}

function confirmResult(
  status: ConfirmCalendarStatus,
  reply: string,
  refs: { intentId?: string | null; attemptId?: string | null; providerRef?: string | null } = {},
): ConfirmCalendarActionResult {
  return {
    status,
    reply,
    intentId: refs.intentId ?? null,
    attemptId: refs.attemptId ?? null,
    providerRef: refs.providerRef ?? null,
  };
}

function replyForAttempt(attempt: ActionAttemptRecord, row: IntentRow): ConfirmCalendarActionResult {
  const title = typeof row.payload.title === "string" ? row.payload.title : "";
  const startIso = typeof row.payload.startIso === "string" ? row.payload.startIso : "";
  const endIso = typeof row.payload.endIso === "string" ? row.payload.endIso : "";
  switch (attempt.outcome) {
    case "succeeded":
      return confirmResult("succeeded", calendarSucceededReply(title, startIso, endIso), {
        intentId: row.intent.id,
        attemptId: attempt.id,
        providerRef: attempt.providerRef,
      });
    case "failed":
      return confirmResult(
        "failed",
        `Couldn't create it: ${sanitizedProviderError(attempt.error)}. Nothing was changed.`,
        { intentId: row.intent.id, attemptId: attempt.id },
      );
    default:
      // unknown / still-executing — NEVER rendered as success (R10).
      return confirmResult("unknown", CALENDAR_UNKNOWN_REPLY, {
        intentId: row.intent.id,
        attemptId: attempt.id,
      });
  }
}

/**
 * THE critical security function (contract §4): token lookup (single
 * unresolved unexpired intent) → principal match (wrong principal fails
 * closed + audit) → payload-hash binding → single-use consumption (the
 * atomic proposed→approved transition — a raced second confirm loses) →
 * prepare → mint act:<provider> grant (TTL ~5min) → M4B startAttempt →
 * honest reply for the observed outcome.
 */
export async function confirmCalendarAction(
  db: SqlExecutor,
  input: ConfirmCalendarActionInput,
): Promise<ConfirmCalendarActionResult> {
  const now = input.now;
  const policy = input.policy ?? DEFAULT_CALENDAR_ACTION_POLICY;

  // 1. Token shape + lookup by sha256(token) — exactly one intent.
  const token = normalizeConfirmToken(input.confirmToken);
  if (token === null) {
    await audit(db, "imessage.action.rejected", { reason: "malformed-token" });
    return confirmResult("denied", CALENDAR_CONFIRM_USED_REPLY);
  }
  const row = await intentByTokenHash(db, sha256Hex(token));
  if (row === null) {
    await audit(db, "imessage.action.rejected", { reason: "unknown-token" });
    return confirmResult("denied", CALENDAR_CONFIRM_USED_REPLY);
  }

  // 2. Principal match — fail closed + audit (adversary #5).
  const ownerPrincipalId = row.payload.provenance?.principalId;
  if (typeof ownerPrincipalId !== "string" || ownerPrincipalId !== input.principalId) {
    await audit(db, "imessage.action.rejected", {
      reason: "wrong-principal",
      intentId: row.intent.id,
      requestingPrincipalId: input.principalId,
    }, { intentId: row.intent.id });
    // Adversary A3: same reply as unknown-token — a wrong-principal
    // probe must not reveal that a live owner proposal exists.
    return confirmResult("denied", CALENDAR_CONFIRM_USED_REPLY, { intentId: row.intent.id });
  }

  // 3. Unresolved: anything past `proposed` is a replay / terminal state.
  if (row.intent.status !== "proposed") {
    const reply =
      row.intent.status === "cancelled" ? CALENDAR_CANCELLED_REPLY : CALENDAR_CONFIRM_USED_REPLY;
    await audit(db, "imessage.action.rejected", {
      reason: "already-consumed",
      intentId: row.intent.id,
      status: row.intent.status,
    }, { intentId: row.intent.id });
    return confirmResult(
      row.intent.status === "cancelled" ? "cancelled" : "already-used",
      reply,
      { intentId: row.intent.id },
    );
  }

  // 4. TTL — expiry cancels the intent with an honest reply (§4).
  const expiresAt = Date.parse(
    typeof row.payload.confirm?.expiresAt === "string" ? row.payload.confirm.expiresAt : "",
  );
  if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) {
    const svc = new ActionService(db, nonDispatchingProvider());
    const actor = actorFor(row);
    try {
      await svc.cancelIntent({ intentId: row.intent.id, actor });
    } catch {
      // Raced (cancel/confirm); the honest expired reply holds either way.
    }
    await audit(db, "imessage.action.expired", { intentId: row.intent.id }, { intentId: row.intent.id });
    return confirmResult("expired", CALENDAR_CONFIRM_EXPIRED_REPLY, { intentId: row.intent.id });
  }

  // 5. Payload-hash binding — swap between render and confirm fails closed.
  const storedHash = row.payload.confirm?.payloadSha256;
  const currentFields = {
    title: row.payload.title,
    startIso: row.payload.startIso,
    endIso: row.payload.endIso,
    tentative: row.payload.tentative,
  };
  const wellFormed =
    typeof storedHash === "string" &&
    typeof currentFields.title === "string" &&
    typeof currentFields.startIso === "string" &&
    typeof currentFields.endIso === "string" &&
    typeof currentFields.tentative === "boolean";
  const currentHash = wellFormed
    ? actionPayloadHash(row.intent.id, currentFields as {
        title: string;
        startIso: string;
        endIso: string;
        tentative: boolean;
      })
    : null;
  if (
    !wellFormed ||
    currentHash !== storedHash ||
    (input.payloadHashEcho !== undefined && input.payloadHashEcho !== storedHash)
  ) {
    await audit(db, "imessage.action.rejected", {
      reason: "payload-mismatch",
      intentId: row.intent.id,
    }, { intentId: row.intent.id });
    return confirmResult("payload-mismatch", CALENDAR_CONFIRM_MISMATCH_REPLY, {
      intentId: row.intent.id,
    });
  }

  // 6. Dispatch quota — UTC-day flood bound; confirmation is never bypassed.
  const dispatched = await dispatchesToday(db, input.principalId, now);
  if (dispatched >= policy.maxDispatchesPerDay) {
    await audit(db, "imessage.action.capped", {
      kind: "dispatches",
      principalId: input.principalId,
      dispatchesToday: dispatched,
      cap: policy.maxDispatchesPerDay,
    }, { intentId: row.intent.id });
    return confirmResult("capped", CALENDAR_ACTION_DISPATCH_CAPPED_REPLY, {
      intentId: row.intent.id,
    });
  }

  // 7. Single-use consumption: the atomic proposed→approved transition IS
  //    the consumption (WHERE status='proposed' — race-safe); consumed_at
  //    is explicit bookkeeping on top.
  const svc = new ActionService(db, input.provider);
  const actor = actorFor(row);
  try {
    await svc.approveIntent({ intentId: row.intent.id, actor });
  } catch (err) {
    if (err instanceof InvalidIntentTransitionError) {
      await audit(db, "imessage.action.rejected", {
        reason: "already-consumed",
        intentId: row.intent.id,
      }, { intentId: row.intent.id });
      return confirmResult("already-used", CALENDAR_CONFIRM_USED_REPLY, {
        intentId: row.intent.id,
      });
    }
    throw err;
  }
  await db.query(
    `UPDATE action_intents
        SET payload = jsonb_set(payload, '{confirm,consumedAt}', to_jsonb($2::text)), updated_at = now()
      WHERE id = $1 AND status = 'approved'`,
    [row.intent.id, now.toISOString()],
  );

  // 8. Prepare + mint the per-action capability grant (§2 layer 2).
  await svc.prepareIntent({ intentId: row.intent.id, actor });
  const grant = await issueGrant(db, {
    principalId: input.principalId,
    runId: row.intent.runId,
    capability: `act:${input.provider.id}`,
    resource: row.intent.resource,
    domainId: row.intent.domainId,
    ttlMs: CALENDAR_GRANT_TTL_MS,
    now: () => now.getTime(),
  });

  // 9. Dispatch via M4B — grant verified BEFORE any attempt row or effect.
  let attempt: ActionAttemptRecord;
  try {
    attempt = await svc.startAttempt({
      intentId: row.intent.id,
      actor,
      grantToken: grant.token,
      principalId: input.principalId,
    });
  } catch (err) {
    if (err instanceof GrantDeniedError) {
      // Adversary #8: the grant expired pre-dispatch — nothing happened.
      await audit(db, "imessage.action.rejected", {
        reason: "grant-denied",
        intentId: row.intent.id,
        grantReason: err.reason,
      }, { intentId: row.intent.id });
      return confirmResult("grant-denied", CALENDAR_GRANT_EXPIRED_REPLY, {
        intentId: row.intent.id,
      });
    }
    throw err;
  }

  await audit(db, "imessage.action.confirmed", {
    principalId: input.principalId,
    intentId: row.intent.id,
    attemptId: attempt.id,
    outcome: attempt.outcome,
  }, { intentId: row.intent.id, attemptId: attempt.id });

  return replyForAttempt(attempt, row);
}

function actorFor(row: IntentRow): string {
  const name = row.payload.provenance?.principalName;
  return typeof name === "string" && name.length > 0 ? `user:${name}` : "user:unknown";
}

// ------------------------------------------------------------- cancel

export interface CancelCalendarActionInput {
  readonly principalId: string;
  readonly confirmToken: string;
  readonly now: Date;
  readonly policy?: CalendarActionPolicy | null;
}

export interface CancelCalendarActionResult {
  readonly status: "cancelled" | "already-used" | "denied";
  readonly reply: string;
  readonly intentId: string | null;
}

/** Owner `cancel <ref>` — cancels the still-proposed intent (§8). */
export async function cancelCalendarAction(
  db: SqlExecutor,
  input: CancelCalendarActionInput,
): Promise<CancelCalendarActionResult> {
  const token = normalizeConfirmToken(input.confirmToken);
  if (token === null) {
    return { status: "denied", reply: CALENDAR_CONFIRM_USED_REPLY, intentId: null };
  }
  const row = await intentByTokenHash(db, sha256Hex(token));
  if (row === null) {
    return { status: "denied", reply: CALENDAR_CONFIRM_USED_REPLY, intentId: null };
  }
  const ownerPrincipalId = row.payload.provenance?.principalId;
  if (typeof ownerPrincipalId !== "string" || ownerPrincipalId !== input.principalId) {
    await audit(db, "imessage.action.rejected", {
      reason: "wrong-principal",
      intentId: row.intent.id,
      requestingPrincipalId: input.principalId,
    }, { intentId: row.intent.id });
    return { status: "denied", reply: CALENDAR_ACTION_DENIED_REPLY, intentId: row.intent.id };
  }
  if (row.intent.status !== "proposed") {
    const reply =
      row.intent.status === "cancelled" ? CALENDAR_CANCELLED_REPLY : CALENDAR_CONFIRM_USED_REPLY;
    return {
      status: row.intent.status === "cancelled" ? "cancelled" : "already-used",
      reply,
      intentId: row.intent.id,
    };
  }
  const svc = new ActionService(db, nonDispatchingProvider());
  await svc.cancelIntent({ intentId: row.intent.id, actor: actorFor(row) });
  await audit(db, "imessage.action.cancelled", { intentId: row.intent.id }, { intentId: row.intent.id });
  return { status: "cancelled", reply: CALENDAR_CANCELLED_REPLY, intentId: row.intent.id };
}

// ------------------------------------------------------------- reconcile

/**
 * Provider read-back seam for reconciliation (contract §3 step 9): the
 * write provider resolves an idempotency key to exactly one event. The
 * google-calendar-write provider implements this via the
 * `extendedProperties.private.idempotencyKey` stamp.
 */
export interface CalendarReconcileProvider {
  findEventByIdempotencyKey(idempotencyKey: string): Promise<{ readonly eventId: string } | null>;
}

export interface ReconcileCalendarActionInput {
  readonly intentId: string;
  readonly provider: CalendarReconcileProvider;
  readonly now?: Date;
  readonly actor?: string;
}

export type ReconcileCalendarActionResult = {
  readonly status: "reconciled" | "failed" | "noop";
  readonly reply: string;
  readonly attemptId: string | null;
  readonly providerRef: string | null;
};

/**
 * Resolve an attempt whose outcome is `unknown` by reading the effect back
 * (call after the calendar sensor's sync window). Found → M4B
 * unknown→reconciled naming the providerRef. Not found → the attempt STAYS
 * `unknown` (R10: unknown never silently becomes failed) and the reply
 * treats it as not-created. Terminal attempts are never touched.
 */
export async function reconcileCalendarAction(
  db: SqlExecutor,
  input: ReconcileCalendarActionInput,
): Promise<ReconcileCalendarActionResult> {
  const svc = new ActionService(db, nonDispatchingProvider());
  let attempts: readonly ActionAttemptRecord[];
  try {
    attempts = await svc.listAttempts(input.intentId);
  } catch (err) {
    if (err instanceof IntentNotFoundError) {
      return { status: "noop", reply: "Nothing to reconcile.", attemptId: null, providerRef: null };
    }
    throw err;
  }
  const unknown = [...attempts].reverse().find((a) => a.outcome === "unknown");
  if (unknown === undefined) {
    return { status: "noop", reply: "Nothing to reconcile.", attemptId: null, providerRef: null };
  }
  if (unknown.idempotencyKey === null) {
    return { status: "noop", reply: "Nothing to reconcile.", attemptId: unknown.id, providerRef: null };
  }

  const found = await input.provider.findEventByIdempotencyKey(unknown.idempotencyKey);
  if (found === null) {
    // Read-back finds nothing: attempt stays `unknown` (never silently
    // failed); the owner-facing state is honest not-created (§8 last row).
    await audit(db, "imessage.action.unresolved", {
      intentId: input.intentId,
      attemptId: unknown.id,
      idempotencyKey: unknown.idempotencyKey,
    }, { intentId: input.intentId, attemptId: unknown.id });
    return {
      status: "failed",
      reply: CALENDAR_RECONCILE_NOT_CREATED_REPLY,
      attemptId: unknown.id,
      providerRef: null,
    };
  }

  const reconciled = await svc.reconcileAttempt({
    intentId: input.intentId,
    attemptId: unknown.id,
    providerRef: found.eventId,
    actor: input.actor ?? CALENDAR_ACTOR,
  });

  // Best-effort civil rendering from the intent payload (replies are
  // content-bounded; title is the action payload).
  const intentRow = await db.query(
    `SELECT payload FROM action_intents WHERE id = $1`,
    [input.intentId],
  );
  const payload = (intentRow.rows[0]?.payload ?? {}) as IntentRow["payload"];
  const title = typeof payload.title === "string" ? payload.title : "the event";
  const startIso = typeof payload.startIso === "string" ? payload.startIso : null;
  await audit(db, "imessage.action.reconciled", {
    intentId: input.intentId,
    attemptId: reconciled.id,
    providerRef: reconciled.providerRef,
  }, { intentId: input.intentId, attemptId: reconciled.id });

  return {
    status: "reconciled",
    reply:
      startIso === null
        ? `Confirmed created: ${title}.`
        : `Confirmed created: ${title} ${formatCivilStart(startIso)}.`,
    attemptId: reconciled.id,
    providerRef: reconciled.providerRef,
  };
}
