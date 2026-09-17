/**
 * Fake federated DomainBackend (M4 proof adapter — ADR-0010; cleanup §3;
 * A16: fakes only, no real remote domains in Phase 1).
 *
 * Holds proprietary remote state internally (titles, summaries) that must
 * NEVER cross the boundary. The only thing it exports is the policy-defined
 * sanitized metadata projection — counts like `{pending_reviews: 2}` — built
 * exclusively from an allowlist of count fields. Any other query kind or
 * context purpose gets nothing (deny by default). If the sanitized projection
 * ever widens, it widens HERE, in one auditable place.
 */

import type {
  ContextPacket,
  ContextRequest,
  DomainAccessContext,
  DomainBackend,
  DomainCapability,
  DomainHealth,
  DomainQuery,
  DomainQueryResult,
} from "../ports/domain-backend.js";

/** Remote-side review state — title/summary NEVER cross the boundary. */
export interface FakeFederatedReview {
  readonly title: string;
  readonly summary: string;
  readonly pending: boolean;
}

export interface FakeFederatedOptions {
  readonly domainKey?: string;
  readonly reviews?: readonly FakeFederatedReview[];
}

/** The sanitized metadata fields a federated domain may export (cleanup §3). */
export type SanitizedFederatedProjection = { readonly pending_reviews: number };

export class FakeFederatedBackend implements DomainBackend {
  readonly id: string;
  readonly mode = "federated" as const;
  readonly #reviews: readonly FakeFederatedReview[];

  constructor(opts: FakeFederatedOptions = {}) {
    this.id = `federated:${opts.domainKey ?? "fake"}`;
    this.#reviews = opts.reviews ?? [];
  }

  /** Count of remote reviews awaiting attention. */
  #sanitizedProjection(): SanitizedFederatedProjection {
    return { pending_reviews: this.#reviews.filter((r) => r.pending).length };
  }

  async query(request: DomainQuery, _ctx: DomainAccessContext): Promise<DomainQueryResult> {
    void _ctx;
    if (request.kind === "attention.counts") return { rows: [this.#sanitizedProjection()] };
    return { rows: [] }; // only the policy-defined projection may cross
  }

  async context(request: ContextRequest, _ctx: DomainAccessContext): Promise<ContextPacket> {
    void _ctx;
    if (request.purpose === "attention") return { items: [this.#sanitizedProjection()] };
    return { items: [] };
  }

  async capabilities(): Promise<DomainCapability[]> {
    return [{ name: "attention.counts", available: true }];
  }

  async health(): Promise<DomainHealth> {
    return { status: "healthy" };
  }
}
