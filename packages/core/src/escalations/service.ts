/**
 * Escalation service (M6C; plan §13: "review queue: escalations +
 * semantic-promotion approvals, batched"; plan §7 escalations table).
 *
 * Raising an escalation records WHY the system is blocked on a human (the
 * six-cause enum, plan §28), opens the run's human_waits interval (plan §12:
 * human-blocked time is measured from human_waits, never stored), and emits
 * `escalation.raised` (catalog v1) through the event store with source
 * "internal" — state changes of consequence carry provenance. Resolving
 * marks the row resolved, closes the run's open human_waits intervals, and
 * emits `escalation.resolved`. Row + event + wait close commit atomically.
 */

import { UUID_RE } from "../events/envelope.js";
import { acceptEvent } from "../events/store.js";

/** The six escalation causes (plan §28; schema CHECK constraint). */
export const ESCALATION_REASONS = [
  "ambiguous_requirements",
  "approval_required",
  "missing_credentials",
  "architecture_decision",
  "missing_external_information",
  "system_failure",
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

const REASONS = new Set<string>(ESCALATION_REASONS);

export function isEscalationReason(value: unknown): value is EscalationReason {
  return typeof value === "string" && REASONS.has(value);
}

/** Structural slice of pg.Pool — connect() yields a transaction-capable client. */
export interface EscalationDb {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<EscalationTx & { release(): void }>;
}

export interface EscalationTx {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export class InvalidEscalationReasonError extends Error {
  readonly code = "INVALID_ESCALATION_REASON";
  constructor(readonly reason: unknown) {
    super(`escalation reason ${JSON.stringify(reason)} is not one of the six causes (plan §28)`);
    this.name = "InvalidEscalationReasonError";
  }
}

export class EscalationInputError extends Error {
  readonly code = "ESCALATION_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "EscalationInputError";
  }
}

export class RunNotFoundError extends Error {
  readonly code = "RUN_NOT_FOUND";
  constructor(readonly runId: string) {
    super(`run ${runId} does not exist`);
    this.name = "RunNotFoundError";
  }
}

export class EscalationNotFoundError extends Error {
  readonly code = "ESCALATION_NOT_FOUND";
  constructor(readonly escalationId: string) {
    super(`escalation ${escalationId} does not exist`);
    this.name = "EscalationNotFoundError";
  }
}

export class InvalidEscalationStatusError extends Error {
  readonly code = "INVALID_ESCALATION_STATUS";
  constructor(readonly escalationId: string, readonly status: string) {
    super(`escalation ${escalationId} has status "${status}"; only pending/batched can be resolved`);
    this.name = "InvalidEscalationStatusError";
  }
}

export interface RaiseEscalationInput {
  /** The blocked run. Required: escalations.run_id is NOT NULL (schema v1). */
  readonly runId: string;
  readonly reason: EscalationReason;
  readonly urgency?: string | null;
  readonly consequenceOfWaiting?: string | null;
  readonly estHumanMinutes?: number | null;
  readonly blockedRunIds?: readonly string[];
}

export interface EscalationRow {
  readonly id: string;
  readonly runId: string;
  readonly reason: EscalationReason;
  readonly urgency: string | null;
  readonly consequenceOfWaiting: string | null;
  readonly estHumanMinutes: number | null;
  readonly blockedRunIds: readonly string[];
  readonly status: string;
  readonly createdAt: string;
}

export interface RaisedEscalation {
  readonly escalation: EscalationRow;
  /** escalation.raised event id. */
  readonly eventId: string;
  /** human_waits row opened for the blocked run (id), if any. */
  readonly humanWaitId: string;
}

export interface ResolveEscalationInput {
  /** Free-text account of how the escalation was settled. */
  readonly resolution: string;
}

export interface ResolvedEscalation {
  readonly escalation: EscalationRow;
  /** escalation.resolved event id. */
  readonly eventId: string;
  /** Open human_waits rows closed by this resolve. */
  readonly closedHumanWaits: number;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToEscalation(row: Record<string, unknown>): EscalationRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    reason: String(row.reason) as EscalationReason,
    urgency:
      row.urgency === null || row.urgency === undefined ? null : String(row.urgency),
    consequenceOfWaiting:
      row.consequence_of_waiting === null || row.consequence_of_waiting === undefined
        ? null
        : String(row.consequence_of_waiting),
    estHumanMinutes:
      row.est_human_minutes === null || row.est_human_minutes === undefined
        ? null
        : Number(row.est_human_minutes),
    blockedRunIds: Array.isArray(row.blocked_run_ids)
      ? row.blocked_run_ids.map(String)
      : [],
    status: String(row.status),
    createdAt: toIso(row.created_at),
  };
}

function validateRaise(input: RaiseEscalationInput): void {
  if (!UUID_RE.test(input.runId)) {
    throw new EscalationInputError("runId must be a UUID");
  }
  if (input.estHumanMinutes !== undefined && input.estHumanMinutes !== null) {
    if (
      typeof input.estHumanMinutes !== "number" ||
      !Number.isSafeInteger(input.estHumanMinutes) ||
      input.estHumanMinutes < 0
    ) {
      throw new EscalationInputError("estHumanMinutes must be a non-negative integer");
    }
  }
  for (const blocked of input.blockedRunIds ?? []) {
    if (!UUID_RE.test(blocked)) {
      throw new EscalationInputError("blockedRunIds entries must be UUIDs");
    }
  }
}

