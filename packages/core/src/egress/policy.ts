/**
 * Model/data egress policy — registry + pre-dispatch check (ADR-0012;
 * plan §9; docs/policy-model.md §6; T12).
 *
 * The question is never "can this run call an LLM?" but: may THIS data
 * (domain × sensitivity) leave for THIS provider/model? The check runs
 * BEFORE any provider dispatch; a denial raises with an auditable reason
 * and no model call occurs. `secret` sensitivity is never in model context
 * regardless of configuration — that is a code invariant, not a rule.
 *
 * Policy is data (`egress-policy.yaml`); this module only evaluates it.
 * Deny by default: no matching rule → denied.
 */

import type { ModelProvider, ModelRequest, ModelResult, Sensitivity } from "@jehad/adapters";
import type { SqlExecutor } from "../policy/grants.js";

export type { Sensitivity };

/** Storage mode of the data's domain (ADR-0010); consulted for allowRemote. */
export type StorageMode = "local" | "remote" | "federated" | "opaque";

/**
 * What is being asked: may data with this domainId/sensitivity go to this
 * provider/model? `storageMode` lets the check honor `allowRemote` —
 * remote-domain content never transits personal providers (T15). The gated
 * provider (`egressGatedModelProvider`) resolves it from the domains table
 * on every request; callers cannot opt out of the check.
 */
export interface EgressCheckContext {
  readonly domainId: string;
  readonly sensitivity: Sensitivity;
  readonly provider: string;
  readonly model?: string;
  readonly storageMode?: StorageMode;
}

/** One policy rule; mirrors `ModelEgressPolicy` (adapters) plus id/wildcards. */
export interface EgressPolicyRule {
  readonly id: string;
  /** Domain key, or "*" for any. */
  readonly domainId: string;
  /** normal | sensitive | secret, or "*" for any. */
  readonly sensitivity: Sensitivity | "*";
  readonly allowedProviders: readonly string[];
  readonly allowedModels?: readonly string[];
  readonly allowRemote: boolean;
  readonly requireRedaction: boolean;
}

export type EgressDenialReason =
  | "secret_never_in_model_context"
  | "no_matching_rule"
  | "provider_not_allowed"
  | "model_not_allowed"
  | "model_required_by_policy"
  | "remote_content_forbidden"
  | "unknown_domain";

export type EgressDecision =
  | { readonly allowed: true; readonly ruleId: string; readonly requireRedaction: boolean }
  | {
      readonly allowed: false;
      readonly reason: EgressDenialReason;
      readonly ruleId?: string;
      readonly message: string;
    };

/** Structured, auditable denial payload. Carries no user content (T4). */
export interface EgressDenialAudit {
  readonly code: "egress.denied";
  readonly reason: EgressDenialReason;
  readonly ruleId?: string;
  readonly request: { readonly domainId: string; readonly sensitivity: Sensitivity; readonly provider: string; readonly model?: string };
  readonly message: string;
}

/** Raised by `assertAllowed` on denial — before any provider dispatch. */
export class EgressDenialError extends Error {
  readonly audit: EgressDenialAudit;
  constructor(audit: EgressDenialAudit) {
    super(audit.message);
    this.name = "EgressDenialError";
    this.audit = audit;
  }
}

/** Raised for malformed/contradictory policy configuration — fail closed. */
export class EgressPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressPolicyError";
  }
}

const DENIAL_MESSAGES: Record<EgressDenialReason, (ctx: EgressCheckContext) => string> = {
  secret_never_in_model_context: (ctx) => `secret sensitivity is never allowed in model context (domain=${ctx.domainId})`,
  no_matching_rule: (ctx) => `no egress policy rule matches domain=${ctx.domainId} sensitivity=${ctx.sensitivity} (deny by default)`,
  provider_not_allowed: (ctx) => `provider "${ctx.provider}" is not allowed for domain=${ctx.domainId} sensitivity=${ctx.sensitivity}`,
  model_not_allowed: (ctx) => `model "${ctx.model}" is not allowed for domain=${ctx.domainId} sensitivity=${ctx.sensitivity}`,
  model_required_by_policy: (ctx) => `policy constrains models for domain=${ctx.domainId} sensitivity=${ctx.sensitivity} but the request names no model`,
  remote_content_forbidden: (ctx) => `remote-domain content (mode=${ctx.storageMode}) may not transit provider "${ctx.provider}" (allowRemote=false)`,
  unknown_domain: (ctx) => `domain "${ctx.domainId}" is not registered; egress denied by default (fail closed)`,
};

