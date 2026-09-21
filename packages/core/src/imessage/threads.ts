// Phase D — bounded conversational working memory (ADR-0014, contract
// docs/plans/ig-phase-d-contracts.md). Jehad OS owns conversation state;
// a future harness may only curate via WorkingContextProvider.
//
// Memory horizons: CURRENT (this turn) · WORKING (this module: 72h active
// context, 7d raw retention, deterministic deletion) · SEMANTIC (only via
// the explicit promotion pipeline — conversation content NEVER auto-
// promotes, structurally: nothing here writes memory_candidates).
//
// Isolation is structural: one active thread per (principal, surface) via
// partial unique index; a storage trigger rejects cross-principal message
// inserts; every query is principal-scoped at the repository layer.

import { randomUUID } from "node:crypto";
import type { QueryExecutor } from "../queries/executor.js";
import { parseDateInput } from "../queries/executor.js";
import { redactContent } from "./redact.js";

/** Active-context horizon (owner decision 2026-09-20). */
export const ACTIVE_CONTEXT_TTL_MS = 72 * 60 * 60_000;
/** Raw-content retention horizon — deleted at/after this, rolling. */
export const RAW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Context builder starting policy (contract §3/§5; tunable in dogfooding). */
export const CONTEXT_MAX_MESSAGES = 20;
export const CONTEXT_TOKEN_BUDGET = 6000;

export type InteractionTrustClass =
  | "authenticated_user_intent"
  | "assistant_output"
  | "tool_output"
  | "retrieved_external_data"
  | "system_generated";

export interface ThreadRow {
  readonly id: string;
  readonly principalId: string;
  readonly surface: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly activeContextExpiresAt: string;
  readonly rawRetentionExpiresAt: string;
}

export interface AppendMessageInput {
  readonly threadId: string;
  readonly principalId: string;
  readonly surface: string;
  readonly direction: "inbound" | "outbound";
  readonly trustClass: InteractionTrustClass;
  readonly content: string;
  readonly receivedAt: Date;
  readonly sourceRef?: string | null;
  readonly threadState?: TurnArtifacts | null;
}

export interface ContextMessage {
  readonly direction: "inbound" | "outbound";
  readonly trustClass: InteractionTrustClass;
  readonly content: string;
  readonly receivedAt: string;
  readonly tokenEstimate: number;
}

export interface WorkingContext {
  readonly threadId: string;
  readonly messages: readonly ContextMessage[];
  readonly tokenEstimate: number;
  readonly truncated: boolean;
  readonly oldestAt: string | null;
}

/** Deterministic token estimate — ceil(chars/4); never provider counts. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Resolve the principal's active thread for a surface, turning over an
 * idle one (§11: principal + surface → current active thread; idle past
 * the 72h context TTL or explicit reset → close + create new). The
 * partial unique index makes "at most one active" structural; the SELECT
 * ... FOR UPDATE inside the turn lock serializes turnover races.
 */
export async function resolveActiveThread(
  db: QueryExecutor,
  opts: {
    readonly principalId: string;
    readonly surface: string;
    readonly now: Date;
    /** Force turnover (explicit /new) even when the thread is fresh. */
    readonly forceReset?: boolean;
  },
): Promise<ThreadRow> {
  const existing = await db.query(
    `SELECT id, principal_id, surface, status, created_at, last_activity_at,
            active_context_expires_at, raw_retention_expires_at
       FROM interaction_threads
      WHERE principal_id = $1::uuid AND surface = $2 AND status = 'active'
      FOR UPDATE`,
    [opts.principalId, opts.surface],
  );
  const row = existing.rows[0] as Record<string, unknown> | undefined;
  if (row !== undefined && !opts.forceReset) {
    const idleExpired =
      new Date(String(row.active_context_expires_at)).getTime() <= opts.now.getTime();
    if (!idleExpired) return toThreadRow(row);
  }
  if (row !== undefined) {
    await db.query(
      `UPDATE interaction_threads SET status = 'closed' WHERE id = $1::uuid`,
      [row.id],
    );
  }
  const insert = await db.query(
    `INSERT INTO interaction_threads
       (id, principal_id, surface, status, created_at, last_activity_at,
        active_context_expires_at, raw_retention_expires_at)
     VALUES ($1, $2::uuid, $3, 'active', $4, $4, $5, $6)
     RETURNING id, principal_id, surface, status, created_at, last_activity_at,
               active_context_expires_at, raw_retention_expires_at`,
    [
      randomUUID(),
      opts.principalId,
      opts.surface,
      opts.now.toISOString(),
      new Date(opts.now.getTime() + ACTIVE_CONTEXT_TTL_MS).toISOString(),
      new Date(opts.now.getTime() + RAW_RETENTION_MS).toISOString(),
    ],
  );
  return toThreadRow(insert.rows[0] as Record<string, unknown>);
}

