// Phase G — review/control via deterministic refs over iMessage
// (docs/plans/ig-phase-g-contracts.md; gateway plan §3.1 CONTROL mode,
// ADR-0004, ADR-0014 §1).
//
// Exact-match control grammar resolved deterministically BEFORE any model
// call / route pass / history assembly: `approve|reject|snooze [REF]` and
// `queue`. The parser's ONLY input is the current inbound turn's text
// (Phase F's never-from table inherited verbatim — assistant_output,
// tool_output/DATA, retrieved_external_data, stored HISTORY can never
// reach it). Unmatched text falls through to CONVERSATION mode unchanged.
//
// Refs are authority-bearing tokens (contract §2): 3-char Crockford
// base32 (0-9 A-Z minus I L O U), minted per queue item at first
// surfacing and kept until resolution, owner-scoped, 168h TTL. Verbs
// resolve through the EXISTING services only — approvePromotion /
// rejectPromotion (the shared review resolver, gateway §7 row G) plus the
// append-only feedback service for the rejection verdict — G adds no
// promotion logic of its own. ZERO model calls anywhere in this module.
//
// Audits are content-free: refs, ids, counts, outcomes — never statement
// text (contract §5 "refs + ids only, grant-style provenance"). Command
// outcomes audit as `imessage.control.verdict`; the guard rails (denial,
// bad ref, cool-down, expiry, error) audit as `imessage.review.*`.

import { randomInt } from "node:crypto";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { createNotification } from "../notifications/service.js";
import { recordFeedback } from "../feedback/service.js";
import type { ModelEgressPolicyRegistry } from "../egress/index.js";
import type { PromotionDb, PromotionOutcome } from "../promotion/pipeline.js";
import { approvePromotion, rejectPromotion } from "../review/review-queue.js";

// ------------------------------------------------------------------ policy

/** policy.yaml `gateway.review` shape (contract §7 — strict keys). */
export interface ReviewPolicy {
  readonly enabled: boolean;
  readonly principals: readonly string[];
  readonly maxBadRefs: number;
  readonly snoozeHours: number;
  readonly refTtlHours: number;
  readonly digestMaxCandidates: number;
  readonly digestMaxEscalations: number;
}

/** Contract §7 defaults — owner principal 'josctl' enabled, all else denied. */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  enabled: true,
  principals: ["josctl"],
  maxBadRefs: 3,
  snoozeHours: 24,
  refTtlHours: 168,
  digestMaxCandidates: 10,
  digestMaxEscalations: 5,
};

/** Only for principals whose policy enables review (contract §6). */
export function reviewEnabledFor(principalName: string, policy?: ReviewPolicy | null): boolean {
  const p = policy ?? DEFAULT_REVIEW_POLICY;
  return p.enabled && p.principals.includes(principalName);
}

// ------------------------------------------------------------------ grammar

/** Crockford base32 minus confusables (contract §2): no I, L, O, U. */
export const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REF_LENGTH = 3;
/** Digest/queue reply cap — the same 1500-char edge render rule (§3). */
export const REVIEW_REPLY_CHAR_LIMIT = 1500;
const TRUNCATION_MARKER = "…[truncated]";

const COMMANDS = new Set(["approve", "reject", "snooze", "queue"]);

export interface ParsedReviewCommand {
  readonly cmd: "approve" | "reject" | "snooze" | "queue";
  /** Uppercase display form; absent for bare approve/reject/snooze. */
  readonly ref?: string;
}

/**
 * Exact-match grammar over the trimmed, case-insensitive current inbound
 * text (contract §3): `approve|reject|snooze [REF]` (brackets optional,
 * ref case-insensitive) and bare `queue`. Anything else — including
 * `queue <ref>` (not in the grammar) — returns null and falls through to
 * CONVERSATION mode unchanged. A ref outside the Crockford alphabet
 * parses here (shape-valid) and dies honestly at resolution as an
 * unknown ref (§6: guessing protection is at lookup, not parse).
 */
export function parseReviewCommand(text: string): ParsedReviewCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const match = /^(approve|reject|snooze|queue)(?:\s+(?:\[([0-9a-z]{3})\]|([0-9a-z]{3}))?)?$/.exec(
    trimmed,
  );
  if (match === null) return null;
  const cmd = match[1] as ParsedReviewCommand["cmd"];
  if (!COMMANDS.has(cmd)) return null;
  const ref = match[2] ?? match[3] ?? null;
  if (cmd === "queue" && ref !== null) return null; // `queue` takes no ref
  return ref === null ? { cmd } : { cmd, ref: ref.toUpperCase() };
}