function validateContext(ctx: EgressCheckContext): void {
  if (typeof ctx.domainId !== "string" || ctx.domainId.length === 0) throw new EgressPolicyError("egress check requires a non-empty domainId");
  if (typeof ctx.provider !== "string" || ctx.provider.length === 0) throw new EgressPolicyError("egress check requires a non-empty provider");
  if (ctx.sensitivity !== "normal" && ctx.sensitivity !== "sensitive" && ctx.sensitivity !== "secret") {
    throw new EgressPolicyError(`egress check received invalid sensitivity "${String(ctx.sensitivity)}"`);
  }
}

/** Registry of egress rules; evaluates checks. Immutable once constructed. */
export class ModelEgressPolicyRegistry {
  readonly rules: readonly EgressPolicyRule[];

  constructor(rules: readonly EgressPolicyRule[]) {
    ModelEgressPolicyRegistry.validateRules(rules);
    this.rules = rules;
  }

  private static validateRules(rules: readonly EgressPolicyRule[]): void {
    const seen = new Set<string>();
    for (const rule of rules) {
      if (!rule.id || seen.has(rule.id)) throw new EgressPolicyError(`egress rule id must be non-empty and unique (got "${rule.id}")`);
      seen.add(rule.id);
      if (typeof rule.domainId !== "string" || rule.domainId.length === 0) throw new EgressPolicyError(`rule ${rule.id}: domainId must be a non-empty string or "*"`);
      if (rule.sensitivity !== "normal" && rule.sensitivity !== "sensitive" && rule.sensitivity !== "secret" && rule.sensitivity !== "*") {
        throw new EgressPolicyError(`rule ${rule.id}: invalid sensitivity "${String(rule.sensitivity)}"`);
      }
      if (!Array.isArray(rule.allowedProviders) || rule.allowedProviders.some((p) => typeof p !== "string" || p.length === 0)) {
        throw new EgressPolicyError(`rule ${rule.id}: allowedProviders must be an array of non-empty strings`);
      }
      if (rule.allowedModels !== undefined && (!Array.isArray(rule.allowedModels) || rule.allowedModels.some((m) => typeof m !== "string" || m.length === 0))) {
        throw new EgressPolicyError(`rule ${rule.id}: allowedModels must be an array of non-empty strings when present`);
      }
      if (typeof rule.allowRemote !== "boolean") throw new EgressPolicyError(`rule ${rule.id}: allowRemote must be boolean`);
      if (typeof rule.requireRedaction !== "boolean") throw new EgressPolicyError(`rule ${rule.id}: requireRedaction must be boolean`);
    }
  }

  /** Most-specific matching rule: exact domain + exact sensitivity wins. */
  private match(domainId: string, sensitivity: Sensitivity): EgressPolicyRule | undefined {
    let best: EgressPolicyRule | undefined;
    let bestScore = -1;
    for (const rule of this.rules) {
      const domainExact = rule.domainId === domainId;
      const domainMatch = domainExact || rule.domainId === "*";
      const sensExact = rule.sensitivity === sensitivity;
      const sensMatch = sensExact || rule.sensitivity === "*";
      if (!domainMatch || !sensMatch) continue;
      const score = (domainExact ? 2 : 0) + (sensExact ? 1 : 0);
      if (score > bestScore) {
        best = rule;
        bestScore = score;
      }
    }
    return best;
  }

