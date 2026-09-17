// ActionProvider port — the seam through which the control plane dispatches
// external side effects (ADR-0011; plan §9). The domain (ActionService in
// @jehad/core) consumes this interface; concrete providers live in adapter
// packages only. Phase 1 ships exactly one concrete provider: the in-memory
// fake (./fake-provider.ts) — no real external calls until E3/E4 (plan §15).
//
// Honesty contract (ADR-0011, threat T13): a provider that performed the
// effect but lost the response must throw ProviderResponseLostError — never
// guess an outcome. The honest client-side state is then `unknown` until
// reconciliation via provider refs.

export interface ProviderDispatchRequest {
  intentId: string;
  capability: string;
  resource: string;
  payload: unknown;
  /** Stable per intent; retries reuse it so the provider can dedupe. */
  idempotencyKey: string;
}

export type ProviderDispatchStatus = "succeeded" | "failed";

export interface ProviderDispatchResponse {
  status: ProviderDispatchStatus;
  /** Provider-side reference proving what happened (reconciliation key). */
  providerRef?: string;
  error?: string;
}

export interface ActionProvider {
  readonly id: string;
  dispatch(request: ProviderDispatchRequest): Promise<ProviderDispatchResponse>;
}

/**
 * Thrown when the effect may have happened but no response came back
 * (e.g. response timeout after a non-idempotent side effect). Maps to
 * attempt outcome `unknown`, never to `succeeded` or `failed`.
 */
export class ProviderResponseLostError extends Error {
  constructor(message = "provider response lost after dispatch") {
    super(message);
    this.name = "ProviderResponseLostError";
  }
}