// ------------------------------------------------------------------ inputs

export interface ReviewCommandInput {
  readonly principalId: string;
  readonly principalName: string;
  /** The CURRENT inbound turn's text — the only input the parser ever reads. */
  readonly text: string;
  readonly now: Date;
}

export interface ReviewCommandResult {
  /** False = not a control command; fall through to the conversation path. */
  readonly handled: boolean;
  /** Absent reply on a handled command = silent drop (bad-ref lockout, §6). */
  readonly reply?: string;
}

export interface ReviewCommandOptions {
  readonly policy?: ReviewPolicy | null;
  /**
   * The egress registry approvePromotion needs (the EXISTING pipeline's
   * gate-3 fact). Approve without it fails honest — nothing changes.
   */
  readonly egressRegistry?: ModelEgressPolicyRegistry;
}

// ------------------------------------------------------------------ replies

export const REVIEW_DENIED_REPLY =
  "Review commands are enabled only for Jehad on this channel.";
export const REVIEW_UNKNOWN_REF_REPLY =
  "Unknown ref — reply `queue` for current items.";
export const REVIEW_EXPIRED_REPLY =
  "That ref expired — reply `queue` for current items.";
export const REVIEW_COOLDOWN_REPLY =
  "Too many unknown refs — review commands are paused for this hour. Reply `queue` later.";
export const REVIEW_QUEUE_EMPTY_REPLY = "Nothing waiting — your review queue is empty.";
export const REVIEW_NOT_CONFIGURED_REPLY =
  "Approve isn't available on this channel right now — nothing changed.";
export const REVIEW_FAILED_REPLY =
  "That didn't complete — nothing changed. Reply `queue` to see current items.";

const REVIEW_ACTOR = "system:imessage-gateway";

/** ids/counts only — NEVER content (contract §5). The `at` field is the
 *  command turn's authoritative instant (the handler's injected clock, not
 *  the DB writer's wall time) so rolling-window counters stay consistent
 *  with the handler's time source. */
function reviewAudit(
  db: SqlExecutor,
  action: string,
  outputs: Record<string, unknown>,
  at: Date,
): Promise<void> {
  return recordAudit(db, {
    actor: REVIEW_ACTOR,
    action,
    reversible: true,
    outputsRef: JSON.stringify({ ...outputs, at: at.toISOString() }),
  });
}

/** Reviews of this action for one principal inside the rolling hour
 *  (windowed on the audit's `at` field — see reviewAudit). */
