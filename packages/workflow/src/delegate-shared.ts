/**
 * Shared delegation seam (W1.2): the ONE canonical path for
 *
 *   canonical Outcome creation → criteria creation → policy checks →
 *   dispatch to the existing outcome-executor
 *
 * used by BOTH `josctl delegate` (CLI) and `POST /ui/delegate` (mobile web).
 * No shell-out, no duplicate policy logic, no web-only outcome path: the
 * source of truth remains the existing Outcome system (`createOutcome` +
 * `acceptEvent` + the WorkflowRuntime port). Dispatch is injected as a port
 * so domain code never touches workflow-vendor SDKs directly.
 *
 * Idempotency (bounded, this route only): the caller supplies a stable
 * `submissionId` (uuid rendered into the form). The first action is an
 * `outcome.delegate_requested` canonical event keyed on
 * `delegate:<principalId>:<submissionId>` — the event store's unique
 * (source, external_id) idempotency means a duplicate HTTP retry CANNOT
 * silently create a second mission: the retry observes accepted=false,
 * recovers the already-created Outcome, and does NOT dispatch again.
 */

import {
  LATEST_PAYLOAD_SCHEMA_VERSION,
  createOutcome,
  idempotencyKeyFor,
  listActiveOutcomes,
  acceptEvent,
  type OutcomeRow,
} from "@jehad/core";

export interface OutcomeDispatchPort {
  start(
    name: "outcome-executor",
    payload: { outcomeId: string; ref: string },
  ): Promise<{ runId: string }>;
}

export interface DelegatedMission {
  readonly outcome: OutcomeRow;
  readonly criteria: readonly { readonly criterion: string }[];
  readonly runId: string | null;
  /** true when this call was a duplicate retry for an already-delegated submission. */
  readonly alreadyRequested: boolean;
}

export interface DelegateFormInput {
  /** "What do you want owned?" — becomes the title (bounded like the CLI). */
  readonly goal: string;
  /** Full directive — required, ≥4 chars like every intake path. */
  readonly directive: string;
  /** "Done means" rows — at least one required; hard-bounded (form renders 4). */
  readonly criteria: readonly string[];
  /** Optional constraint rows; hard-bounded (form renders 4). */
  readonly constraints?: readonly string[];
  /** Optional ISO deadline; malformed/future validation is the caller's contract here. */
  readonly deadlineAt?: string;
  /** Stable per-form-submit id (uuid) — the idempotency key. */
  readonly submissionId: string;
}

const MAX_FORM_CRITERIA = 12;
const MAX_FORM_CONSTRAINTS = 12;
const MAX_FIELD_LENGTH = 2000;

function cleanRows(rows: readonly string[], max: number): string[] {
  const cleaned = rows.map((r) => r.trim()).filter((r) => r.length > 0);
  if (cleaned.length > max) {
    throw new RangeError(`delegate: at most ${max} rows allowed (got ${cleaned.length})`);
  }
  for (const row of cleaned) {
    if (row.length > MAX_FIELD_LENGTH) {
      throw new RangeError(`delegate: row longer than ${MAX_FIELD_LENGTH} chars`);
    }
  }
  return cleaned;
}

export interface CreateAndDispatchOutcomeInput extends DelegateFormInput {
  readonly principalId: string;
  readonly principalName: string;
  readonly policy: {
    readonly enabled: boolean;
    readonly maxActivePerPrincipal: number;
    readonly defaultBudgetUsd: number;
    readonly defaultDeadlineDays: number;
  };
}

/**
 * Canonical create+dispatch for BOTH the CLI and the web delegate form.
 * Caps, budgets, deadline defaults, principal checks, audit and provenance
 * all flow through the existing Outcome service — nothing is bypassed.
 */
