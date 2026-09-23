// Outcome lifecycle service (roadmap §5; ADR-0017). Canonical state and its
// only writer — the workflow layer executes; this module owns truth.
//
// Rules baked in here:
//  - Creation is confirm-gated upstream (interpreter proposal → deterministic
//    confirm verb / josctl confirm): this service inserts as `accepted` —
//    the `proposed` state exists for future non-interactive flows.
//  - Every transition is CAS-guarded (DB trigger + `WHERE status = old`) and
//    emits its canonical event with provenance.
//  - Waits are canonical rows: creation VALIDATES the predicate against the
//    typed §5.5 vocabulary and refuses non-matchable types (fail closed —
//    never a silent no-op wait); satisfaction is CAS (exactly-once under
//    at-least-once dispatch).
//  - Completion is mechanically gated by the DB trigger (all criteria
//    verified/waived; the verifier-assignment half lands in migration 026).
//  - Refs: mint-once, conversation-addressable (review_refs pattern).
//  - Principal isolation: every read is principal-scoped; a foreign ref is
//    indistinguishable from a nonexistent one.

import { randomUUID } from "node:crypto";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { acceptEvent, type EventStoreExecutor } from "../events/store.js";
import { LATEST_PAYLOAD_SCHEMA_VERSION } from "../events/catalog.js";
import {
  MATCHABLE_PREDICATE_TYPES,
  isOutcomeWaitEventType,
  parseOutcomeWaitPredicate,
  predicateMatchesEvent,
  type OutcomeWaitPredicate,
} from "./predicates.js";

export type OutcomeStatus =
  | "proposed" | "accepted" | "queued" | "running"
  | "waiting_external" | "waiting_user" | "blocked"
  | "verifying" | "completed" | "failed" | "cancelled";

export const OUTCOME_STATUSES: readonly OutcomeStatus[] = [
  "proposed", "accepted", "queued", "running", "waiting_external",
  "waiting_user", "blocked", "verifying", "completed", "failed", "cancelled",
];