  /** Pure decision; never throws for policy outcomes (only bad input). */
  check(ctx: EgressCheckContext): EgressDecision {
    validateContext(ctx);
    // Code invariant (T4/ADR-0012): secret is never in model context, even if
    // a misconfigured rule would allow it.
    if (ctx.sensitivity === "secret") {
      return { allowed: false, reason: "secret_never_in_model_context", message: DENIAL_MESSAGES.secret_never_in_model_context(ctx) };
    }
    const rule = this.match(ctx.domainId, ctx.sensitivity);
    if (!rule) return { allowed: false, reason: "no_matching_rule", message: DENIAL_MESSAGES.no_matching_rule(ctx) };
    if (!rule.allowedProviders.includes(ctx.provider)) {
      return { allowed: false, reason: "provider_not_allowed", ruleId: rule.id, message: DENIAL_MESSAGES.provider_not_allowed(ctx) };
    }
    if (rule.allowedModels !== undefined) {
      if (ctx.model === undefined) {
        return { allowed: false, reason: "model_required_by_policy", ruleId: rule.id, message: DENIAL_MESSAGES.model_required_by_policy(ctx) };
      }
      if (!rule.allowedModels.includes(ctx.model)) {
        return { allowed: false, reason: "model_not_allowed", ruleId: rule.id, message: DENIAL_MESSAGES.model_not_allowed(ctx) };
      }
    }
    if (ctx.storageMode !== undefined && ctx.storageMode !== "local" && !rule.allowRemote) {
      return { allowed: false, reason: "remote_content_forbidden", ruleId: rule.id, message: DENIAL_MESSAGES.remote_content_forbidden(ctx) };
    }
    return { allowed: true, ruleId: rule.id, requireRedaction: rule.requireRedaction };
  }

  /** Decision or raise — the pre-dispatch gate. Denials are auditable. */
  assertAllowed(ctx: EgressCheckContext): EgressDecision {
    const decision = this.check(ctx);
    if (!decision.allowed) {
      const { reason, ruleId, message } = decision;
      throw new EgressDenialError({
        code: "egress.denied",
        reason,
        ruleId,
        request: { domainId: ctx.domainId, sensitivity: ctx.sensitivity, provider: ctx.provider, model: ctx.model },
        message,
      });
    }
    return decision;
  }
}

/**
 * Resolves the domain's storage_mode from the domains table — fail CLOSED:
 * an unknown domain denies (it may not be a local-mode domain the policy
 * was written for), and a garbage storage_mode value is a configuration
 * error, never a silent pass.
 */
async function requireStorageMode(
  db: SqlExecutor,
  ctx: EgressCheckContext,
): Promise<StorageMode> {
  const result = await db.query(
    "SELECT storage_mode FROM domains WHERE key = $1 LIMIT 1",
    [ctx.domainId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new EgressDenialError({
      code: "egress.denied",
      reason: "unknown_domain",
      request: { domainId: ctx.domainId, sensitivity: ctx.sensitivity, provider: ctx.provider, model: ctx.model },
      message: DENIAL_MESSAGES.unknown_domain(ctx),
    });
  }
  const mode = row.storage_mode;
  if (mode !== "local" && mode !== "remote" && mode !== "federated" && mode !== "opaque") {
    throw new EgressPolicyError(
      `domain "${ctx.domainId}" has invalid storage_mode ${JSON.stringify(mode)}`,
    );
  }
  return mode;
}

/**
 * Wraps a ModelProvider so every request is egress-checked BEFORE dispatch
 * (ADR-0012 enforcement point; composes with — never replaces — the
 * `call_model:<provider>` capability grant, which is M4A's lane). On denial
 * the wrapped provider is never invoked.
 *
 * Fail-closed by construction (T15):
 * - `storageMode` is resolved from the `domains` table via `db` on EVERY
 *   request and passed into the check — callers cannot opt out of the
 *   `allowRemote` evaluation, and an unknown domain denies.
 * - The request must name the wrapped provider (`request.provider ===
 *   provider.id`); a mismatch is a wiring error and throws.
 */
export function egressGatedModelProvider(
  provider: ModelProvider,
  registry: ModelEgressPolicyRegistry,
  db: SqlExecutor,
): ModelProvider {
  return {
    id: provider.id,
    async complete(request: ModelRequest): Promise<ModelResult> {
      if (request.provider !== provider.id) {
        throw new EgressPolicyError(
          `egress-gated provider "${provider.id}" received a request naming provider "${request.provider}"`,
        );
      }
      const ctx: EgressCheckContext = {
        domainId: request.domainId,
        sensitivity: request.sensitivity,
        provider: request.provider,
        model: request.model,
      };
      const storageMode = await requireStorageMode(db, ctx);
      registry.assertAllowed({ ...ctx, storageMode });
      return provider.complete(request);
    },
  };
}
