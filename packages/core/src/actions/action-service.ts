// ActionService — external action intent/attempt/outcome semantics
// (ADR-0011; policy-model.md §5; plan §9; threat T13). State ownership
// (cleanup §5 — exactly one canonical owner per state):
//
//   ActionIntent.status  owns  proposed → approved → prepared | cancelled
//   ActionAttempt.outcome owns executing → succeeded | failed | unknown
//                                                unknown → reconciled
//
// The intent NEVER holds an execution state: dispatching inserts an attempt
// with outcome 'executing' and leaves the intent 'prepared'. One intent may
// have many attempts; retries and reconciliation append rows — an earlier
// ambiguous attempt's history is never overwritten. A pre-effect audit entry
// records intent, never completion; after a lost response the honest outcome
// is 'unknown' until reconciliation records the provider ref.

import { randomUUID } from "node:crypto";
import {
  ProviderResponseLostError,
  type ActionProvider,
} from "@jehad/adapters";
import { recordAudit, type SqlExecutor } from "./audit.js";
import {
  assertAllowedByCeiling,
  resolveAutonomyPolicy,
  type AutonomyPolicy,
  type ExternalActionType,
} from "./autonomy.js";
import { verifyGrant, type GrantDenialReason } from "../policy/grants.js";

export type IntentStatus = "proposed" | "approved" | "prepared" | "cancelled";

export type AttemptOutcome =
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "reconciled";

export type RecordedOutcome = "succeeded" | "failed" | "unknown";

export interface ActionIntentRecord {
  id: string;
  runId: string;
  grantId: string | null;
  capability: string;
  resource: string;
  domainId: string;
  payload: unknown;
  status: IntentStatus;
}

export interface ActionAttemptRecord {
  id: string;
  intentId: string;
  provider: string;
  idempotencyKey: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: AttemptOutcome;
  providerRef: string | null;
  error: string | null;
}

export class IntentNotFoundError extends Error {
  constructor(intentId: string) {
    super(`action intent ${intentId} not found`);
    this.name = "IntentNotFoundError";
  }
}

export class AttemptNotFoundError extends Error {
  constructor(attemptId: string) {
    super(`action attempt ${attemptId} not found`);
    this.name = "AttemptNotFoundError";
  }
}

export class InvalidIntentTransitionError extends Error {
  constructor(intentId: string, from: IntentStatus, to: string) {
    super(
      `invalid intent transition for ${intentId}: '${from}' → '${to}' ` +
        "(intent states are proposed → approved → prepared | cancelled; " +
        "execution states live on the attempt)",
    );
    this.name = "InvalidIntentTransitionError";
  }
}

export class InvalidAttemptTransitionError extends Error {
  constructor(attemptId: string, from: AttemptOutcome, to: string) {
    super(`invalid attempt transition for ${attemptId}: '${from}' → '${to}'`);
    this.name = "InvalidAttemptTransitionError";
  }
}

/**
 * Raised when an outcome that certifies an observed effect (`succeeded`, and
 * reconciliation's `reconciled`) is recorded without a non-empty providerRef
 * — the audit trail must never claim an effect it cannot point at (T13).
 */
export class MissingProviderRefError extends Error {
  constructor(attemptId: string, operation: string) {
    super(`${operation} requires a non-empty providerRef (attempt ${attemptId})`);
    this.name = "MissingProviderRefError";
  }
}

/** Raised when startAttempt's capability token fails grant verification (M4). */
export class GrantDeniedError extends Error {
  readonly reason: GrantDenialReason;
  constructor(intentId: string, reason: GrantDenialReason) {
    super(`grant possession denied for intent ${intentId}: ${reason}`);
    this.name = "GrantDeniedError";
    this.reason = reason;
  }
}

export interface CreateIntentInput {
  runId: string;
  actionType: ExternalActionType;
  capability: string;
  resource: string;
  domainId: string;
  payload?: unknown;
  actor: string;
}

export interface IntentRef {
  intentId: string;
  actor: string;
}

export interface RecordOutcomeInput extends IntentRef {
  attemptId: string;
  outcome: RecordedOutcome;
  providerRef?: string;
  error?: string;
}

export interface ReconcileInput extends IntentRef {
  attemptId: string;
  providerRef: string;
}

/**
 * Dispatch input: possession of a capability grant is REQUIRED (plan §15 M4).
 * `grantToken` is the opaque token minted by issueGrant; `principalId` is the
 * authenticated principal presenting it.
 */
export interface StartAttemptInput extends IntentRef {
  grantToken: string;
  principalId: string;
}