async function withTransaction<T>(db: EscalationDb, fn: (tx: EscalationTx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const RAISE_SQL = `
  INSERT INTO escalations (run_id, reason, urgency, consequence_of_waiting, blocked_run_ids, est_human_minutes)
  VALUES ($1::uuid, $2, $3, $4, $5::uuid[], $6::int)
  RETURNING id, run_id, reason, urgency, consequence_of_waiting, blocked_run_ids,
            est_human_minutes, status, created_at
`;

/**
 * Raises one escalation: row (status pending) + open human_waits interval +
 * escalation.raised event, atomically. The event carries the full raise
 * context as provenance (source "internal", run_id linked).
 */
export async function raiseEscalation(
  db: EscalationDb,
  input: RaiseEscalationInput,
  opts: { now?: () => Date } = {},
): Promise<RaisedEscalation> {
  if (!isEscalationReason(input.reason)) {
    throw new InvalidEscalationReasonError(input.reason);
  }
  validateRaise(input);
  const now = opts.now?.() ?? new Date();

  return withTransaction(db, async (tx) => {
    const run = await tx.query(
      `SELECT d.key AS domain_key FROM runs r JOIN domains d ON d.id = r.domain_id
       WHERE r.id = $1::uuid`,
      [input.runId],
    );
    const runRow = run.rows[0];
    if (runRow === undefined) throw new RunNotFoundError(input.runId);
    const domainKey = String(runRow.domain_key);

    const inserted = await tx.query(RAISE_SQL, [
      input.runId,
      input.reason,
      input.urgency ?? null,
      input.consequenceOfWaiting ?? null,
      [...(input.blockedRunIds ?? [])],
      input.estHumanMinutes ?? null,
    ]);
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("raiseEscalation: insert returned no row");
    const escalation = rowToEscalation(row);

    // The blocked-on-human clock starts now (plan §12: human_waits intervals).
    const wait = await tx.query(
      `INSERT INTO human_waits (run_id, escalation_id, started_at, reason)
       VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4) RETURNING id`,
      [escalation.runId, escalation.id, now.toISOString(), escalation.reason],
    );
    const waitRow = wait.rows[0];
    if (waitRow === undefined) throw new Error("raiseEscalation: human_waits insert returned no row");
    const humanWaitId = String(waitRow.id);

    const accepted = await acceptEvent(tx, {
      type: "escalation.raised",
      schemaVersion: 1,
      source: "internal",
      externalId: `escalation.raised:${escalation.id}`,
      occurredAt: now.toISOString(),
      domainId: domainKey,
      sensitivity: "normal",
      payload: {
        escalationId: escalation.id,
        runId: escalation.runId,
        reason: escalation.reason,
        urgency: escalation.urgency,
        consequenceOfWaiting: escalation.consequenceOfWaiting,
        estHumanMinutes: escalation.estHumanMinutes,
        blockedRunIds: [...escalation.blockedRunIds],
      },
      runId: escalation.runId,
    });

    return { escalation, eventId: accepted.envelope.id, humanWaitId };
  });
}

const RESOLVE_SQL = `
  UPDATE escalations
  SET status = 'resolved', updated_at = now()
  WHERE id = $1::uuid AND status IN ('pending', 'batched')
  RETURNING id, run_id, reason, urgency, consequence_of_waiting, blocked_run_ids,
            est_human_minutes, status, created_at
`;

/**
 * Resolves one escalation: status resolved + escalation.resolved event +
 * closes every open human_waits row for the linked run (the run is no
 * longer blocked on a human), atomically.
 */
export async function resolveEscalation(
  db: EscalationDb,
  escalationId: string,
  input: ResolveEscalationInput,
  opts: { now?: () => Date } = {},
): Promise<ResolvedEscalation> {
  if (typeof input.resolution !== "string" || input.resolution.trim().length === 0) {
    throw new EscalationInputError("resolution must be a non-empty string");
  }
  if (!UUID_RE.test(escalationId)) {
    throw new EscalationNotFoundError(escalationId);
  }
  const now = opts.now?.() ?? new Date();

  return withTransaction(db, async (tx) => {
    const updated = await tx.query(RESOLVE_SQL, [escalationId]);
    const resolvedRow = updated.rows[0];
    if (resolvedRow === undefined) {
      const existing = await tx.query(
        "SELECT status FROM escalations WHERE id = $1::uuid",
        [escalationId],
      );
      if (existing.rows[0] === undefined) throw new EscalationNotFoundError(escalationId);
      throw new InvalidEscalationStatusError(
        escalationId,
        String(existing.rows[0].status),
      );
    }
    const escalation = rowToEscalation(resolvedRow);

    const run = await tx.query(
      `SELECT d.key AS domain_key FROM runs r JOIN domains d ON d.id = r.domain_id
       WHERE r.id = $1::uuid`,
      [escalation.runId],
    );
    const runRow = run.rows[0];
    if (runRow === undefined) throw new RunNotFoundError(escalation.runId);

    const closed = await tx.query(
      `UPDATE human_waits
       SET resolved_at = $2::timestamptz, updated_at = now()
       WHERE run_id = $1::uuid AND resolved_at IS NULL
       RETURNING id`,
      [escalation.runId, now.toISOString()],
    );

    const accepted = await acceptEvent(tx, {
      type: "escalation.resolved",
      schemaVersion: 1,
      source: "internal",
      externalId: `escalation.resolved:${escalation.id}`,
      occurredAt: now.toISOString(),
      domainId: String(runRow.domain_key),
      sensitivity: "normal",
      payload: {
        escalationId: escalation.id,
        runId: escalation.runId,
        resolution: input.resolution,
      },
      runId: escalation.runId,
    });

    return {
      escalation,
      eventId: accepted.envelope.id,
      closedHumanWaits: closed.rows.length,
    };
  });
}