export interface OutcomeRow {
  readonly id: string;
  readonly principalId: string;
  readonly ref: string;
  readonly title: string;
  readonly directive: string;
  readonly status: OutcomeStatus;
  readonly constraints: readonly unknown[];
  readonly plan: readonly unknown[];
  readonly budgetUsd: number | null;
  readonly deadlineAt: string | null;
  readonly sourceThreadId: string | null;
  readonly createdBy: string;
  readonly waitingOn: Record<string, unknown> | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OutcomeCriterionInput {
  readonly criterion: string;
  readonly verificationMethod?: Record<string, unknown>;
}

export interface CreateOutcomeInput {
  readonly principalId: string;
  readonly title: string;
  readonly directive: string;
  readonly criteria: readonly OutcomeCriterionInput[];
  readonly constraints?: readonly Record<string, unknown>[];
  readonly budgetUsd?: number;
  readonly deadlineAt?: string;
  readonly sourceThreadId?: string;
  readonly createdBy?: "conversation" | "josctl";
}

export interface OutcomeDb extends EventStoreExecutor, SqlExecutor {}

const OUTCOME_COLUMNS = `
  id, principal_id, ref, title, directive, status, constraints, plan,
  budget_usd, deadline_at, source_thread_id, created_by, waiting_on,
  failure_reason, created_at, updated_at`;

interface OutcomeSqlRow {
  id: string;
  principal_id: string;
  ref: string;
  title: string;
  directive: string;
  status: OutcomeStatus;
  constraints: unknown;
  plan: unknown;
  budget_usd: string | null;
  deadline_at: string | Date | null;
  source_thread_id: string | null;
  created_by: string;
  waiting_on: Record<string, unknown> | null;
  failure_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toOutcome(row: OutcomeSqlRow): OutcomeRow {
  return {
    id: row.id,
    principalId: row.principal_id,
    ref: row.ref,
    title: row.title,
    directive: row.directive,
    status: row.status,
    constraints: Array.isArray(row.constraints) ? row.constraints : [],
    plan: Array.isArray(row.plan) ? row.plan : [],
    budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
    deadlineAt: iso(row.deadline_at),
    sourceThreadId: row.source_thread_id,
    createdBy: row.created_by,
    waitingOn: row.waiting_on,
    failureReason: row.failure_reason,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function audit(db: OutcomeDb, action: string, outputs: Record<string, unknown>, actor: string): Promise<void> {
  // ids/refs/counts only — directives and criteria text live on the rows.
  return recordAudit(db, { actor, action, reversible: true, outputsRef: JSON.stringify(outputs) });
}

// ----------------------------------------------------------------- refs

const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no I/L/O/U

/** Mint-once conversation-addressable code (review_refs pattern). */
async function mintOutcomeRef(db: OutcomeDb): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let ref = "";
    for (let i = 0; i < 3; i += 1) {
      ref += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
    }
    const existing = await db.query("SELECT 1 FROM outcomes WHERE ref = $1 LIMIT 1", [ref]);
    if (existing.rows.length === 0) return ref;
  }
  throw new Error("outcomes: ref space exhausted after 8 attempts");
}

// ----------------------------------------------------------------- create

export interface CreatedOutcome {
  readonly outcome: OutcomeRow;
  readonly criteria: readonly { ordinal: number; criterion: string }[];
}

/**
 * Creates an ACCEPTED outcome (confirm happened upstream) with its
 * first-class criteria rows. At least one criterion is required — an
 * outcome without verifiable criteria cannot honestly complete (ADR-0017).
 */
export async function createOutcome(
  db: OutcomeDb,
  input: CreateOutcomeInput,
  opts: { readonly now: Date; readonly actor: string },
): Promise<CreatedOutcome> {
  if (input.title.trim().length === 0) throw new TypeError("outcomes: title required");
  if (input.directive.trim().length === 0) throw new TypeError("outcomes: directive required");
  if (input.criteria.length === 0) throw new TypeError("outcomes: at least one success criterion required");
  if (input.criteria.length > 12) throw new TypeError("outcomes: at most 12 criteria (keep outcomes honest)");
  for (const c of input.criteria) {
    if (typeof c.criterion !== "string" || c.criterion.trim().length === 0) {
      throw new TypeError("outcomes: criterion text required");
    }
  }
  const id = randomUUID();
  const ref = await mintOutcomeRef(db);
  const created = await db.query(
    `INSERT INTO outcomes (id, principal_id, ref, title, directive, status, constraints, budget_usd, deadline_at, source_thread_id, created_by)
     VALUES ($1, $2::uuid, $3, $4, $5, 'accepted', $6::jsonb, $7, $8::timestamptz, $9::uuid, $10)
     RETURNING ${OUTCOME_COLUMNS}`,
    [
      id, input.principalId, ref, input.title.trim(), input.directive,
      JSON.stringify(input.constraints ?? []),
      input.budgetUsd ?? null,
      input.deadlineAt ?? null,
      input.sourceThreadId ?? null,
      input.createdBy ?? "conversation",
    ],
  );
  const outcome = toOutcome(created.rows[0] as unknown as OutcomeSqlRow);

  const criteria: { ordinal: number; criterion: string }[] = [];
  for (let i = 0; i < input.criteria.length; i += 1) {
    const c = input.criteria[i]!;
    await db.query(
      `INSERT INTO outcome_criteria (id, outcome_id, ordinal, criterion, verification_method)
       VALUES ($1, $2::uuid, $3, $4, $5::jsonb)`,
      [randomUUID(), outcome.id, i + 1, c.criterion.trim(), JSON.stringify(c.verificationMethod ?? {})],
    );
    criteria.push({ ordinal: i + 1, criterion: c.criterion.trim() });
  }

  await acceptEvent(db, {
    type: "outcome.created",
    schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
    source: "internal",
    externalId: `outcome-created:${outcome.id}`,
    occurredAt: opts.now.toISOString(),
    domainId: "personal",
    sensitivity: "normal",
    payload: { outcomeId: outcome.id, ref: outcome.ref, title: outcome.title, criteriaCount: criteria.length, createdBy: outcome.createdBy },
    runId: null,
  }, { now: () => opts.now });
  await acceptEvent(db, {
    type: "outcome.accepted",
    schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
    source: "internal",
    externalId: `outcome-accepted:${outcome.id}`,
    occurredAt: opts.now.toISOString(),
    domainId: "personal",
    sensitivity: "normal",
    payload: { outcomeId: outcome.id, ref: outcome.ref },
    runId: null,
  }, { now: () => opts.now });
  await audit(db, "outcome.created", { outcomeId: outcome.id, ref: outcome.ref, criteria: criteria.length }, opts.actor);
  return { outcome, criteria };
}

// ----------------------------------------------------------------- reads

export async function getOutcomeByRef(db: OutcomeDb, principalId: string, ref: string): Promise<OutcomeRow | null> {
  const result = await db.query(
    `SELECT ${OUTCOME_COLUMNS} FROM outcomes WHERE principal_id = $1::uuid AND ref = $2 LIMIT 1`,
    [principalId, ref],
  );
  const row = result.rows[0] as unknown as OutcomeSqlRow | undefined;
  return row === undefined ? null : toOutcome(row);
}

export async function getOutcomeById(db: OutcomeDb, id: string): Promise<OutcomeRow | null> {
  const result = await db.query(
    `SELECT ${OUTCOME_COLUMNS} FROM outcomes WHERE id = $1::uuid LIMIT 1`,
    [id],
  );
  const row = result.rows[0] as unknown as OutcomeSqlRow | undefined;
  return row === undefined ? null : toOutcome(row);
}

export async function listActiveOutcomes(db: OutcomeDb, principalId: string): Promise<readonly OutcomeRow[]> {
  const result = await db.query(
    `SELECT ${OUTCOME_COLUMNS} FROM outcomes
      WHERE principal_id = $1::uuid AND status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at ASC`,
    [principalId],
  );
  return (result.rows as unknown as OutcomeSqlRow[]).map(toOutcome);
}

export async function listOutcomeCriteria(
  db: OutcomeDb,
  principalId: string,
  outcomeId: string,
): Promise<readonly { ordinal: number; criterion: string; status: string; verifiedAt: string | null }[]> {
  const result = await db.query(
    `SELECT c.ordinal, c.criterion, c.status, c.verified_at FROM outcome_criteria c
      JOIN outcomes o ON o.id = c.outcome_id
      WHERE c.outcome_id = $1::uuid AND o.principal_id = $2::uuid
      ORDER BY c.ordinal ASC`,
    [outcomeId, principalId],
  );
  return (result.rows as { ordinal: number; criterion: string; status: string; verified_at: string | Date | null }[]).map((r) => ({
    ordinal: r.ordinal,
    criterion: r.criterion,
    status: r.status,
    verifiedAt: iso(r.verified_at),
  }));
}

// ----------------------------------------------------------------- transitions

export interface TransitionOutcomeResult {
  readonly outcome: OutcomeRow;
  readonly changed: boolean;
}

/**
 * CAS transition + canonical event. The DB trigger is the authority; the
 * `WHERE status = $old` here keeps concurrent executors exactly-once.
 */
export async function transitionOutcome(
  db: OutcomeDb,
  outcomeId: string,
  toStatus: OutcomeStatus,
  extra: { readonly waitingOn?: Record<string, unknown>; readonly failureReason?: string } = {},
  opts: { readonly now: Date; readonly actor: string },
): Promise<TransitionOutcomeResult> {
  const current = await getOutcomeById(db, outcomeId);
  if (current === null) throw new Error(`outcomes: unknown outcome ${outcomeId}`);
  if (current.status === toStatus) return { outcome: current, changed: false };
  const updated = await db.query(
    `UPDATE outcomes SET
       status = $2,
       waiting_on = $3::jsonb,
       failure_reason = $4,
       updated_at = $5::timestamptz
     WHERE id = $1::uuid AND status = $6
     RETURNING ${OUTCOME_COLUMNS}`,
    [
      outcomeId, toStatus,
      extra.waitingOn ? JSON.stringify(extra.waitingOn) : null,
      extra.failureReason ?? null,
      opts.now.toISOString(),
      current.status,
    ],
  );
  if (updated.rows.length === 0) {
    // Lost a race — re-read and report honestly; the caller re-evaluates.
    const reread = await getOutcomeById(db, outcomeId);
    return { outcome: reread!, changed: false };
  }
  const outcome = toOutcome(updated.rows[0] as unknown as OutcomeSqlRow);
  const eventType =
    toStatus === "completed" ? "outcome.completed"
    : toStatus === "failed" ? "outcome.failed"
    : toStatus === "cancelled" ? "outcome.cancelled"
    : toStatus === "blocked" ? "outcome.blocked"
    : "outcome.status_changed";
  await acceptEvent(db, {
    type: eventType,
    schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
    source: "internal",
    externalId: `outcome-status:${outcome.id}:${current.status}->${toStatus}:${opts.now.toISOString()}`,
    occurredAt: opts.now.toISOString(),
    domainId: "personal",
    sensitivity: "normal",
    payload: { outcomeId: outcome.id, ref: outcome.ref, fromStatus: current.status, toStatus, ...(extra.failureReason !== undefined ? { reason: extra.failureReason } : {}) },
    runId: null,
  }, { now: () => opts.now });
  await audit(db, "outcome.transitioned", { outcomeId: outcome.id, ref: outcome.ref, from: current.status, to: toStatus }, opts.actor);
  return { outcome, changed: true };
}

// ----------------------------------------------------------------- criteria

export async function setCriterionStatus(
  db: OutcomeDb,
  outcomeId: string,
  ordinal: number,
  status: "pending" | "verified" | "unverified" | "failed" | "waived_by_owner",
  opts: {
    readonly now: Date;
    readonly actor: string;
    readonly evidenceRef?: string;
    readonly verifiedByAssignmentId?: string;
  },
): Promise<void> {
  if (status === "verified" && opts.evidenceRef === undefined && opts.verifiedByAssignmentId === undefined) {
    throw new TypeError("outcomes: a verified criterion carries evidence or a verifier assignment");
  }
  const result = await db.query(
    `UPDATE outcome_criteria c SET
       status = $3,
       evidence_ref = COALESCE($4::uuid, c.evidence_ref),
       verified_by_assignment_id = COALESCE($5::uuid, c.verified_by_assignment_id),
       verified_at = CASE WHEN $3 = 'verified' THEN $6::timestamptz ELSE c.verified_at END,
       updated_at = $6::timestamptz
     FROM outcomes o
     WHERE c.outcome_id = o.id AND c.outcome_id = $1::uuid AND c.ordinal = $2
       AND o.status NOT IN ('completed', 'failed', 'cancelled')
     RETURNING c.id, o.ref`,
    [outcomeId, ordinal, status, opts.evidenceRef ?? null, opts.verifiedByAssignmentId ?? null, opts.now.toISOString()],
  );
  if (result.rows.length === 0) throw new Error(`outcomes: criterion ${ordinal} not updatable on ${outcomeId}`);
  const ref = String((result.rows[0] as { ref: string }).ref);
  await acceptEvent(db, {
    type: "outcome.criteria_updated",
    schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
    source: "internal",
    externalId: `outcome-criteria:${outcomeId}:${ordinal}:${status}:${opts.now.toISOString()}`,
    occurredAt: opts.now.toISOString(),
    domainId: "personal",
    sensitivity: "normal",
    payload: { outcomeId, ref, ordinal, status },
    runId: null,
  }, { now: () => opts.now });
  await audit(db, "outcome.criteria_status", { outcomeId, ref, ordinal, status }, opts.actor);
}

// ----------------------------------------------------------------- waits

export interface CreatedWait {
  readonly waitId: string;
  readonly predicate: OutcomeWaitPredicate;
}

/**
 * Creates a durable external wait. The predicate is validated against the
 * typed vocabulary; non-matchable types (absence_past, threshold) are
 * REFUSED for outcome waits until their evaluation lanes exist — a wait the
 * router cannot wake is a silent stall, and silent stalls are lies.
 */
export async function createOutcomeWait(
  db: OutcomeDb,
  outcomeId: string,
  eventType: string,
  predicateRaw: unknown,
  opts: { readonly now: Date; readonly actor: string; readonly expiresAt?: string },
): Promise<CreatedWait> {
  if (!isOutcomeWaitEventType(eventType)) throw new TypeError(`outcomes: unsupported wait event type ${eventType}`);
  const predicate = parseOutcomeWaitPredicate(predicateRaw);
  if (predicate === null) throw new TypeError("outcomes: predicate rejected by the typed vocabulary (§5.5)");
  if (!MATCHABLE_PREDICATE_TYPES.includes(predicate.type)) {
    throw new TypeError(`outcomes: predicate type '${predicate.type}' has no router matcher yet — wait refused (fail closed)`);
  }
  const waitId = randomUUID();
  await db.query(
    `INSERT INTO outcome_waits (id, outcome_id, event_type, predicate, expires_at)
     VALUES ($1, $2::uuid, $3, $4::jsonb, $5::timestamptz)`,
    [waitId, outcomeId, eventType, JSON.stringify(predicate), opts.expiresAt ?? null],
  );
  const outcome = await getOutcomeById(db, outcomeId);
  await acceptEvent(db, {
    type: "outcome.wait_started",
    schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
    source: "internal",
    externalId: `outcome-wait:${waitId}`,
    occurredAt: opts.now.toISOString(),
    domainId: "personal",
    sensitivity: "normal",
    payload: { outcomeId, ref: outcome?.ref ?? null, waitId, eventType, predicate: predicate as unknown as Record<string, unknown> },
    runId: null,
  }, { now: () => opts.now });
  await audit(db, "outcome.wait_started", { outcomeId, waitId, eventType, predicateType: predicate.type }, opts.actor);
  return { waitId, predicate };
}

export interface SatisfiedWait {
  readonly waitId: string;
  readonly outcomeId: string;
}

/**
 * The resume router's core: match one canonical event against WAITING rows
 * of its type; CAS each match waiting→satisfied (exactly-once under
 * at-least-once dispatch); emit wait_satisfied. Returns the satisfied
 * outcome ids for the router to re-signal.
 */
export async function satisfyWaitsForEvent(
  db: OutcomeDb,
  eventType: string,
  payload: Record<string, unknown>,
  opts: { readonly now: Date; readonly actor: string },
): Promise<readonly SatisfiedWait[]> {
  if (!isOutcomeWaitEventType(eventType)) return [];
  const waiting = await db.query(
    `SELECT w.id, w.outcome_id, w.predicate FROM outcome_waits w
      WHERE w.status = 'waiting' AND w.event_type = $1
        AND (w.expires_at IS NULL OR w.expires_at > $2::timestamptz)`,
    [eventType, opts.now.toISOString()],
  );
  const satisfied: SatisfiedWait[] = [];
  for (const row of waiting.rows as { id: string; outcome_id: string; predicate: unknown }[]) {
    const predicate = parseOutcomeWaitPredicate(row.predicate);
    if (predicate === null || !predicateMatchesEvent(predicate, eventType, payload)) continue;
    // CAS: exactly-once satisfaction under at-least-once event dispatch.
    const claimed = await db.query(
      `UPDATE outcome_waits SET status = 'satisfied', satisfied_at = $2::timestamptz
        WHERE id = $1::uuid AND status = 'waiting'
        RETURNING outcome_id`,
      [row.id, opts.now.toISOString()],
    );
    if (claimed.rows.length === 0) continue;
    const outcomeId = String((claimed.rows[0] as { outcome_id: string }).outcome_id);
    const outcome = await getOutcomeById(db, outcomeId);
    await acceptEvent(db, {
      type: "outcome.wait_satisfied",
      schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
      source: "internal",
      externalId: `outcome-wait-satisfied:${row.id}`,
      occurredAt: opts.now.toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      payload: { outcomeId, ref: outcome?.ref ?? null, waitId: row.id, eventType },
      runId: null,
    }, { now: () => opts.now });
    satisfied.push({ waitId: row.id, outcomeId });
  }
  if (satisfied.length > 0) {
    await audit(db, "outcome.waits_satisfied", { eventType, count: satisfied.length }, opts.actor);
  }
  return satisfied;
}