export async function createAndDispatchOutcome(
  db: Parameters<typeof createOutcome>[0],
  dispatch: OutcomeDispatchPort,
  input: CreateAndDispatchOutcomeInput,
  opts: { readonly now: Date; readonly actor: string },
): Promise<DelegatedMission> {
  if (!input.policy.enabled) {
    throw new Error("outcomes: delegate intake is disabled by policy (outcomes.enabled)");
  }
  const goal = input.goal.trim();
  const directive = input.directive.trim();
  if (goal.length === 0) throw new TypeError("delegate: goal (what do you want owned?) is required");
  if (directive.length < 4) throw new TypeError("outcomes: directive too short to act on");
  const criteria = cleanRows(input.criteria, MAX_FORM_CRITERIA);
  if (criteria.length === 0) {
    throw new TypeError("delegate: at least one success criterion is required");
  }
  const constraints = cleanRows(input.constraints ?? [], MAX_FORM_CONSTRAINTS);
  const title = goal.length <= 60 ? goal : `${goal.slice(0, 57)}…`;

  // Idempotency FIRST — the event store dedups on (source, externalId).
  const externalId = `delegate:${input.principalId}:${input.submissionId}`;
  const request = await acceptEvent(db, {
    type: "outcome.delegate_requested",
    schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
    source: "jehad-ui",
    externalId,
    occurredAt: opts.now.toISOString(),
    domainId: "personal",
    sensitivity: "normal",
    payload: { submissionId: input.submissionId, criteriaCount: criteria.length },
    runId: null,
  });
  if (!request.accepted) {
    // Duplicate retry: recover the already-created mission, never re-create,
    // never re-dispatch.
    // Recover via the delegate_created marker (it carries the outcomeId).
    const prior = await db.query(
      `SELECT payload->>'outcomeId' AS outcome_id
         FROM events
        WHERE idempotency_key = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [idempotencyKeyFor("jehad-ui", `delegate-created:${externalId}`)],
    );
    const priorId = prior.rows[0] !== undefined ? String(prior.rows[0]!.outcome_id) : null;
    if (priorId !== null) {
      const row = await db.query(`SELECT ${"id, principal_id, ref, title, directive, status, constraints, plan, budget_usd, deadline_at, source_thread_id, created_by, waiting_on, failure_reason, created_at, updated_at"} FROM outcomes WHERE id = $1::uuid`, [priorId]);
      if (row.rows[0] !== undefined) {
        return { outcome: row.rows[0] as unknown as OutcomeRow, criteria: [], runId: null, alreadyRequested: true };
      }
    }
    throw new Error("delegate: duplicate submission and prior outcome not recoverable");
  }

  // Policy cap — same check, same numbers as the CLI intake path.
  const active = await listActiveOutcomes(db, input.principalId);
  if (active.length >= input.policy.maxActivePerPrincipal) {
    throw new Error(
      `outcomes: ${active.length} active outcomes already at the policy cap (${input.policy.maxActivePerPrincipal}) — resolve or raise the cap`,
    );
  }

  const deadline =
    input.deadlineAt !== undefined && input.deadlineAt.trim().length > 0
      ? input.deadlineAt
      : new Date(opts.now.getTime() + input.policy.defaultDeadlineDays * 86_400_000).toISOString();

  const created = await createOutcome(
    db,
    {
      principalId: input.principalId,
      title,
      directive,
      criteria: criteria.map((criterion) => ({
        criterion,
        verificationMethod: { kind: "owner_judgment" },
      })),
      constraints: constraints.map((text) => ({ text })),
      budgetUsd: input.policy.defaultBudgetUsd,
      deadlineAt: deadline,
      createdBy: "josctl",
    },
    opts,
  );

  // Link the idempotency event to the created mission (best-effort provenance;
  // the retry path above tolerates its absence by refusing rather than guessing).
  await acceptEvent(db, {
    type: "outcome.delegate_created",
    schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
    source: "jehad-ui",
    externalId: `delegate-created:${externalId}`,
    occurredAt: opts.now.toISOString(),
    domainId: "personal",
    sensitivity: "normal",
    payload: { submissionId: input.submissionId, outcomeId: created.outcome.id, ref: created.outcome.ref },
    runId: null,
  });

  const handle = await dispatch.start("outcome-executor", {
    outcomeId: created.outcome.id,
    ref: created.outcome.ref,
  });
  return { outcome: created.outcome, criteria: created.criteria, runId: handle.runId, alreadyRequested: false };
}
