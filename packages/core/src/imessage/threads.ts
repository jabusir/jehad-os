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
 */
export async function appendInteractionMessage(
  db: QueryExecutor,
  input: AppendMessageInput,
): Promise<string> {
  const id = randomUUID();
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
      input.content,
      estimateTokens(input.content),
      input.receivedAt.toISOString(),
      new Date(input.receivedAt.getTime() + RAW_RETENTION_MS).toISOString(),
      input.sourceRef ?? null,
    ],
  );
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
    readonly maxMessages?: number;
    readonly tokenBudget?: number;
  },
): Promise<WorkingContext> {
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
        now: new Date(),
        tokenBudget: input.tokenBudget,
      });
    },
  };
}

/** Retention pass (§13): delete raw content past the 7-day horizon, delete
 *  expired empty threads, and report counts for audit/metrics — content
 *  NEVER enters the report. Idempotent by construction. */
export async function enforceRetention(
  db: QueryExecutor,
  opts: { readonly now: Date } = { now: new Date() },
): Promise<{ messagesDeleted: number; threadsDeleted: number }> {
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
  return {
    messagesDeleted: messages.rows.length,
    threadsDeleted: threads.rows.length,
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
