/**
 * Fake opaque DomainBackend (M4 proof adapter — ADR-0010; cleanup §3; T15).
 *
 * The strictest mode: ZERO domain-content export by default. It holds rich
 * internal remote state (titles, summaries, counts) precisely to prove that
 * none of it crosses: query/context always return nothing, and the only
 * signals available are existence/health/capability — never counts, titles,
 * summaries, deadlines, project names, or decision metadata. No semantic
 * payload crosses unless the domain's policy is explicitly changed.
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

export interface FakeOpaqueOptions {
  readonly domainKey?: string;
  /** Proprietary remote state — held to prove it never crosses. */
  readonly internalState?: Readonly<Record<string, unknown>>;
}

export class FakeOpaqueBackend implements DomainBackend {
  readonly id: string;
  readonly mode = "opaque" as const;
  readonly #internalState: Readonly<Record<string, unknown>>;

  constructor(opts: FakeOpaqueOptions = {}) {
    this.id = `opaque:${opts.domainKey ?? "fake"}`;
    this.#internalState = opts.internalState ?? {};
  }

  /**
   * Test/introspection view of the REMOTE side's own state. The fake is the
   * remote environment, so callers holding the backend may inspect what stays
   * remote — this is not a boundary crossing; nothing here is reachable via
   * query/context/capabilities/health.
   */
  snapshotInternalState(): Readonly<Record<string, unknown>> {
    return this.#internalState;
  }

  /** Existence-level only — no query capability crosses by default. */
  async query(_request: DomainQuery, _ctx: DomainAccessContext): Promise<DomainQueryResult> {
    void _request;
    void _ctx;
    return { rows: [] };
  }

  async context(_request: ContextRequest, _ctx: DomainAccessContext): Promise<ContextPacket> {
    void _request;
    void _ctx;
    return { items: [] };
  }

  async capabilities(): Promise<DomainCapability[]> {
    return [{ name: "domain.exists", available: true }];
  }

  async health(): Promise<DomainHealth> {
    return { status: "healthy" };
  }
}
