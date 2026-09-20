// iMessage conversation handler (gateway multi-principal Lane P —
// docs/plans/ig-multiprincipal-contracts.md "Conversation"; imessage-gateway
// plan §3 trust ladder CONVERSATION mode, answer-only A–C).
//
// One inbound turn from a PAIRED principal holding an unexpired
// `imessage:converse` grant: check the grant (fail closed), check the
// per-principal × per-surface budget from policy.yaml `gateway.principals`
// (absent principal → DENY, fail closed; windows over model_calls
// principal_id+surface), then ONE model call through the existing
// callModel provider+egress path, and a kind=reply notification addressed
// to her canonical handle — the §4 reply conjunction approves exactly that
// shape at creation.
//
// The system prompt is FIXED: a generic assistant with no world-model, no
// tools, no commitments/calendar/finance access, nothing principal-specific
// beyond the greeting name. Her text is the user turn; nothing else.
// Reply text is capped to the 1500-char edge render rule AT CREATION.
// Message CONTENT is never persisted — no table here stores it.

import type { ModelProvider } from "@jehad/adapters";
import type { ModelEgressPolicyRegistry } from "../egress/index.js";
import { callModel, type ModelCallDb } from "../model/call-model.js";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import {
  loadPolicyFile,
  parsePolicyV1,
  type GatewayPrincipalPolicy,
  type PolicyV1,
} from "../policy/ceiling.js";
import { createNotification } from "../notifications/service.js";
import { canonicalizeHandle } from "./pairing.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

/** The conversational capability (owner-issued grant; TTL like send_channel). */
export const CONVERSE_CAPABILITY = "imessage:converse";
export const CONVERSE_RESOURCE = "imessage";
/** model_calls.surface tag for gateway conversation turns. */
export const CONVERSATION_SURFACE = "imessage";
export const CONVERSATION_PROMPT_VERSION = "imessage-converse-v1";

/** The edge render cap (infra/edge §4), applied to reply content at creation. */
export const REPLY_CHAR_LIMIT = 1500;
const TRUNCATION_MARKER = "…[truncated]";

const GATEWAY_SERVICE_PRINCIPAL = "service/imessage-gateway";
const CONVERSE_DOMAIN_KEY = "personal";

export type ConverseDenialReason =
  | "no-converse-grant"
  | "principal-not-configured"
  | "over-requests-hour"
  | "over-cost-day"
  | "model-error";

export interface ConverseOutcome {
  readonly replied: boolean;
  readonly reason?: ConverseDenialReason;
  readonly notificationId?: string;
}

export interface InboundConversationMessage {
  readonly principalId: string;
  readonly handle: string;
  readonly text: string;
}

export interface ConversationDeps {
  readonly db: ModelCallDb;
  /** The RAW provider; callModel applies the egress gate itself. */
  readonly provider: ModelProvider;
  readonly registry: ModelEgressPolicyRegistry;
  /**
   * Principal-name → budget config. Absent name → deny (fail closed).
   * Defaults to the repo-root policy.yaml `gateway.principals` mapping.
   */
  readonly principalPolicy?: (principalName: string) => GatewayPrincipalPolicy | null;
  readonly now?: () => Date;
}

/**
 * FIXED system prompt — generic assistant only. No world-model, no tools,
 * no commitments/calendar/finance access, no personal data of ANY
 * principal; the only principal-specific token is the greeting name.
 */
export function buildConversationPrompt(principalName: string, model: string, text: string): string {
  return [
    `You are a helpful, concise assistant chatting over iMessage with ${principalName}.`,
    `You are running as the model "${model}" via OpenRouter on a private message gateway — when asked what model you are, answer honestly and specifically with that model id.`,
    "You have no access to any external systems, tools, calendars, files, or accounts, and you cannot perform actions — answer from this conversation alone.",
    "You are text-only: you cannot see images or attachments; if one seems to be referenced, say so plainly.",
    "Keep each reply under 1500 characters.",
    "",
    text,
  ].join("\n");
}

/** Attachment-only inbound (U+FFFC placeholders / whitespace) — answered
 *  deterministically, no model call, no budget consumption. */
