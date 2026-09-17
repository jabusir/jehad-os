/**
 * ModelProvider port — model calls, egress-gated (plan §4).
 *
 * Source: plan §9 (ModelEgressPolicy; context building calls policy BEFORE
 * provider dispatch), plan §15 M5 (OpenRouter is the first implementation).
 * Defining ADR: ADR-0012 (model/data egress policy enforced before provider
 * dispatch).
 */
import type { Sensitivity } from "./source-adapter.js";

/**
 * Egress policy per plan §9 (shape per review §7; ADR-0012). The question
 * is: may *this data* (domain × sensitivity) leave for *this provider/model*?
 * Policy is data (configuration) — tightening for a future employer is an
 * edit, not a code change.
 */
export interface ModelEgressPolicy {
  readonly domainId: string;
  readonly sensitivity: Sensitivity;
  readonly allowedProviders: readonly string[];
  readonly allowedModels?: readonly string[];
  readonly allowRemote: boolean;
  readonly requireRedaction: boolean;
}

/**
 * A model call request. `domainId` + `sensitivity` are REQUIRED on every
 * request — they select the ModelEgressPolicy consulted before dispatch
 * (ADR-0012). Secrets never enter prompts (AGENTS.md, T4).
 *
 * TODO(at M5): full message/params shape (system prompt, messages array,
 * token/stop controls, structured output).
 */
export interface ModelRequest {
  readonly domainId: string;
  readonly sensitivity: Sensitivity;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  /** Set when the call happens inside a run (model_calls ledger, plan §7/§14). */
  readonly runId?: string;
}

/**
 * TODO(at M5): full result shape (finish reason, raw provider ref, latency).
 * Usage/cost feed the `model_calls` ledger (plan §14).
 */
export interface ModelResult {
  readonly text: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
  };
  readonly providerRef?: string;
}

/**
 * EGRESS GATE — binding contract on every implementation (ADR-0012).
 *
 * preDispatch check, REQUIRED before any provider dispatch:
 * 1. Resolve the applicable `ModelEgressPolicy` for
 *    `request.domainId × request.sensitivity × provider/model`.
 * 2. If that data may not go there — deny by raising; the denial is audited
 *    BEFORE any model call occurs. `secret` sensitivity is never in model
 *    context. Never rely on prompts saying "don't expose this."
 * 3. Honor `allowRemote` (remote-domain content never transits personal
 *    providers — ADR-0010, T15) and `requireRedaction` (redact before
 *    dispatch; concrete redaction machinery lands when a policy first
 *    requires it).
 * 4. Compose with the `call_model:<provider>` capability grant (ADR-0007):
 *    the grant says the run may call a provider; the egress policy says this
 *    data may go there. BOTH must pass.
 *
 * Every `model_calls` row implies the egress-policy check passed.
 */
export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResult>;
}