export interface ActionServiceOptions {
  /**
   * Explicit policy override (tests / operator pinning). When omitted, the
   * service loads the ceiling from policy.yaml (default repo-root path or
   * `policyPath`); the hardcoded V1 constant is only a missing-file fallback.
   */
  policy?: AutonomyPolicy;
  /** Overrides the default policy.yaml path (tests). */
  policyPath?: string;
}

const INTENT_COLUMNS =
  "id, run_id, grant_id, capability, resource, domain_id, payload, status";

const ATTEMPT_COLUMNS =
  "id, intent_id, provider, idempotency_key, started_at, finished_at, outcome, provider_ref, error";

function toIntent(row: Record<string, unknown>): ActionIntentRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    grantId: row.grant_id === null || row.grant_id === undefined ? null : String(row.grant_id),
    capability: String(row.capability),
    resource: String(row.resource),
    domainId: String(row.domain_id),
    payload: row.payload ?? null,
    status: row.status as IntentStatus,
  };
}

function toAttempt(row: Record<string, unknown>): ActionAttemptRecord {
  return {
    id: String(row.id),
    intentId: String(row.intent_id),
    provider: String(row.provider),
    idempotencyKey:
      row.idempotency_key === null || row.idempotency_key === undefined
        ? null
        : String(row.idempotency_key),
    startedAt: row.started_at as Date,
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : (row.finished_at as Date),
    outcome: row.outcome as AttemptOutcome,
    providerRef:
      row.provider_ref === null || row.provider_ref === undefined
        ? null
        : String(row.provider_ref),
    error: row.error === null || row.error === undefined ? null : String(row.error),
  };
}

