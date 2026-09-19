// callModel — the composed model-call service (plan §15 M5): egress gate →
// budget (A13) → dispatch → `model_calls` ledger write. Core sees the
// ModelProvider port only; vendor types stay inside the adapter file
// (ADR-0002). Composition point per plan §9: the egress check runs BEFORE
// any provider dispatch (egressGatedModelProvider, ADR-0012), and a
// `model_calls` row existing implies the check passed for that call.
//
// Ordering: hard-cap denial → egress gate → dispatch. Both denials audit and
// leave the ledger without a traceable call — no dispatch, no row (T12); an
// egress denial after reservation deletes the reservation again.
//
// result_status vocabulary (unconstrained by plan §7; v1 owned here):
//   reserved | ok | ok_budget_warning | error
//
// BUDGET RACE FIX (reservation protocol). The old check-then-insert let N
// parallel calls all read the same sub-cap spend and all dispatch (verifier
// probe: 3 × $1.00 calls against a $1.00 hard cap at $0.99 spent → $3.99).
// Now every call first RESERVES in a short transaction guarded by
// pg_advisory_xact_lock (held only for SUM + INSERT — never across the
// network call):
//
//   1. BEGIN; take the advisory lock; SUM the month's spend (finalized rows
//      + outstanding reservations — monthlyModelSpendUsd). At/over the hard
//      cap: deny + audit (existing path), nothing written.
//   2. Else INSERT a 'reserved' ledger row whose cost_usd is the ENTIRE
//      remaining hard-cap headroom — the call's cost is unknown pre-dispatch,
//      so a reservation conservatively consumes everything left. COMMIT; the
//      lock releases. Consequence: at most ONE call is in flight at a time
//      (no cost forecast exists that would safely admit more), and racers
//      that SUM after the winner's commit see spend ≥ hard and are denied.
//   3. Dispatch OUTSIDE the transaction. On completion UPDATE the
//      reservation with actuals (tokens, real cost, latency, ok |
//      ok_budget_warning); on throw UPDATE to 'error' and rethrow. A crash
//      between reserve and finalize leaves a stale 'reserved' row holding
//      its headroom — fail closed — found by staleReservations() for ops.
//
// Overshoot bound: a call admitted while committed spend < hard may land at
// hard + that one call's cost; nothing further is admitted until the
// reservation is reconciled. That is the tightest guarantee available
// without pre-payment or provider cost quotes.

import type { ModelProvider, ModelRequest, ModelResult } from "@jehad/adapters";
import { EgressDenialError, EgressPolicyError, ModelEgressPolicyRegistry, egressGatedModelProvider } from "../egress/index.js";
import type { SqlExecutor } from "../policy/grants.js";
import { recordAudit } from "../actions/audit.js";
import { type ModelBudget, modelBudgetFromEnv, monthlyModelSpendUsd } from "./budget.js";

export const MODEL_CALL_RESULT_STATUSES = ["reserved", "ok", "ok_budget_warning", "error"] as const;
export type ModelCallResultStatus = (typeof MODEL_CALL_RESULT_STATUSES)[number];

/**
 * Structural slice of pg.Pool — connect() yields a transaction-capable
 * client (same shape as EscalationDb / PromotionDb). The reservation needs
 * one short transaction; everything else runs on the shared executor.
 */
export interface ModelCallDb extends SqlExecutor {
  connect(): Promise<SqlExecutor & { release(): void }>;
}

/** Extended with ledger-only fields the port deliberately omits. */
export interface ModelCallInput extends ModelRequest {
  /** model_calls.prompt_version (plan §7); null when the caller has none. */
  readonly promptVersion?: string;
  /**
   * Attribution for per-principal × per-surface budgets (gateway §5.4):
   * stamped on the model_calls row so windows can police the gateway's
   * spend separately from the global monthly caps. Null on legacy callers.
   */
  readonly principalId?: string | null;
  /** Surface tag, e.g. 'imessage' for gateway conversation turns. */
  readonly surface?: string | null;
}

export interface ModelCallDeps {
  readonly db: ModelCallDb;
  /** The RAW provider; callModel applies the egress gate itself. */
  readonly provider: ModelProvider;
  readonly registry: ModelEgressPolicyRegistry;
  /** Defaults to MODEL_BUDGET_*_USD env caps (A13). */
  readonly budget?: ModelBudget;
}