/** Touch the thread's activity horizons (called on each append). */
async function touchThread(
  db: QueryExecutor,
  threadId: string,
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE interaction_threads
        SET last_activity_at = $2,
            active_context_expires_at = $3,
            raw_retention_expires_at = $4
      WHERE id = $1::uuid`,
    [
      threadId,
      now.toISOString(),
      new Date(now.getTime() + ACTIVE_CONTEXT_TTL_MS).toISOString(),
      new Date(now.getTime() + RAW_RETENTION_MS).toISOString(),
    ],
  );
}

/**
 * Append one message to a thread. Content lives ONLY here (canonical
 * path). Trust class is stamped by the caller per ADR-0014 §8; it never
 * confers authority — it only labels provenance for the context builder.
 *
 * Denylist redaction (Phase D §2.1) is applied HERE, the single choke
 * point, so every stored message passes it: card numbers and
 * bearer/api-token shapes are masked before persistence and can never
 * survive the 7-day retention window nor replay into HISTORY prompts.
 * Loop-defense lineage is unaffected: sent-message fingerprints
 * (rendered_text_sha256) and sensor hashes (normalized_text_sha256) are
 * computed UPSTREAM from RAW content at delivery/observation time —
 * nothing hashes interaction_messages.content.
 */
export async function appendInteractionMessage(
  db: QueryExecutor,
  input: AppendMessageInput,
): Promise<string> {
  const id = randomUUID();
  const content = redactContent(input.content);
  const derivedState =
    input.threadState != null ? deriveThreadState(input.threadState) : null;
  await db.query(
    `INSERT INTO interaction_messages
       (id, thread_id, principal_id, surface, direction, trust_class,
        content, token_estimate, received_at, expires_at, source_ref)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
             $9::timestamptz, $10::timestamptz, $11)`,
    [
      id,
      input.threadId,
      input.principalId,
      input.surface,
      input.direction,
      input.trustClass,
      content,
      estimateTokens(content),
      input.receivedAt.toISOString(),
      new Date(input.receivedAt.getTime() + RAW_RETENTION_MS).toISOString(),
      input.sourceRef ?? null,
    ],
  );
  if (derivedState !== null && Object.keys(derivedState).length > 0) {
    await writeThreadMetadata(db, input.threadId, derivedState);
  }
  await touchThread(db, input.threadId, input.receivedAt);
  return id;
}

/** Content cap applied before anything is stored (bounded working memory). */
export const MAX_STORED_CONTENT = 4000;

/** Deterministic bounded context builder (contract §5): most-recent turns
 *  within the 72h active window, message-count and token budgets, recent
 *  first then reversed for transcript order; fails safe with a truncation
 *  marker. Principal scoping rides the thread_id (owner-matched at insert
 *  by trigger) — the query never touches other principals' rows. */
export async function buildWorkingContext(
  db: QueryExecutor,
  opts: {
    readonly threadId: string;
    readonly now: Date;
    /** REQUIRED (adversary 1b): the requesting principal — verified
     *  against the thread owner; mismatch fails closed. Structurally
     *  closes the WorkingContextProvider seam against foreign threads. */
    readonly principalId: string;
    readonly maxMessages?: number;
    readonly tokenBudget?: number;
  },
): Promise<WorkingContext> {
  const owner = await db.query(
    `SELECT principal_id FROM interaction_threads WHERE id = $1::uuid`,
    [opts.threadId],
  );
  const ownerId = owner.rows[0] === undefined ? undefined : String(owner.rows[0].principal_id);
  if (ownerId !== opts.principalId) {
    throw new Error("buildWorkingContext: thread does not belong to the requesting principal");
  }
  const maxMessages = opts.maxMessages ?? CONTEXT_MAX_MESSAGES;
  const tokenBudget = opts.tokenBudget ?? CONTEXT_TOKEN_BUDGET;
  const activeSince = new Date(opts.now.getTime() - ACTIVE_CONTEXT_TTL_MS).toISOString();
  const result = await db.query(
    `SELECT direction, trust_class, content, token_estimate, received_at
       FROM interaction_messages
      WHERE thread_id = $1::uuid
        AND received_at >= $2::timestamptz
      ORDER BY received_at DESC, id DESC
      LIMIT $3::int`,
    [opts.threadId, activeSince, maxMessages],
  );
  const selected: ContextMessage[] = [];
  let tokens = 0;
  let truncated = false;
  for (const row of result.rows) {
    const estimate = Number(row.token_estimate);
    if (tokens + estimate > tokenBudget && selected.length > 0) {
      truncated = true;
      break;
    }
    tokens += estimate;
    selected.push({
      direction: row.direction === "outbound" ? "outbound" : "inbound",
      trustClass: row.trust_class as InteractionTrustClass,
      content: String(row.content),
      receivedAt: new Date(String(row.received_at)).toISOString(),
      tokenEstimate: estimate,
    });
  }
  selected.reverse(); // transcript order (oldest → newest)
  return {
    threadId: opts.threadId,
    messages: selected,
    tokenEstimate: tokens,
    truncated: truncated || result.rows.length === maxMessages,
    oldestAt: selected.length > 0 ? selected[0]!.receivedAt : null,
  };
}

/** The Hermes-facing boundary (§15): curate working context without ever
 *  owning storage. Default Phase D strategy = deterministic recent window. */
export interface WorkingContextProvider {
  buildContext(input: {
    readonly principalId: string;
    readonly threadId: string;
    readonly tokenBudget: number;
  }): Promise<WorkingContext>;
}

export function createDefaultWorkingContextProvider(db: QueryExecutor): WorkingContextProvider {
  return {
    async buildContext(input) {
      return buildWorkingContext(db, {
        threadId: input.threadId,
        principalId: input.principalId,
        now: new Date(),
        tokenBudget: input.tokenBudget,
      });
    },
  };
}

export type ThreadReferentKind = "action" | "read" | "review";

const THREAD_REFERENT_KINDS: ReadonlySet<string> = new Set(["action", "read", "review"]);

export interface ThreadReferent {
  readonly kind: ThreadReferentKind;
  readonly ref: string;
  readonly label: string;
  readonly at: string;
}

export interface ThreadStance {
  readonly kind: string;
  readonly summary: string;
  readonly at: string;
}

/**
 * W4 thread-scoped profile override — lives in
 * interaction_threads.metadata.profile_override (the literal storage key;
 * the TS field name matches it 1:1 like topic/referents/lastStance so the
 * JSON round-trip is exact) and expires with the thread. Presentation
 * only: brevity deltas + one directive line, never authority.
 */
export interface ThreadBrevityDelta {
  readonly maxSentences?: number;
  readonly maxChars?: number;
}

export interface ThreadProfileOverride {
  readonly brevityDelta?: ThreadBrevityDelta;
  readonly extraDirective?: string;
}

export interface ThreadMetadata {
  readonly topic?: string;
  readonly referents?: readonly ThreadReferent[];
  readonly lastStance?: ThreadStance;
  readonly profile_override?: ThreadProfileOverride;
}

export interface TurnReferentArtifact {
  readonly kind: ThreadReferentKind;
  readonly ref: string;
  readonly label: string;
}

export interface TurnArtifacts {
  readonly at: string;
  readonly topic?: string | null;
  readonly referents?: readonly TurnReferentArtifact[] | null;
  readonly stance?: { readonly kind: string; readonly summary: string } | null;
}

export const THREAD_REFERENT_REGISTRY_CAP = 20;
export const TURN_REFERENTS_MAX = 8;
const TOPIC_MAX_CHARS = 160;
const REFERENT_REF_MAX_CHARS = 64;
const REFERENT_LABEL_MAX_CHARS = 200;
const STANCE_KIND_MAX_CHARS = 64;
const STANCE_SUMMARY_MAX_CHARS = 400;

type MutableThreadMetadata = {
  topic?: string;
  referents?: ThreadReferent[];
  lastStance?: ThreadStance;
  profile_override?: ThreadProfileOverride;
};

function sanitizeThreadText(text: string, maxChars: number): string {
  return redactContent(text.trim())
    .replace(/\r?\n/g, "\\n")
    .slice(0, maxChars);
}

export function deriveThreadState(artifacts: TurnArtifacts): ThreadMetadata {
  const at = parseDateInput(artifacts.at, "TurnArtifacts.at").toISOString();
  const metadata: MutableThreadMetadata = {};
  if (artifacts.topic != null) {
    const topic = sanitizeThreadText(artifacts.topic, TOPIC_MAX_CHARS);
    if (topic.length > 0) metadata.topic = topic;
  }
  if (artifacts.referents != null && artifacts.referents.length > 0) {
    const referents: ThreadReferent[] = [];
    const seen = new Set<string>();
    for (const referent of artifacts.referents.slice(0, TURN_REFERENTS_MAX)) {
      if (!THREAD_REFERENT_KINDS.has(referent.kind)) continue;
      const ref = referent.ref.trim().slice(0, REFERENT_REF_MAX_CHARS);
      const label = sanitizeThreadText(referent.label, REFERENT_LABEL_MAX_CHARS);
      if (ref.length === 0 || label.length === 0) continue;
      const key = `${referent.kind}\u0000${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      referents.push({ kind: referent.kind, ref, label, at });
    }
    if (referents.length > 0) metadata.referents = referents;
  }
  if (artifacts.stance != null) {
    const kind = artifacts.stance.kind.trim().slice(0, STANCE_KIND_MAX_CHARS);
    const summary = sanitizeThreadText(artifacts.stance.summary, STANCE_SUMMARY_MAX_CHARS);
    if (kind.length > 0 && summary.length > 0) {
      metadata.lastStance = { kind, summary, at };
    }
  }
  return metadata;
}