function jsonRef(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export class ActionService {
  private readonly db: SqlExecutor;
  private readonly provider: ActionProvider;
  private readonly explicitPolicy: AutonomyPolicy | undefined;
  private readonly policyPath: string | undefined;
  private policyLoad: Promise<AutonomyPolicy> | undefined;

  constructor(db: SqlExecutor, provider: ActionProvider, options: ActionServiceOptions = {}) {
    this.db = db;
    this.provider = provider;
    this.explicitPolicy = options.policy;
    this.policyPath = options.policyPath;
  }

  /**
   * ADR-0003: policy.yaml is the single source of the ceiling. Explicit
   * policy wins; otherwise load the file (fallback constant + warning only
   * when the file is missing — autonomy.test.ts pins file == fallback).
   */
  private resolvePolicy(): Promise<AutonomyPolicy> {
    if (this.explicitPolicy !== undefined) return Promise.resolve(this.explicitPolicy);
    this.policyLoad ??= resolveAutonomyPolicy(this.policyPath);
    return this.policyLoad;
  }

  async createIntent(input: CreateIntentInput): Promise<ActionIntentRecord> {
    try {
      assertAllowedByCeiling(await this.resolvePolicy(), input.actionType);
    } catch (err) {
      await recordAudit(this.db, {
        actor: input.actor,
        action: "action.intent.denied",
        reversible: true,
        outputsRef: jsonRef({ reason: "prohibited_by_autonomy_ceiling", actionType: input.actionType }),
      });
      throw err;
    }
    const result = await this.db.query(
      `INSERT INTO action_intents (run_id, capability, resource, domain_id, payload, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'proposed')
       RETURNING ${INTENT_COLUMNS}`,
      [
        input.runId,
        input.capability,
        input.resource,
        input.domainId,
        jsonRef(input.payload),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("createIntent: no row returned");
    const intent = toIntent(row);
    await recordAudit(this.db, {
      actor: input.actor,
      action: "action.intent.proposed",
      reversible: true,
      intentId: intent.id,
      inputsRef: jsonRef({ actionType: input.actionType, capability: intent.capability, resource: intent.resource }),
    });
    return intent;
  }

  async approveIntent(ref: IntentRef): Promise<ActionIntentRecord> {
    const intent = await this.transitionIntent(ref, {
      from: "proposed",
      to: "approved",
      audit: "action.intent.approved",
    });
    return intent;
  }

  async prepareIntent(ref: IntentRef): Promise<ActionIntentRecord> {
    return this.transitionIntent(ref, {
      from: "approved",
      to: "prepared",
      audit: "action.intent.prepared",
    });
  }

  async cancelIntent(ref: IntentRef): Promise<ActionIntentRecord> {
    const current = await this.getIntent(ref.intentId);
    if (current.status !== "proposed" && current.status !== "approved") {
      throw new InvalidIntentTransitionError(ref.intentId, current.status, "cancelled");
    }
    const result = await this.db.query(
      `UPDATE action_intents
       SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND status = $2
       RETURNING ${INTENT_COLUMNS}`,
      [ref.intentId, current.status],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InvalidIntentTransitionError(ref.intentId, current.status, "cancelled");
    }
    const intent = toIntent(row);
    await recordAudit(this.db, {
      actor: ref.actor,
      action: "action.intent.cancelled",
      reversible: true,
      intentId: intent.id,
    });
    return intent;
  }

  async getIntent(intentId: string): Promise<ActionIntentRecord> {
    const result = await this.db.query(
      `SELECT ${INTENT_COLUMNS} FROM action_intents WHERE id = $1`,
      [intentId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new IntentNotFoundError(intentId);
    return toIntent(row);
  }

  async listAttempts(intentId: string): Promise<ActionAttemptRecord[]> {
    const result = await this.db.query(
      `SELECT ${ATTEMPT_COLUMNS} FROM action_attempts
       WHERE intent_id = $1 ORDER BY started_at ASC`,
      [intentId],
    );
    return result.rows.map(toAttempt);
  }

  /**
   * Dispatch a new attempt of a prepared intent. Grant possession (plan §15
   * M4) is verified BEFORE anything is written or dispatched: the presented
   * capability token must resolve to a live grant for
   * (principalId, `act:<provider>`, resource, domainId); a denial is a typed
   * error plus an audit row, and no attempt row is created. On success the
   * attempt row is appended (outcome 'executing') — the intent itself never
   * enters an execution state. Writes the pre-effect audit entry (intent
   * only — it proves intent, never completion), calls the provider, then
   * records the observed outcome. A lost provider response yields outcome
   * 'unknown'.
   */
  async startAttempt(input: StartAttemptInput): Promise<ActionAttemptRecord> {
    const intent = await this.getIntent(input.intentId);
    if (intent.status !== "prepared") {
      throw new InvalidIntentTransitionError(input.intentId, intent.status, "executing");
    }
    const capability = `act:${this.provider.id}`;
    const decision = await verifyGrant(this.db, input.grantToken ?? "", {
      principalId: input.principalId,
      capability,
      resource: intent.resource,
      domainId: intent.domainId,
    });
    if (!decision.allowed) {
      await recordAudit(this.db, {
        actor: input.actor,
        action: "action.attempt.grant_denied",
        reversible: true,
        intentId: intent.id,
        outputsRef: jsonRef({ reason: decision.reason, capability, resource: intent.resource }),
      });
      throw new GrantDeniedError(intent.id, decision.reason);
    }
    await this.db.query(
      `UPDATE action_intents
       SET grant_id = $2, updated_at = now()
       WHERE id = $1 AND grant_id IS NULL`,
      [intent.id, decision.grant.id],
    );
    const history = await this.listAttempts(intent.id);
    const idempotencyKey =
      history[0]?.idempotencyKey ?? `idem_${randomUUID()}`;
    const now = new Date();
    const lastStarted = history[history.length - 1]?.startedAt;
    const startedAt =
      lastStarted !== undefined && lastStarted.getTime() >= now.getTime()
        ? new Date(lastStarted.getTime() + 1)
        : now;

    const inserted = await this.db.query(
      `INSERT INTO action_attempts (intent_id, provider, idempotency_key, started_at, outcome)
       VALUES ($1, $2, $3, $4, 'executing')
       RETURNING ${ATTEMPT_COLUMNS}`,
      [intent.id, this.provider.id, idempotencyKey, startedAt],
    );
    const insertRow = inserted.rows[0];
    if (insertRow === undefined) throw new Error("startAttempt: no row returned");
    const attempt = toAttempt(insertRow);

    // Pre-effect entry: intent only, no attempt reference, no outcome claim.
    await recordAudit(this.db, {
      actor: input.actor,
      action: "action.attempt.pre_effect",
      reversible: false,
      intentId: intent.id,
      inputsRef: jsonRef({
        capability: intent.capability,
        resource: intent.resource,
        payload: intent.payload,
        idempotencyKey,
        attemptId: attempt.id,
      }),
    });

    try {
      const response = await this.provider.dispatch({
        intentId: intent.id,
        capability: intent.capability,
        resource: intent.resource,
        payload: intent.payload,
        idempotencyKey,
      });
      return await this.recordOutcome({
        intentId: intent.id,
        actor: input.actor,
        attemptId: attempt.id,
        outcome: response.status === "succeeded" ? "succeeded" : "failed",
        providerRef: response.providerRef,
        error: response.error,
      });
    } catch (err) {
      if (err instanceof ProviderResponseLostError) {
        return await this.recordOutcome({
          intentId: intent.id,
          actor: input.actor,
          attemptId: attempt.id,
          outcome: "unknown",
          error: err.message,
        });
      }
      return await this.recordOutcome({
        intentId: intent.id,
        actor: input.actor,
        attemptId: attempt.id,
        outcome: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** executing → succeeded | failed | unknown. Terminal outcomes are immutable. */
  async recordOutcome(input: RecordOutcomeInput): Promise<ActionAttemptRecord> {
    // T13 honesty rule: a `succeeded` outcome certifies an observed effect —
    // it must point at the provider's own reference for that effect.
    if (input.outcome === "succeeded" && (typeof input.providerRef !== "string" || input.providerRef.length === 0)) {
      throw new MissingProviderRefError(input.attemptId, "recordOutcome(outcome='succeeded')");
    }
    const result = await this.db.query(
      `UPDATE action_attempts
       SET outcome = $2, provider_ref = $3, error = $4, finished_at = now(), updated_at = now()
       WHERE id = $1 AND outcome = 'executing'
       RETURNING ${ATTEMPT_COLUMNS}`,
      [
        input.attemptId,
        input.outcome,
        input.providerRef ?? null,
        input.error ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      const current = await this.getAttempt(input.attemptId);
      throw new InvalidAttemptTransitionError(input.attemptId, current.outcome, input.outcome);
    }
    const attempt = toAttempt(row);
    await recordAudit(this.db, {
      actor: input.actor,
      action: "action.attempt.outcome",
      reversible: false,
      intentId: input.intentId,
      attemptId: attempt.id,
      outputsRef: jsonRef({
        outcome: attempt.outcome,
        providerRef: attempt.providerRef,
        error: attempt.error,
      }),
    });
    return attempt;
  }

  /** unknown → reconciled: the reconciliation workflow records the provider ref. */
  async reconcileAttempt(input: ReconcileInput): Promise<ActionAttemptRecord> {
    // Reconciliation resolves an ambiguous effect by NAMING it — an empty
    // ref would make 'reconciled' an unbacked success claim (T13).
    if (typeof input.providerRef !== "string" || input.providerRef.trim().length === 0) {
      throw new MissingProviderRefError(input.attemptId, "reconcileAttempt");
    }
    const result = await this.db.query(
      `UPDATE action_attempts
       SET outcome = 'reconciled', provider_ref = $2, error = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1 AND outcome = 'unknown'
       RETURNING ${ATTEMPT_COLUMNS}`,
      [input.attemptId, input.providerRef],
    );
    const row = result.rows[0];
    if (row === undefined) {
      const current = await this.getAttempt(input.attemptId);
      throw new InvalidAttemptTransitionError(input.attemptId, current.outcome, "reconciled");
    }
    const attempt = toAttempt(row);
    await recordAudit(this.db, {
      actor: input.actor,
      action: "action.attempt.reconciled",
      reversible: false,
      intentId: input.intentId,
      attemptId: attempt.id,
      outputsRef: jsonRef({ providerRef: attempt.providerRef, resolvedFrom: "unknown" }),
    });
    return attempt;
  }

  private async transitionIntent(
    ref: IntentRef,
    step: { from: IntentStatus; to: IntentStatus; audit: string },
  ): Promise<ActionIntentRecord> {
    const current = await this.getIntent(ref.intentId);
    if (current.status !== step.from) {
      throw new InvalidIntentTransitionError(ref.intentId, current.status, step.to);
    }
    const result = await this.db.query(
      `UPDATE action_intents
       SET status = $2, updated_at = now()
       WHERE id = $1 AND status = $3
       RETURNING ${INTENT_COLUMNS}`,
      [ref.intentId, step.to, step.from],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InvalidIntentTransitionError(ref.intentId, current.status, step.to);
    }
    const intent = toIntent(row);
    await recordAudit(this.db, {
      actor: ref.actor,
      action: step.audit,
      reversible: true,
      intentId: intent.id,
    });
    return intent;
  }

  private async getAttempt(attemptId: string): Promise<ActionAttemptRecord> {
    const result = await this.db.query(
      `SELECT ${ATTEMPT_COLUMNS} FROM action_attempts WHERE id = $1`,
      [attemptId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AttemptNotFoundError(attemptId);
    return toAttempt(row);
  }
}
