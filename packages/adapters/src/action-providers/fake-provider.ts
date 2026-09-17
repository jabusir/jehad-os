// FakeActionProvider — the only action provider of Phase 1 (ADR-0011 #6,
// plan §15 M4). Pure in-memory: it performs NO network I/O of any kind, so
// tests are hermetic (plan §13). It models provider-side truth faithfully:
//
// - `effects`   : requests whose side effect actually happened ("succeed" and
//                 "timeout-after-dispatch"; "fail" performs no effect).
// - `responses` : the provider-side record of what happened, keyed by
//                 idempotency key — including effects whose response was lost.
//                 `statusForKey()` exposes it, standing in for the provider
//                 API a reconciliation workflow would call (plan §9).
// - replaying an idempotency key returns the recorded response and performs
//   no second effect (that is the point of idempotency keys, plan §9).

import {
  ProviderResponseLostError,
  type ActionProvider,
  type ProviderDispatchRequest,
  type ProviderDispatchResponse,
} from "./provider.js";

export type FakeProviderBehavior =
  | "succeed"
  | "fail"
  | /** Effect happens, response never arrives: dispatch() throws. */
  "timeout-after-dispatch";

export interface FakeActionProviderOptions {
  behavior?: FakeProviderBehavior;
  id?: string;
}

export class FakeActionProvider implements ActionProvider {
  readonly id: string;

  /** Mutable so a test can change behavior between attempts (retry paths). */
  behavior: FakeProviderBehavior;

  /** Append-only log of side effects that actually happened, in order. */
  readonly effects: ProviderDispatchRequest[] = [];

  /** Every request ever received (including ones that performed no effect). */
  readonly requests: ProviderDispatchRequest[] = [];

  private readonly responses = new Map<string, ProviderDispatchResponse>();
  private effectCounter = 0;

  constructor(options: FakeProviderBehavior | FakeActionProviderOptions = "succeed") {
    const opts: FakeActionProviderOptions =
      typeof options === "string" ? { behavior: options } : options;
    this.id = opts.id ?? "fake";
    this.behavior = opts.behavior ?? "succeed";
  }

  async dispatch(request: ProviderDispatchRequest): Promise<ProviderDispatchResponse> {
    this.requests.push(request);
    const recorded = this.responses.get(request.idempotencyKey);
    if (recorded !== undefined) {
      return { ...recorded };
    }
    switch (this.behavior) {
      case "succeed": {
        const response = this.succeed(request);
        this.responses.set(request.idempotencyKey, response);
        return { ...response };
      }
      case "fail": {
        const response: ProviderDispatchResponse = {
          status: "failed",
          error: `fake provider failure for ${request.resource}`,
        };
        this.responses.set(request.idempotencyKey, response);
        return { ...response };
      }
      case "timeout-after-dispatch": {
        // Effect happens provider-side; the response is lost in transit.
        const response = this.succeed(request);
        this.responses.set(request.idempotencyKey, response);
        throw new ProviderResponseLostError(
          `fake provider response lost after dispatch (effect may have happened) key=${request.idempotencyKey}`,
        );
      }
    }
  }

  /**
   * Provider-side status for an idempotency key — the lookup a
   * reconciliation workflow uses to resolve an `unknown` attempt. Returns
   * null when the provider never completed a request under this key.
   */
  statusForKey(idempotencyKey: string): ProviderDispatchResponse | null {
    const recorded = this.responses.get(idempotencyKey);
    return recorded === undefined ? null : { ...recorded };
  }

  private succeed(request: ProviderDispatchRequest): ProviderDispatchResponse {
    this.effectCounter += 1;
    this.effects.push(request);
    return {
      status: "succeeded",
      providerRef: `fake-${this.id}-${String(this.effectCounter).padStart(4, "0")}`,
    };
  }
}