export function mergeThreadState(
  existing: ThreadMetadata | null,
  turn: ThreadMetadata | null,
): ThreadMetadata {
  const base = existing ?? {};
  const delta = turn ?? {};
  const merged: MutableThreadMetadata = {};
  const topic = delta.topic ?? base.topic;
  if (topic !== undefined && topic.length > 0) merged.topic = topic;
  const byKey = new Map<string, ThreadReferent>();
  for (const referent of [...(base.referents ?? []), ...(delta.referents ?? [])]) {
    if (!THREAD_REFERENT_KINDS.has(referent.kind)) continue;
    if (typeof referent.ref !== "string" || referent.ref.length === 0) continue;
    if (typeof referent.label !== "string" || referent.label.length === 0) continue;
    byKey.set(`${referent.kind}\u0000${referent.ref}`, {
      kind: referent.kind,
      ref: referent.ref,
      label: referent.label,
      at: referent.at,
    });
  }
  if (byKey.size > 0) {
    merged.referents = [...byKey.values()].slice(-THREAD_REFERENT_REGISTRY_CAP);
  }
  const lastStance = delta.lastStance ?? base.lastStance;
  if (lastStance !== undefined) merged.lastStance = lastStance;
  // W4: a thread-scoped profile override rides along untouched — turn
  // artifacts never produce or mutate it (setThreadProfileOverride owns it).
  if (base.profile_override !== undefined) merged.profile_override = base.profile_override;
  return merged;
}