export interface ModelCallOutcome {
  readonly result: ModelResult;
  readonly resultStatus: ModelCallResultStatus;
  /** Wall-clock dispatch latency of THIS call. */
  readonly latencyMs: number;
  /** Recorded cost of THIS call (USD). */
  readonly costUsd: number;
  /** Calendar-month spend BEFORE this call — the value the caps evaluated. */
  readonly monthSpendUsdBefore: number;
}

/** Structured, auditable hard-cap denial. Carries no prompt content (T4). */
export interface ModelBudgetDenialAudit {
  readonly code: "model.budget.denied";
  /** Effective month spend the cap evaluated: committed rows + in-flight reservations. */
  readonly spentUsd: number;
  readonly softUsd: number;
  readonly hardUsd: number;
  readonly request: {
    readonly runId: string;
    readonly provider: string;
    readonly model: string;
    readonly domainId: string;
    readonly sensitivity: string;
  };
}

export class ModelBudgetExceededError extends Error {
  readonly audit: ModelBudgetDenialAudit;
  constructor(audit: ModelBudgetDenialAudit) {
    super(
      `monthly model budget hard cap reached: spent $${audit.spentUsd} >= $${audit.hardUsd} (A13); dispatch denied`,
    );
    this.name = "ModelBudgetExceededError";
    this.audit = audit;
  }
}

/** The ledger (model_calls.run_id) is NOT NULL — every call must name a run. */
export class MissingRunError extends Error {
  constructor() {
    super("callModel requires request.runId — the model_calls ledger keys every call to a run (plan §7/§14)");
    this.name = "MissingRunError";
  }
}

/**
 * Fixed advisory-lock key for the model-budget reservation ("modelbud" as
 * eight ASCII bytes). One key for all model calls: the caps police a single
 * global monthly SUM, so admission must serialize on one lock.
 */
const MODEL_BUDGET_ADVISORY_LOCK_KEY = 0x6d6f64656c627564n;