async function auditCount(
  db: SqlExecutor,
  action: "imessage.review.bad_ref" | "imessage.review.cooldown",
  principalId: string,
  hourStartIso: string,
): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE action = $1
        AND outputs_ref::jsonb->>'at' >= $2
        AND outputs_ref::jsonb->>'principalId' = $3`,
    [action, hourStartIso, principalId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

function capReviewReply(text: string): string {
  if (text.length <= REVIEW_REPLY_CHAR_LIMIT) return text;
  return text.slice(0, REVIEW_REPLY_CHAR_LIMIT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

// ------------------------------------------------------------------ refs

export type ReviewItemType = "candidate" | "escalation";

export interface MintReviewRefInput {
  readonly itemType: ReviewItemType;
  readonly itemId: string;
  readonly principalId: string;
  readonly now: Date;
}

export interface MintReviewRefOptions {
  /** Overrides the policy TTL (hours) — tests use short horizons. */
  readonly ttlHours?: number;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function drawRef(): string {
  let ref = "";
  for (let i = 0; i < REF_LENGTH; i++) {
    ref += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  }
  return ref;
}

/**
 * Mint-once (contract §2): the item's existing unresolved ref is returned
 * as-is — an old brief's ref stays copyable; refs are NOT re-minted per
 * digest. A ref past its TTL is resolved ('expiry' — resolution ends
 * authority) and a fresh code is drawn; CSPRNG draw, retry on collision
 * with the principal's live refs (≤25 live refs/principal by the §5
 * digest bound → collision odds trivial). A concurrent mint for the same
 * item collapses onto the winner's ref via the unique partial index.
 */
export async function mintReviewRef(
  db: SqlExecutor,
  input: MintReviewRefInput,
  opts: MintReviewRefOptions = {},
): Promise<string> {
  const ttlHours = opts.ttlHours ?? DEFAULT_REVIEW_POLICY.refTtlHours;
  const now = input.now;

  const existing = await db.query(
    `SELECT id, ref, expires_at FROM review_refs
      WHERE item_type = $1 AND item_id = $2::uuid AND resolved_at IS NULL
      LIMIT 1`,
    [input.itemType, input.itemId],
  );
  const live = existing.rows[0];
  if (live !== undefined) {
    if (new Date(String(live.expires_at)).getTime() > now.getTime()) {
      return String(live.ref);
    }
    // Expired: lazily resolve (expiry sets resolved_at; the ref dies), re-mint.
    await db.query(
      `UPDATE review_refs SET resolved_at = $2::timestamptz, resolved_by = 'expiry'
        WHERE id = $1::uuid AND resolved_at IS NULL`,
      [String(live.id), now.toISOString()],
    );
  }

  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60_000).toISOString();
  for (let attempt = 0; attempt < 25; attempt++) {
    const ref = drawRef();
    try {
      await db.query(
        `INSERT INTO review_refs (ref, principal_id, item_type, item_id, minted_at, expires_at)
         VALUES ($1, $2::uuid, $3, $4::uuid, $5::timestamptz, $6::timestamptz)`,
        [ref, input.principalId, input.itemType, input.itemId, now.toISOString(), expiresAt],
      );
      return ref;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await db.query(
        `SELECT ref FROM review_refs
          WHERE item_type = $1 AND item_id = $2::uuid AND resolved_at IS NULL
          LIMIT 1`,
        [input.itemType, input.itemId],
      );
      if (winner.rows[0] !== undefined) return String(winner.rows[0].ref);
      // (principal_id, ref) live-collision — redraw.
    }
  }
  throw new Error("mintReviewRef: could not draw a unique ref");
}

interface ReviewRefRow {
  readonly id: string;
  readonly ref: string;
  readonly itemType: ReviewItemType;
  readonly itemId: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly expiresAt: string;
  readonly snoozedUntil: string | null;
  readonly snoozeCount: number;
}

function toRefRow(row: Record<string, unknown>): ReviewRefRow {
  return {
    id: String(row.id),
    ref: String(row.ref),
    itemType: String(row.item_type) as ReviewItemType,
    itemId: String(row.item_id),
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : new Date(row.resolved_at as Date).toISOString(),
    resolvedBy: row.resolved_by === null || row.resolved_by === undefined ? null : String(row.resolved_by),
    expiresAt: new Date(row.expires_at as Date).toISOString(),
    snoozedUntil: row.snoozed_until === null || row.snoozed_until === undefined ? null : new Date(row.snoozed_until as Date).toISOString(),
    snoozeCount: Number(row.snooze_count ?? 0),
  };
}

/**
 * The principal's row for a ref: the unresolved one if any, else the most
 * recently resolved (for honest "already handled" replay replies).
 */
async function refRowFor(db: SqlExecutor, principalId: string, ref: string): Promise<ReviewRefRow | null> {
  const result = await db.query(
    `SELECT id, ref, item_type, item_id, resolved_at, resolved_by, expires_at, snoozed_until, snooze_count
      FROM review_refs
      WHERE principal_id = $1::uuid AND ref = $2
      ORDER BY (resolved_at IS NULL) DESC, resolved_at DESC NULLS LAST
      LIMIT 1`,
    [principalId, ref],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRefRow(row);
}

async function resolveRef(
  db: SqlExecutor,
  refId: string,
  now: Date,
  resolvedBy: "approve" | "reject" | "expiry" | "superseded",
): Promise<void> {
  await db.query(
    `UPDATE review_refs SET resolved_at = $2::timestamptz, resolved_by = $3
      WHERE id = $1::uuid AND resolved_at IS NULL`,
    [refId, now.toISOString(), resolvedBy],
  );
}

async function candidateStatus(db: SqlExecutor, candidateId: string): Promise<string | null> {
  const result = await db.query(`SELECT status FROM memory_candidates WHERE id = $1::uuid`, [
    candidateId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : String(row.status);
}

function alreadyHandledReply(ref: string, resolution: string): string {
  if (resolution === "approve") return `Already handled — [${ref}] was approved.`;
  if (resolution === "reject") return `Already handled — [${ref}] was rejected.`;
  if (resolution === "expiry") return REVIEW_EXPIRED_REPLY;
  return `Already handled — [${ref}] left the review queue.`;
}

// ------------------------------------------------------------------ digest

export interface ReviewRefItem {
  readonly ref: string;
  readonly itemType: ReviewItemType;
  readonly itemId: string;
  /** One-line descriptor, ≤80 chars (candidate statement / escalation reason). */
  readonly summary: string;
  readonly createdAt: string;
  readonly snoozeCount: number;
}

export interface ReviewDigest {
  readonly candidates: readonly ReviewRefItem[];
  readonly escalations: readonly ReviewRefItem[];
  readonly moreCandidates: number;
  readonly moreEscalations: number;
}

export interface ReviewDigestOptions {
  readonly maxEscalations?: number;
}

/** One-line descriptor cap (contract §3: "truncated 80 chars"). */
const SUMMARY_LIMIT = 80;

function truncateSummary(text: string): string {
  return text.length <= SUMMARY_LIMIT ? text : text.slice(0, SUMMARY_LIMIT - 1) + "…";
}

function candidateSummary(payload: Readonly<Record<string, unknown>>, proposedClass: string, assertionKind: string): string {
  const statement = payload["statement"];
  if (typeof statement === "string" && statement.trim().length > 0) {
    return truncateSummary(statement);
  }
  return truncateSummary(`${proposedClass}/${assertionKind} memory proposal`);
}

function escalationSummary(reason: string, urgency: string | null): string {
  return truncateSummary(urgency === null ? reason : `${reason} (${urgency})`);
}

/**
 * Live refs joined to item summaries — the shared query under both the
 * morning-brief review section (§4.2) and the on-demand `queue` digest
 * (§3): oldest-first in_review candidates (the listReviewQueue order),
 * then urgency-ranked escalations (the M6C batch ranking). First
 * surfacing mints the item's ref here (mint-once, kept until resolution).
 * Snoozed refs hide their item until snoozed_until passes; an expired
 * unresolved ref is re-minted fresh. `limit` bounds the candidates;
 * escalations are bounded by opts.maxEscalations (default 5, §7).
 */
export async function refsForBrief(
  db: SqlExecutor,
  principalId: string,
  now: Date,
  limit: number = DEFAULT_REVIEW_POLICY.digestMaxCandidates,
  opts: ReviewDigestOptions = {},
): Promise<ReviewDigest> {
  const maxCandidates = Math.max(1, limit);
  const maxEscalations = Math.max(
    1,
    opts.maxEscalations ?? DEFAULT_REVIEW_POLICY.digestMaxEscalations,
  );
  const nowIso = now.toISOString();

  // Same shape as listReviewQueue's promotions query (oldest first), LEFT
  // JOINed to the item's live ref; a live snooze hides the item until it
  // lifts. NOT r.snoozed-eligible alone: an expired ref still surfaces the
  // item (re-minted below).
  const candidateFilter = `
    FROM memory_candidates c
    LEFT JOIN review_refs r
      ON r.item_type = 'candidate' AND r.item_id = c.id AND r.resolved_at IS NULL
    WHERE c.status = 'in_review'
      AND (r.id IS NULL OR r.snoozed_until IS NULL OR r.snoozed_until <= $1::timestamptz)`;

  // M6C BATCH_ORDER_SQL (packages/core/src/review/batching.ts — not
  // exported; mirrored): urgency desc, est_human_minutes asc nulls last,
  // then oldest — the most attention-worthy surface first.
  const escalationOrder = `
    CASE e.urgency
      WHEN 'blocker' THEN 5 WHEN 'critical' THEN 4 WHEN 'high' THEN 3
      WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0
    END DESC,
    e.est_human_minutes ASC NULLS LAST,
    e.created_at ASC,
    e.id ASC`;

  const escalationFilter = `
    FROM escalations e
    LEFT JOIN review_refs r
      ON r.item_type = 'escalation' AND r.item_id = e.id AND r.resolved_at IS NULL
    WHERE e.status IN ('pending', 'batched')
      AND (r.id IS NULL OR r.snoozed_until IS NULL OR r.snoozed_until <= $1::timestamptz)`;

  const [candidateRows, candidateTotal, escalationRows, escalationTotal] = await Promise.all([
    db.query(
      `SELECT c.id, c.payload, c.proposed_class, c.assertion_kind, c.created_at,
              r.ref, r.expires_at, r.snooze_count${candidateFilter}
       ORDER BY c.created_at ASC
       LIMIT $2`,
      [nowIso, maxCandidates],
    ),
    db.query(`SELECT count(*)::int AS n${candidateFilter}`, [nowIso]),
    db.query(
      `SELECT e.id, e.reason, e.urgency, e.created_at,
              r.ref, r.expires_at, r.snooze_count${escalationFilter}
       ORDER BY ${escalationOrder}
       LIMIT $2`,
      [nowIso, maxEscalations],
    ),
    db.query(`SELECT count(*)::int AS n${escalationFilter}`, [nowIso]),
  ]);

  const toItems = async (
    rows: readonly Record<string, unknown>[],
    itemType: ReviewItemType,
    summarize: (row: Record<string, unknown>) => string,
  ): Promise<ReviewRefItem[]> => {
    const items: ReviewRefItem[] = [];
    for (const row of rows) {
      const itemId = String(row.id);
      const rawRef = row.ref === null || row.ref === undefined ? null : String(row.ref);
      const expired =
        rawRef !== null && new Date(String(row.expires_at)).getTime() <= now.getTime();
      // First surfacing (or TTL lapse) mints here — mint-once thereafter.
      const ref =
        rawRef === null || expired
          ? await mintReviewRef(db, { itemType, itemId, principalId, now })
          : rawRef;
      items.push({
        ref,
        itemType,
        itemId,
        summary: summarize(row),
        createdAt: new Date(row.created_at as Date).toISOString(),
        snoozeCount: Number(row.snooze_count ?? 0),
      });
    }
    return items;
  };

  const candidates = await toItems(candidateRows.rows, "candidate", (row) =>
    candidateSummary(
      (row.payload ?? {}) as Record<string, unknown>,
      String(row.proposed_class),
      String(row.assertion_kind),
    ),
  );
  const escalations = await toItems(escalationRows.rows, "escalation", (row) =>
    escalationSummary(String(row.reason), row.urgency === null || row.urgency === undefined ? null : String(row.urgency)),
  );

  return {
    candidates,
    escalations,
    moreCandidates: Math.max(0, Number(candidateTotal.rows[0]?.n ?? 0) - candidates.length),
    moreEscalations: Math.max(0, Number(escalationTotal.rows[0]?.n ?? 0) - escalations.length),
  };
}

function digestLine(item: ReviewRefItem): string {
  const escalationPart = item.itemType === "escalation" ? "escalation " : "";
  // snooze_count surfaces after 2+ snoozes (contract §5).
  const snoozePart = item.snoozeCount >= 2 ? ` — snoozed ${item.snoozeCount}×` : "";
  return `- [${item.ref}] ${escalationPart}${item.summary}${snoozePart}`;
}

function renderDigest(digest: ReviewDigest): string {
  const waiting = digest.candidates.length + digest.escalations.length + digest.moreCandidates + digest.moreEscalations;
  const lines = [`Review queue — ${waiting} waiting`];
  for (const item of digest.candidates) lines.push(digestLine(item));
  for (const item of digest.escalations) lines.push(digestLine(item));
  const more = digest.moreCandidates + digest.moreEscalations;
  if (more > 0) lines.push(`- …and ${more} more`);
  return capReviewReply(lines.join("\n"));
}

// ------------------------------------------------------------- lockout E4

async function resolveReviewServicePrincipal(db: SqlExecutor): Promise<string> {
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
    ["system:imessage-gateway"],
  );
  const id = upsert.rows[0]?.id;
  if (id === undefined) {
    throw new Error("resolveReviewServicePrincipal: could not resolve the gateway service principal");
  }
  return String(id);
}

/** Owner-visible E4 alert on lockout (contract §6) — ids/counts only. */
async function notifyOwnerOfLockout(
  db: SqlExecutor,
  principalId: string,
  badRefCount: number,
  cap: number,
  now: Date,
): Promise<void> {
  const createdBy = await resolveReviewServicePrincipal(db);
  // No policy config (F0 do-not-convert): kind=custom lockout alert is
  // review-governed by design — it must land pending for user review.
  await createNotification(
    db,
    {
      kind: "custom",
      title: "Review commands paused",
      payload: { reason: "bad-ref-lockout", principalId, badRefCount, cap, window: "1h" },
      sourceType: "run",
      sourceId: null,
      createdBy,
    },
    { actor: REVIEW_ACTOR, now: () => now },
  );
}

// ------------------------------------------------------------- handler

/**
 * The deterministic control pre-pass for one inbound turn (the
 * orchestrator calls this BEFORE the route pass — CONTROL wins over
 * CONVERSATION, gateway §3.1). Zero model calls on every path.
 *
 * Order: parse (null → not handled) → owner-only policy gate (§6, fail
 * closed) → bad-ref lockout (over cap: one cool-down notice, then silent
 * drop + audit) → `queue` digest or ref verdict through the EXISTING
 * services. Replays are honest noops naming the prior verdict; expired
 * refs expire honest with a queue hint; unknown refs are
 * indistinguishable from never-minted and count toward the cap.
 */
export async function handleReviewCommand(
  db: PromotionDb,
  input: ReviewCommandInput,
  opts: ReviewCommandOptions = {},
): Promise<ReviewCommandResult> {
  const parsed = parseReviewCommand(input.text);
  if (parsed === null) return { handled: false };
  const policy = opts.policy ?? DEFAULT_REVIEW_POLICY;
  const { principalId, principalName, now } = input;

  // 1. Owner-only scope — the review queue is the owner's (§6).
  if (!reviewEnabledFor(principalName, policy)) {
    await reviewAudit(db, "imessage.review.denied", {
      reason: "principal-not-review-enabled",
      principalId,
      principalName,
      command: parsed.cmd,
    },
    now);
    return { handled: true, reply: REVIEW_DENIED_REPLY };
  }

  // 2. Bad-ref lockout (§6): replies are the spray oracle, so the cap
  //    gates replies — over cap, control commands get ONE cool-down
  //    notice, then silence until the rolling hour clears.
  const hourStart = new Date(now.getTime() - 60 * 60_000).toISOString();
  const badCount = await auditCount(db, "imessage.review.bad_ref", principalId, hourStart);
  if (badCount >= policy.maxBadRefs) {
    const noticed = await auditCount(db, "imessage.review.cooldown", principalId, hourStart);
    await reviewAudit(db, "imessage.review.cooldown", {
      principalId,
      badRefCount: badCount,
      cap: policy.maxBadRefs,
      ref: parsed.ref ?? null,
    },
    now);
    if (noticed === 0) {
      await notifyOwnerOfLockout(db, principalId, badCount, policy.maxBadRefs, now);
      return { handled: true, reply: REVIEW_COOLDOWN_REPLY };
    }
    return { handled: true }; // silent drop — audit only
  }

  if (parsed.cmd === "queue") {
    const digest = await refsForBrief(db, principalId, now, policy.digestMaxCandidates, {
      maxEscalations: policy.digestMaxEscalations,
    });
    const waiting =
      digest.candidates.length + digest.escalations.length + digest.moreCandidates + digest.moreEscalations;
    const reply = waiting === 0 ? REVIEW_QUEUE_EMPTY_REPLY : renderDigest(digest);
    await reviewAudit(db, "imessage.control.verdict", {
      principalId,
      command: "queue",
      outcome: waiting === 0 ? "empty" : "listed",
      candidates: digest.candidates.length,
      escalations: digest.escalations.length,
      more: digest.moreCandidates + digest.moreEscalations,
    },
    now);
    return { handled: true, reply };
  }

  return verdictCommand(db, input, parsed, policy, opts);
}

/** Ids of in_review candidates eligible for a bare verdict (not snoozed). */
async function eligibleCandidateIds(db: SqlExecutor, now: Date): Promise<readonly string[]> {
  const result = await db.query(
    `SELECT c.id
      FROM memory_candidates c
      LEFT JOIN review_refs r
        ON r.item_type = 'candidate' AND r.item_id = c.id AND r.resolved_at IS NULL
      WHERE c.status = 'in_review'
        AND (r.id IS NULL OR r.snoozed_until IS NULL OR r.snoozed_until <= $1::timestamptz)
      ORDER BY c.created_at ASC`,
    [now.toISOString()],
  );
  return result.rows.map((row) => String(row.id));
}

async function clarificationReply(
  db: SqlExecutor,
  input: ReviewCommandInput,
  parsed: ParsedReviewCommand,
  policy: ReviewPolicy,
  eligibleCount: number,
): Promise<ReviewCommandResult> {
  let reply: string;
  if (eligibleCount === 0) {
    reply = "Nothing is waiting for your call right now.";
  } else {
    const digest = await refsForBrief(db, input.principalId, input.now, policy.digestMaxCandidates, {
      maxEscalations: policy.digestMaxEscalations,
    });
    const lines = ["Which one? Reply with its ref:"];
    for (const item of digest.candidates) lines.push(digestLine(item));
    for (const item of digest.escalations) lines.push(digestLine(item));
    const more = digest.moreCandidates + digest.moreEscalations;
    if (more > 0) lines.push(`- …and ${more} more (reply \`queue\` for the full list)`);
    reply = capReviewReply(lines.join("\n"));
  }
  await reviewAudit(db, "imessage.control.verdict", {
    principalId: input.principalId,
    command: parsed.cmd,
    outcome: "clarification",
    eligibleCount,
    ref: null,
  },
  input.now);
  return { handled: true, reply };
}