export function retractLastStance(metadata: ThreadMetadata | null): ThreadMetadata {
  if (metadata === null) return {};
  return {
    ...(metadata.topic !== undefined ? { topic: metadata.topic } : {}),
    ...(metadata.referents !== undefined ? { referents: metadata.referents } : {}),
    ...(metadata.profile_override !== undefined
      ? { profile_override: metadata.profile_override }
      : {}),
  };
}

export function parseThreadMetadata(value: unknown): ThreadMetadata | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (
      key !== "topic" &&
      key !== "referents" &&
      key !== "lastStance" &&
      key !== "profile_override"
    ) {
      return null;
    }
  }
  const metadata: MutableThreadMetadata = {};
  if (obj.topic !== undefined) {
    if (typeof obj.topic !== "string" || obj.topic.length === 0) return null;
    metadata.topic = obj.topic;
  }
  if (obj.referents !== undefined) {
    if (!Array.isArray(obj.referents)) return null;
    const referents: ThreadReferent[] = [];
    for (const item of obj.referents) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      if (typeof row.kind !== "string" || !THREAD_REFERENT_KINDS.has(row.kind)) return null;
      if (typeof row.ref !== "string" || row.ref.length === 0) return null;
      if (typeof row.label !== "string" || row.label.length === 0) return null;
      if (typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))) return null;
      referents.push({
        kind: row.kind as ThreadReferentKind,
        ref: row.ref,
        label: row.label,
        at: row.at,
      });
    }
    if (referents.length > 0) metadata.referents = referents;
  }
  if (obj.lastStance !== undefined) {
    if (typeof obj.lastStance !== "object" || obj.lastStance === null || Array.isArray(obj.lastStance)) {
      return null;
    }
    const stance = obj.lastStance as Record<string, unknown>;
    if (typeof stance.kind !== "string" || stance.kind.length === 0) return null;
    if (typeof stance.summary !== "string" || stance.summary.length === 0) return null;
    if (typeof stance.at !== "string" || Number.isNaN(Date.parse(stance.at))) return null;
    metadata.lastStance = { kind: stance.kind, summary: stance.summary, at: stance.at };
  }
  if (obj.profile_override !== undefined) {
    const override = parseProfileOverride(obj.profile_override);
    if (override === null) return null;
    metadata.profile_override = override;
  }
  return metadata;
}