function nonNegativeInt(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/** A committed 'reserved' ledger row — the call's claim on the budget. */
interface Reservation {
  readonly id: string;
  /** Calendar-month committed spend BEFORE this reservation (caps read this). */
  readonly monthSpendUsdBefore: number;
}

type BudgetAdmission =
  | { readonly denied: true; readonly spentUsd: number }
  | { readonly denied: false; readonly reservation: Reservation };

/**
 * The race-free admission step: under pg_advisory_xact_lock, SUM the month's
 * spend (finalized + reserved rows) and, under the hard cap, INSERT the
 * reservation row. The lock lives only for this transaction — never across
 * the provider dispatch.
 */
async function reserveBudget(
  db: ModelCallDb,
  input: ModelCallInput,
  budget: ModelBudget,
): Promise<BudgetAdmission> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      String(MODEL_BUDGET_ADVISORY_LOCK_KEY),
    ]);
    const spentUsd = await monthlyModelSpendUsd(client);
    if (spentUsd >= budget.hardUsd) {
      await client.query("ROLLBACK");
      return { denied: true, spentUsd };
    }
    // Cost is unknown pre-dispatch: reserve ALL remaining headroom (rounded
    // UP to the micro-dollar so committed + reserved is never below hard).
    const reservedUsd = Math.ceil((budget.hardUsd - spentUsd) * 1e6) / 1e6;
    const inserted = await client.query(
      `INSERT INTO model_calls
         (run_id, provider, model, prompt_version, in_tokens, out_tokens, cost_usd, latency_ms, result_status,
          principal_id, surface)
       VALUES ($1, $2, $3, $4, 0, 0, $5, 0, 'reserved', $6::uuid, $7)
       RETURNING id::text AS id`,
      [
        input.runId,
        input.provider,
        input.model,
        input.promptVersion ?? null,
        reservedUsd,
        input.principalId ?? null,
        input.surface ?? null,
      ],
    );
    await client.query("COMMIT");
    return {
      denied: false,
      reservation: { id: String(inserted.rows[0]!.id), monthSpendUsdBefore: spentUsd },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Replaces the reservation row's placeholder with the call's actuals. */
async function finalizeReservation(
  db: SqlExecutor,
  reservationId: string,
  fields: {
    inTokens: number;
    outTokens: number;
    costUsd: number;
    latencyMs: number;
    resultStatus: ModelCallResultStatus;
  },
): Promise<void> {
  await db.query(
    `UPDATE model_calls
        SET in_tokens = $2, out_tokens = $3, cost_usd = $4, latency_ms = $5,
            result_status = $6, updated_at = now()
      WHERE id = $1::uuid`,
    [reservationId, fields.inTokens, fields.outTokens, fields.costUsd, fields.latencyMs, fields.resultStatus],
  );
}

/**
 * Removes a reservation for a call that never dispatched (egress denial or
 * wiring error): the ledger invariant "a row exists ⇒ the egress check
 * passed and the provider was invoked" stays true, and the held headroom is
 * released (T12: denials leave the ledger untouched).
 */
async function releaseReservation(db: SqlExecutor, reservationId: string): Promise<void> {
  await db.query("DELETE FROM model_calls WHERE id = $1::uuid", [reservationId]);
}

export async function callModel(deps: ModelCallDeps, input: ModelCallInput): Promise<ModelCallOutcome> {
  if (input.runId === undefined || input.runId.length === 0) throw new MissingRunError();

  const budget = deps.budget ?? modelBudgetFromEnv();

  // Race-free admission (A13): deny + audit BEFORE dispatch; nothing written.
  // spentUsd includes in-flight reservations, so a concurrent winner's
  // committed reservation denies this racer.
  const admission = await reserveBudget(deps.db, input, budget);
  if (admission.denied) {
    const audit: ModelBudgetDenialAudit = {
      code: "model.budget.denied",
      spentUsd: admission.spentUsd,
      softUsd: budget.softUsd,
      hardUsd: budget.hardUsd,
      request: {
        runId: input.runId,
        provider: input.provider,
        model: input.model,
        domainId: input.domainId,
        sensitivity: input.sensitivity,
      },
    };
    await recordAudit(deps.db, {
      actor: "system:model-budget",
      action: "model.budget.denied",
      reversible: false,
      inputsRef: JSON.stringify(audit),
    });
    throw new ModelBudgetExceededError(audit);
  }
  const { reservation } = admission;
  const monthSpendUsdBefore = reservation.monthSpendUsdBefore;
  const overSoftCap = monthSpendUsdBefore >= budget.softUsd;

  // Egress gate composes here (ADR-0012): check resolves storage mode from
  // the domains table and runs BEFORE any dispatch; denials raise
  // EgressDenialError with an auditable payload, provider never invoked.
  const gated = egressGatedModelProvider(deps.provider, deps.registry, deps.db);

  const startedAt = Date.now();
  let result: ModelResult;
  try {
    result = await gated.complete(input);
  } catch (err) {
    if (err instanceof EgressDenialError) {
      // T12: auditable denial, no dispatch, no ledger row (the reservation
      // is released). The audit payload carries domain/sensitivity/provider/
      // model only — no user content.
      await releaseReservation(deps.db, reservation.id);
      await recordAudit(deps.db, {
        actor: "system:model-egress",
        action: "model.egress.denied",
        reversible: false,
        inputsRef: JSON.stringify(err.audit),
      });
      throw err;
    }
    if (err instanceof EgressPolicyError) {
      // Pre-dispatch wiring/config error (e.g. request.provider ≠ provider.id
      // pinning) — nothing was dispatched, so the reservation is released
      // and nothing stays in the ledger.
      await releaseReservation(deps.db, reservation.id);
      throw err;
    }
    // Dispatched and failed: finalize the reservation honestly (tokens/cost
    // unknown → 0, status 'error'), then surface the provider error. The row
    // still proves the gate passed and the provider was invoked.
    const latencyMs = Math.max(0, Date.now() - startedAt);
    await finalizeReservation(deps.db, reservation.id, {
      inTokens: 0,
      outTokens: 0,
      costUsd: 0,
      latencyMs,
      resultStatus: "error",
    });
    throw err;
  }
  const latencyMs = Math.max(0, Date.now() - startedAt);

  const costUsd = result.usage?.costUsd !== undefined && Number.isFinite(result.usage.costUsd) && result.usage.costUsd > 0
    ? result.usage.costUsd
    : 0;
  const resultStatus: ModelCallResultStatus = overSoftCap ? "ok_budget_warning" : "ok";

  await finalizeReservation(deps.db, reservation.id, {
    inTokens: nonNegativeInt(result.usage?.inputTokens),
    outTokens: nonNegativeInt(result.usage?.outputTokens),
    costUsd,
    latencyMs,
    resultStatus,
  });

  if (overSoftCap) {
    await recordAudit(deps.db, {
      actor: "system:model-budget",
      action: "model.budget.warning",
      reversible: false,
      outputsRef: JSON.stringify({
        code: "model.budget.warning",
        spentUsd: monthSpendUsdBefore,
        softUsd: budget.softUsd,
        hardUsd: budget.hardUsd,
        runId: input.runId,
        provider: input.provider,
      }),
    });
  }

  return { result, resultStatus, latencyMs, costUsd, monthSpendUsdBefore };
}
