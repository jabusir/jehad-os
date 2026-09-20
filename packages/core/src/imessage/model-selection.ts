// packages/core/src/imessage/model-selection.ts — pure pass-model
// resolution for the iMessage gateway model-routing lane (R1).
//
// Model selection is data, not model judgment: pass overrides come from
// `gateway.passes` policy; anything unconfigured falls back to the
// principal's budgeted model. Escalation is retry-on-parse-failure ONLY:
// the route pass escalates to its fallback model when structured parsing
// of the route output fails — never on content. This module is pure and
// hermetic (no IO, no provider SDKs); the conversation lane owns wiring.

import type { GatewayPassesPolicy } from "../policy/ceiling.js";

/**
 * Resolves the per-pass model ids for one conversation model call:
 * pass override ?? principalModel; routeFallback is null when
 * unconfigured (no escalation model — the caller does not retry).
 */
export function resolvePassModels(input: {
  principalModel: string;
  passes: GatewayPassesPolicy | null;
}): { route: string; answer: string; routeFallback: string | null } {
  return {
    route: input.passes?.route?.model ?? input.principalModel,
    answer: input.passes?.answer?.model ?? input.principalModel,
    routeFallback: input.passes?.route_fallback?.model ?? null,
  };
}

/**
 * Whether the route pass should escalate to its fallback model. True only
 * when structured parsing of the route output failed — content NEVER
 * triggers escalation (the text is accepted verbatim as input and unused
 * by design, so refusal-ish or garbage-looking output that parsed fine
 * cannot burn a second model call).
 */
export function shouldEscalateRoute(
  routeOutputText: string,
  parseFailed: boolean,
): boolean {
  return parseFailed;
}

/** Attempt number + model actually used, for model_calls ledger symmetry. */
export function escalationAuditFields(
  attempt: 1 | 2,
  model: string,
): { attempt: number; model: string } {
  return { attempt, model };
}