/** W4: strict fail-closed parse of the profile_override metadata value. */
function parseProfileOverride(value: unknown): ThreadProfileOverride | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "brevityDelta" && key !== "extraDirective") return null;
  }
  const override: { brevityDelta?: { maxSentences?: number; maxChars?: number }; extraDirective?: string } =
    {};
  let carried = false;
  if (obj.brevityDelta !== undefined) {
    if (typeof obj.brevityDelta !== "object" || obj.brevityDelta === null || Array.isArray(obj.brevityDelta)) {
      return null;
    }
    const delta = obj.brevityDelta as Record<string, unknown>;
    for (const key of Object.keys(delta)) {
      if (key !== "maxSentences" && key !== "maxChars") return null;
    }
    const brevityDelta: { maxSentences?: number; maxChars?: number } = {};
    if (delta.maxSentences !== undefined) {
      if (typeof delta.maxSentences !== "number" || !Number.isInteger(delta.maxSentences)) return null;
      brevityDelta.maxSentences = delta.maxSentences;
    }
    if (delta.maxChars !== undefined) {
      if (typeof delta.maxChars !== "number" || !Number.isInteger(delta.maxChars)) return null;
      brevityDelta.maxChars = delta.maxChars;
    }
    if (Object.keys(brevityDelta).length === 0) return null;
    override.brevityDelta = brevityDelta;
    carried = true;
  }
  if (obj.extraDirective !== undefined) {
    if (typeof obj.extraDirective !== "string") return null;
    const line = obj.extraDirective;
    if (line.trim().length === 0 || line.includes("\n") || line.length > 120) return null;
    override.extraDirective = line;
    carried = true;
  }
  return carried ? override : null;
}