async function verdictCommand(
  db: PromotionDb,
  input: ReviewCommandInput,
  parsed: ParsedReviewCommand,
  policy: ReviewPolicy,
  opts: ReviewCommandOptions,
): Promise<ReviewCommandResult> {
  const { principalId, now } = input;
  const cmd = parsed.cmd;
  let ref = parsed.ref ?? null;
  let target: ReviewRefRow | null = null;

  if (ref === null) {
    // Bare approve|reject: accepted ONLY when exactly one eligible pending
    // item exists (§3); snooze always names its ref; else clarify — never
    // a guess.
    const eligible = await eligibleCandidateIds(db, now);
    if (cmd === "snooze" || eligible.length !== 1) {
      return clarificationReply(db, input, parsed, policy, eligible.length);
    }
    ref = await mintReviewRef(
      db,
      { itemType: "candidate", itemId: eligible[0]!, principalId, now },
      { ttlHours: policy.refTtlHours },
    );
    target = await refRowFor(db, principalId, ref);
  } else {
    target = await refRowFor(db, principalId, ref);
  }
  const refCode = ref!;

  // Unknown ref (§6): honest, indistinguishable from never-minted; counts.
  if (target === null) {
    await reviewAudit(db, "imessage.review.bad_ref", { principalId, ref: refCode }, now);
    return { handled: true, reply: REVIEW_UNKNOWN_REF_REPLY };
  }

  // Resolved ref (§5 replay / §6 confusion): honest noop naming the verdict.
  if (target.resolvedAt !== null) {
    await reviewAudit(db, "imessage.control.verdict", {
      principalId,
      command: cmd,
      outcome: "replay",
      replay: true,
      ref: refCode,
      itemId: target.itemId,
      itemType: target.itemType,
      priorResolution: target.resolvedBy,
    },
    now);
    return { handled: true, reply: alreadyHandledReply(refCode, target.resolvedBy ?? "superseded") };
  }

  // Expired-but-unresolved: lazy expiry (§2 TTL) — honest hint, no verdict.
  if (Date.parse(target.expiresAt) <= now.getTime()) {
    await resolveRef(db, target.id, now, "expiry");
    await reviewAudit(db, "imessage.review.expired", { principalId, ref: refCode }, now);
    return { handled: true, reply: REVIEW_EXPIRED_REPLY };
  }

  // Snooze (§3): works on candidates AND escalations; hides, never freezes
  // — the ref still resolves for other verbs; re-snooze resets the clock.
  if (cmd === "snooze") {
    const snoozedUntil = new Date(now.getTime() + policy.snoozeHours * 60 * 60_000);
    const updated = await db.query(
      `UPDATE review_refs
        SET snoozed_until = $2::timestamptz, snooze_count = snooze_count + 1
        WHERE id = $1::uuid AND resolved_at IS NULL
        RETURNING snooze_count`,
      [target.id, snoozedUntil.toISOString()],
    );
    const snoozeCount = Number(updated.rows[0]?.snooze_count ?? 0);
    await reviewAudit(db, "imessage.control.verdict", {
      principalId,
      command: "snooze",
      outcome: "snoozed",
      ref: refCode,
      itemId: target.itemId,
      itemType: target.itemType,
      snoozeCount,
      snoozedUntil: snoozedUntil.toISOString(),
    },
    now);
    return {
      handled: true,
      reply: `Snoozed [${refCode}] for ${policy.snoozeHours}h — it returns to your queue after that.`,
    };
  }

  // Escalation resolution stays CLI until Phase H (§9): snooze-only here.
  if (target.itemType === "escalation") {
    await reviewAudit(db, "imessage.control.verdict", {
      principalId,
      command: cmd,
      outcome: "escalation-not-resolvable",
      ref: refCode,
      itemId: target.itemId,
      itemType: "escalation",
    },
    now);
    return {
      handled: true,
      reply: `Escalations can't be approved or rejected from here yet — snooze [${refCode}] or handle it from the CLI.`,
    };
  }

  // Candidate verdicts through the EXISTING services (§5) — but a
  // candidate that already left in_review (CLI resolved it while the ref
  // stayed live) is an honest replay, never a guess.
  const status = await candidateStatus(db, target.itemId);
  if (status !== "in_review") {
    const resolution =
      status === "promoted" ? "approve" : status === "rejected" ? "reject" : "superseded";
    await resolveRef(db, target.id, now, resolution);
    await reviewAudit(db, "imessage.control.verdict", {
      principalId,
      command: cmd,
      outcome: "replay",
      replay: true,
      ref: refCode,
      itemId: target.itemId,
      itemType: "candidate",
      priorStatus: status,
    },
    now);
    return { handled: true, reply: alreadyHandledReply(refCode, resolution) };
  }

  if (cmd === "approve") {
    if (opts.egressRegistry === undefined) {
      await reviewAudit(db, "imessage.control.verdict", {
        principalId,
        command: "approve",
        outcome: "not-configured",
        ref: refCode,
        itemId: target.itemId,
        itemType: "candidate",
      },
      now);
      return { handled: true, reply: REVIEW_NOT_CONFIGURED_REPLY };
    }
    let outcome: PromotionOutcome;
    try {
      outcome = await approvePromotion(db, target.itemId, {
        egressRegistry: opts.egressRegistry,
        approvedBy: principalId,
        now: () => now,
      });
    } catch (err) {
      await reviewAudit(db, "imessage.review.error", {
        principalId,
        command: "approve",
        ref: refCode,
        itemId: target.itemId,
        error: err instanceof Error ? err.name : "unknown",
      },
      now);
      return { handled: true, reply: REVIEW_FAILED_REPLY };
    }
    const promoted = outcome.action === "promoted";
    // The candidate left in_review either way (the pipeline persists the
    // gate outcome) — resolution is terminal; a hard-gate stop resolves
    // 'superseded' so replay stays honest ("left the review queue").
    await resolveRef(db, target.id, now, promoted ? "approve" : "superseded");
    await reviewAudit(db, "imessage.control.verdict", {
      principalId,
      command: "approve",
      outcome: promoted ? "approved" : "hard-gate-rejected",
      ref: refCode,
      itemId: target.itemId,
      itemType: "candidate",
      action: outcome.action,
      gate: outcome.gate,
      reason: outcome.reason,
      eventId: outcome.eventId,
    },
    now);
    return {
      handled: true,
      reply: promoted
        ? `Approved [${refCode}] — it's now memory.`
        : `Approve didn't land — [${refCode}] was stopped by a hard gate (${outcome.reason ?? outcome.gate ?? "unknown"}).`,
    };
  }

  // reject (§3): discard via the EXISTING service + ONE feedback row — a
  // rejection IS a signal-quality verdict on the queue's surfacing
  // (item_type='review_item', verdict='noise', ESCALATE-3 mapping).
  try {
    await rejectPromotion(db, target.itemId, { rejectedBy: principalId, now: () => now });
  } catch (err) {
    if (/not in_review|concurrently/i.test(String(err))) {
      const nowStatus = await candidateStatus(db, target.itemId);
      const resolution =
        nowStatus === "promoted" ? "approve" : nowStatus === "rejected" ? "reject" : "superseded";
      await resolveRef(db, target.id, now, resolution);
      await reviewAudit(db, "imessage.control.verdict", {
        principalId,
        command: "reject",
        outcome: "replay",
        replay: true,
        ref: refCode,
        itemId: target.itemId,
        itemType: "candidate",
        priorStatus: nowStatus,
      },
      now);
      return { handled: true, reply: alreadyHandledReply(refCode, resolution) };
    }
    await reviewAudit(db, "imessage.review.error", {
      principalId,
      command: "reject",
      ref: refCode,
      itemId: target.itemId,
      error: err instanceof Error ? err.name : "unknown",
    },
    now);
    return { handled: true, reply: REVIEW_FAILED_REPLY };
  }
  const feedback = await recordFeedback(
    db,
    { itemType: "review_item", itemId: target.itemId, verdict: "noise", createdBy: principalId },
    { now: () => now },
  );
  await resolveRef(db, target.id, now, "reject");
  await reviewAudit(db, "imessage.control.verdict", {
    principalId,
    command: "reject",
    outcome: "rejected",
    ref: refCode,
    itemId: target.itemId,
    itemType: "candidate",
    feedbackId: feedback.feedback.id,
    feedbackDeduped: feedback.deduped,
  },
  now);
  return { handled: true, reply: `Rejected [${refCode}] — it won't become memory.` };
}
