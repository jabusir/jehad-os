// callModel — the composed model-call service (plan §15 M5): egress gate →
// budget (A13) → dispatch → `model_calls` ledger write. Core sees the
// ModelProvider port only; vendor types stay inside the adapter file
// (ADR-0002). Composition point per plan §9: the egress check runs BEFORE
// any provider dispatch (egressGatedModelProvider, ADR-0012), and a
// `model_calls` row existing implies the check passed for that call.
//
// Ordering: hard-cap denial → egress gate → dispatch. Both denials audit and
// leave the ledger untouched — no dispatch, no row (T12).
//
// result_status vocabulary (unconstrained by plan §7; v1 owned here):
//   ok | ok_budget_warning | error

import type { ModelProvider, ModelRequest, ModelResult } from "@jehad/adapters";
import { EgressDenialError, EgressPolicyError, ModelEgressPolicyRegistry, egressGatedModelProvider } from "../egress/index.js";
import type { SqlExecutor } from "../policy/grants.js";
import { recordAudit } from "../actions/audit.js";
import { type ModelBudget, modelBudgetFromEnv, monthlyModelSpendUsd } from "./budget.js";

export const MODEL_CALL_RESULT_STATUSES = ["ok", "ok_budget_warning", "error"] as const;
export type ModelCallResultStatus = (typeof MODEL_CALL_RESULT_STATUSES)[number];

/** Extended with ledger-only fields the port deliberately omits. */
export interface ModelCallInput extends ModelRequest {
  /** model_calls.prompt_version (plan §7); null when the caller has none. */
  readonly promptVersion?: string;
}

export interface ModelCallDeps {
  readonly db: SqlExecutor;
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

function nonNegativeInt(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

async function insertModelCall(
  db: SqlExecutor,
  input: ModelCallInput,
  fields: {
    inTokens: number;
    outTokens: number;
    costUsd: number;
    latencyMs: number;
    resultStatus: ModelCallResultStatus;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO model_calls
       (run_id, provider, model, prompt_version, in_tokens, out_tokens, cost_usd, latency_ms, result_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.runId,
      input.provider,
      input.model,
      input.promptVersion ?? null,
      fields.inTokens,
      fields.outTokens,
      fields.costUsd,
      fields.latencyMs,
      fields.resultStatus,
    ],
  );
}

export async function callModel(deps: ModelCallDeps, input: ModelCallInput): Promise<ModelCallOutcome> {
  if (input.runId === undefined || input.runId.length === 0) throw new MissingRunError();

  const budget = deps.budget ?? modelBudgetFromEnv();
  const monthSpendUsdBefore = await monthlyModelSpendUsd(deps.db);

  // A13 hard cap: deny + audit BEFORE dispatch; no ledger row (nothing spent).
  if (monthSpendUsdBefore >= budget.hardUsd) {
    const audit: ModelBudgetDenialAudit = {
      code: "model.budget.denied",
      spentUsd: monthSpendUsdBefore,
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
      // T12: auditable denial, no dispatch, no ledger row. The audit payload
      // carries domain/sensitivity/provider/model only — no user content.
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
      // pinning) — nothing was dispatched, so nothing reaches the ledger.
      throw err;
    }
    // Dispatched and failed: ledger it honestly (tokens/cost unknown → 0),
    // then surface the provider error. The row still proves the gate passed.
    const latencyMs = Math.max(0, Date.now() - startedAt);
    await insertModelCall(deps.db, input, {
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

  await insertModelCall(deps.db, input, {
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