async function writeThreadMetadata(
  db: QueryExecutor,
  threadId: string,
  turn: ThreadMetadata,
): Promise<void> {
  const row = await db.query(
    `SELECT metadata FROM interaction_threads WHERE id = $1::uuid FOR UPDATE`,
    [threadId],
  );
  const current = row.rows[0] === undefined ? null : row.rows[0].metadata;
  const merged = mergeThreadState(parseThreadMetadata(current), turn);
  await db.query(
    `UPDATE interaction_threads SET metadata = $2::jsonb WHERE id = $1::uuid`,
    [threadId, JSON.stringify(merged)],
  );
}

export async function retractThreadStance(
  db: QueryExecutor,
  opts: {
    readonly threadId: string;
    readonly principalId: string;
  },
): Promise<ThreadMetadata> {
  const row = await db.query(
    `SELECT principal_id, metadata FROM interaction_threads WHERE id = $1::uuid FOR UPDATE`,
    [opts.threadId],
  );
  const thread = row.rows[0];
  if (thread === undefined || String(thread.principal_id) !== opts.principalId) {
    throw new Error("retractThreadStance: thread does not belong to the requesting principal");
  }
  const retracted = retractLastStance(parseThreadMetadata(thread.metadata));
  await db.query(
    `UPDATE interaction_threads SET metadata = $2::jsonb WHERE id = $1::uuid`,
    [opts.threadId, JSON.stringify(retracted)],
  );
  return retracted;
}

/** Retention pass (§13): delete raw content past the 7-day horizon, delete
 *  expired empty threads, and report counts for audit/metrics — content
 *  NEVER enters the report. Idempotent by construction. */
export interface RetentionReport {
  readonly messagesDeleted: number;
  readonly threadsDeleted: number;
  /** Adversary 4d: gateway reply notifications whose payload content was
   *  stripped at the 7d horizon (the row survives for delivery audit; the
   *  quoted text does not). */
  readonly replyPayloadsRedacted: number;
}

export async function enforceRetention(
  db: QueryExecutor,
  opts: { readonly now: Date } = { now: new Date() },
): Promise<RetentionReport> {
  const messages = await db.query(
    `DELETE FROM interaction_messages WHERE expires_at <= $1::timestamptz RETURNING id`,
    [opts.now.toISOString()],
  );
  const threads = await db.query(
    `DELETE FROM interaction_threads t
      WHERE t.raw_retention_expires_at <= $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM interaction_messages m WHERE m.thread_id = t.id)
      RETURNING t.id`,
    [opts.now.toISOString()],
  );
  // Replies QUOTE inbound text and grounded data — without this, the
  // notification payload is an unbounded content store that outlives the
  // 7-day horizon (ADR-0014's "single canonical path" would be false).
  // Strip content only; the row + status remain the delivery audit trail.
  const replies = await db.query(
    `UPDATE notifications
        SET payload = payload - 'content'
      WHERE kind = 'reply' AND surface = 'imessage'
        AND payload ? 'content'
        AND created_at <= $1::timestamptz
      RETURNING id`,
    [new Date(opts.now.getTime() - RAW_RETENTION_MS).toISOString()],
  );
  return {
    messagesDeleted: messages.rows.length,
    threadsDeleted: threads.rows.length,
    replyPayloadsRedacted: replies.rows.length,
  };
}

function toThreadRow(row: Record<string, unknown>): ThreadRow {
  return {
    id: String(row.id),
    principalId: String(row.principal_id),
    surface: String(row.surface),
    status: String(row.status),
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastActivityAt: new Date(String(row.last_activity_at)).toISOString(),
    activeContextExpiresAt: new Date(String(row.active_context_expires_at)).toISOString(),
    rawRetentionExpiresAt: new Date(String(row.raw_retention_expires_at)).toISOString(),
  };
}