const ATTACHMENT_ONLY_REPLY =
  "I can't see images or attachments yet — text only for now. (Attachment support is on the roadmap.)";

export function isTextOnlyAttachment(text: string): boolean {
  return text.replace(/\uFFFC/g, "").trim().length === 0;
}

/** Reply content capped to the edge render rule at creation (same marker). */
export function capReplyText(text: string): string {
  if (text.length <= REPLY_CHAR_LIMIT) return text;
  return text.slice(0, REPLY_CHAR_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

async function converseGrantActive(db: SqlExecutor, principalId: string, now: Date): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM capability_grants
      WHERE principal_id = $1::uuid AND capability = $2 AND resource = $3
        AND revoked_at IS NULL AND expires_at > $4::timestamptz
      LIMIT 1`,
    [principalId, CONVERSE_CAPABILITY, CONVERSE_RESOURCE, now.toISOString()],
  );
  return result.rows[0] !== undefined;
}

/** Rolling-hour request count + UTC-day spend for (principal, surface). */
export async function conversationUsage(
  db: SqlExecutor,
  principalId: string,
  opts: { now?: () => Date } = {},
): Promise<{ requestsLastHour: number; costToday: number }> {
  const now = opts.now?.() ?? new Date();
  const hourStart = new Date(now.getTime() - 60 * 60_000).toISOString();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const [requests, cost] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS n FROM model_calls
        WHERE principal_id = $1::uuid AND surface = $2 AND created_at >= $3::timestamptz`,
      [principalId, CONVERSATION_SURFACE, hourStart],
    ),
    db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM model_calls
        WHERE principal_id = $1::uuid AND surface = $2 AND created_at >= $3::timestamptz`,
      [principalId, CONVERSATION_SURFACE, dayStart],
    ),
  ]);
  return {
    requestsLastHour: Number(requests.rows[0]?.n ?? 0),
    costToday: Number(cost.rows[0]?.spent ?? 0),
  };
}

function audit(db: SqlExecutor, actor: string, action: string, outputs: Record<string, unknown>): Promise<void> {
  return recordAudit(db, {
    actor,
    action,
    reversible: true,
    outputsRef: JSON.stringify(outputs),
  });
}

/**
 * Handles one authenticated inbound conversation turn. Never throws — every
 * failure is a silent drop with an audit row (no content, handle + reason
 * only). Budget denials happen PRE-dispatch: no model_call row exists.
 */
export async function handleInbound(
  deps: ConversationDeps,
  input: InboundConversationMessage,
): Promise<ConverseOutcome> {
  const db = deps.db;
  const now = deps.now?.() ?? new Date();
  const handle = canonicalizeHandle(input.handle);

  const principal = await db.query(
    "SELECT name FROM principals WHERE id = $1::uuid",
    [input.principalId],
  );
  const principalName = principal.rows[0]?.name;
  if (principalName === undefined) {
    await audit(db, "system:imessage-gateway", "imessage.converse.dropped", {
      reason: "unknown-principal",
      principalId: input.principalId,
      handle,
    });
    return { replied: false, reason: "no-converse-grant" };
  }
  const actor = "system:imessage-gateway";

  // 1. Grant (fail closed) — identity got the message here; the grant says
  //    it may converse.
  if (!(await converseGrantActive(db, input.principalId, now))) {
    await audit(db, actor, "imessage.converse.dropped", {
      reason: "no-converse-grant",
      principalId: input.principalId,
      handle,
    });
    return { replied: false, reason: "no-converse-grant" };
  }

  // 2. Budget (policy.yaml gateway.principals.<name>; absent → deny).
  // Adversary F2: the check-then-dispatch pair is serialized per principal
  // with a session advisory lock held across the whole turn, so concurrent
  // inbound messages cannot collectively overshoot the caps.
  const policy = deps.principalPolicy?.(String(principalName)) ?? null;
  if (policy === null) {
    await audit(db, actor, "imessage.converse.denied", {
      reason: "principal-not-configured",
      principalId: input.principalId,
      handle,
    });
    return { replied: false, reason: "principal-not-configured" };
  }
  return withPerPrincipalTurnLock(db, input.principalId, () =>
    converseTurn(deps, input, { handle, actor, principalName: String(principalName), policy, now }),
  );
}

/** Serialize a principal's turns (budget check → model dispatch → reply)
 *  under pg_advisory_lock keyed on the principal id. Pool-aware: prefers a
 *  dedicated client; falls back to the executor itself. */
async function withPerPrincipalTurnLock<T>(
  db: ConversationDeps["db"],
  principalId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockKey = `gateway:turn:${principalId}`;
  const maybePool = db as unknown as {
    connect?: () => Promise<{ query: ConversationDeps["db"]["query"] } & { release?: () => void }>;
  };
  if (typeof maybePool.connect === "function") {
    const client = await maybePool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
      client.release?.();
    }
  }
  await db.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
  try {
    return await fn();
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
  }
}

async function converseTurn(
  deps: ConversationDeps,
  input: InboundConversationMessage,
  ctx: { handle: string; actor: string; principalName: string; policy: { model: string; requestsPerHour: number; costPerDay: number }; now: Date },
): Promise<ConverseOutcome> {
  const db = deps.db;
  const { handle, actor, policy, now, principalName } = ctx;
  if (isTextOnlyAttachment(input.text)) {
    const createdBy = await resolveGatewayServicePrincipal(db);
    const notification = await createNotification(
      db,
      {
        kind: "reply",
        title: "Reply",
        payload: { content: ATTACHMENT_ONLY_REPLY, recipient: handle },
        recipient: handle,
        sourceType: "run",
        sourceId: null,
        createdBy,
        surface: CONVERSATION_SURFACE,
        requestingPrincipalId: input.principalId,
        conversationPrincipalId: input.principalId,
        thirdPartyRecipient: false,
      },
      { actor, now: () => now },
    );
    await audit(db, actor, "imessage.converse.replied", {
      principalId: input.principalId,
      handle,
      notificationId: notification.id,
      deterministic: "attachment-only",
    });
    return { replied: true, notificationId: notification.id };
  }
  const usage = await conversationUsage(db, input.principalId, { now: () => now });
  if (usage.requestsLastHour >= policy.requestsPerHour) {
    await audit(db, actor, "imessage.converse.denied", {
      reason: "over-requests-hour",
      principalId: input.principalId,
      handle,
      requestsLastHour: usage.requestsLastHour,
      cap: policy.requestsPerHour,
    });
    return { replied: false, reason: "over-requests-hour" };
  }
  if (usage.costToday >= policy.costPerDay) {
    await audit(db, actor, "imessage.converse.denied", {
      reason: "over-cost-day",
      principalId: input.principalId,
      handle,
      costToday: usage.costToday,
      cap: policy.costPerDay,
    });
    return { replied: false, reason: "over-cost-day" };
  }

  // 3+4. One model call through the existing provider + egress path; the
  // ledger row carries principal_id + surface. callModel requires a run —
  // one harness run per inbound turn (same pattern as briefs artifacts).
  const domain = await db.query("SELECT id FROM domains WHERE key = $1", [CONVERSE_DOMAIN_KEY]);
  const domainId = domain.rows[0]?.id;
  if (domainId === undefined) {
    throw new Error("handleInbound: personal domain is not seeded");
  }
  const run = await db.query(
    `INSERT INTO runs (kind, principal_id, status, intent, domain_id, started_at, ended_at, created_at, updated_at)
     VALUES ('harness', $1::uuid, 'completed', 'imessage conversation turn', $2::uuid,
             $3::timestamptz, $3::timestamptz, $3::timestamptz, $3::timestamptz)
     RETURNING id`,
    [input.principalId, domainId, now.toISOString()],
  );
  const runRow = run.rows[0];
  if (runRow === undefined) throw new Error("handleInbound: runs insert returned no row");
  const runId = String(runRow.id);

  let replyText: string;
  let costUsd: number;
  try {
    const outcome = await callModel(
      { db, provider: deps.provider, registry: deps.registry },
      {
        domainId: CONVERSE_DOMAIN_KEY,
        sensitivity: "normal",
        provider: deps.provider.id,
        model: policy.model,
        prompt: buildConversationPrompt(String(principalName), policy.model, input.text),
        runId,
        promptVersion: CONVERSATION_PROMPT_VERSION,
        principalId: input.principalId,
        surface: CONVERSATION_SURFACE,
      },
    );
    replyText = capReplyText(outcome.result.text);
    costUsd = outcome.costUsd;
  } catch (err) {
    // callModel throws only auditable failures (budget/egress/provider) —
    // the conversation drops; her bubble stays silent. No content in audit.
    await audit(db, actor, "imessage.converse.error", {
      principalId: input.principalId,
      handle,
      error: err instanceof Error ? err.name : "unknown",
    });
    return { replied: false, reason: "model-error" };
  }

  // 5. Reply notification — the §4 conjunction shape: recipient = her
  // canonical handle (row column + payload), requesting/conversation
  // principal = her, third_party=false, surface imessage.
  const createdBy = await resolveGatewayServicePrincipal(db);
  const notification = await createNotification(
    db,
    {
      kind: "reply",
      title: "Reply",
      payload: { content: replyText, recipient: handle },
      recipient: handle,
      sourceType: "run",
      sourceId: runId,
      createdBy,
      surface: CONVERSATION_SURFACE,
      requestingPrincipalId: input.principalId,
      conversationPrincipalId: input.principalId,
      thirdPartyRecipient: false,
    },
    { actor, now: () => now },
  );

  await audit(db, actor, "imessage.converse.replied", {
    principalId: input.principalId,
    handle,
    notificationId: notification.id,
    runId,
    costUsd,
    model: policy.model,
  });
  return { replied: true, notificationId: notification.id };
}

async function resolveGatewayServicePrincipal(db: SqlExecutor): Promise<string> {
  const upsert = await db.query(
    `WITH ins AS (
       INSERT INTO principals (type, name) VALUES ('service', $1)
       ON CONFLICT (name) DO NOTHING
       RETURNING id
     )
     SELECT id FROM ins
     UNION ALL
     SELECT id FROM principals WHERE name = $1
     LIMIT 1`,
    [GATEWAY_SERVICE_PRINCIPAL],
  );
  const id = upsert.rows[0]?.id;
  if (id === undefined) {
    throw new Error("resolveGatewayServicePrincipal: could not resolve the gateway service principal");
  }
  return String(id);
}

// ------------------------------------------------------------- policy loader

/** Repo-root policy.yaml — same depth from src/ and dist/. */
function defaultPolicyYamlPath(): string {
  return path.resolve(fileURLToPath(new URL("../../../../policy.yaml", import.meta.url)));
}

function principalPolicyFromPolicy(policy: PolicyV1 | null | undefined) {
  return (principalName: string): GatewayPrincipalPolicy | null =>
    policy?.gateway?.principals[principalName] ?? null;
}

export function gatewayPrincipalsFromPolicyV1(
  policy: PolicyV1 | null | undefined,
): Readonly<Record<string, GatewayPrincipalPolicy>> {
  return policy?.gateway?.principals ?? {};
}

let defaultPrincipalPolicy: Promise<((name: string) => GatewayPrincipalPolicy | null)> | null = null;

/**
 * The conversation budget source: repo-root policy.yaml
 * `gateway.principals`, read once per process (an explicit `file` always
 * re-reads; same caching discipline as loadNotificationsConfig).
 */
export async function loadConversationPrincipalPolicy(
  file?: string,
): Promise<(principalName: string) => GatewayPrincipalPolicy | null> {
  if (file !== undefined) {
    return principalPolicyFromPolicy(await loadPolicyFile(file));
  }
  defaultPrincipalPolicy ??= (async () => {
    try {
      return principalPolicyFromPolicy(parsePolicyV1(await readFile(defaultPolicyYamlPath(), "utf8")));
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return principalPolicyFromPolicy(null);
      }
      throw err;
    }
  })();
  return defaultPrincipalPolicy;
}
