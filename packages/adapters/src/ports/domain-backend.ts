/**
 * DomainBackend port — domain query/context/capabilities/health across
 * storage modes (local | remote | federated | opaque).
 *
 * Source: plan §10 (interface copied verbatim), plan §4 (ports list),
 * plan §15 (defined Phase 1; fake adapter at M4 proves the isolation
 * invariant). Defining ADR: ADR-0010 (DomainBackend storage modes).
 *
 * Invariants (ADR-0010): a domain is not synonymous with a row-level
 * partition in personal PostgreSQL. `opaque` = zero domain-content export by
 * default; `federated` = policy-defined sanitized metadata only; `remote` =
 * canonical state stays in the remote environment. Cross-domain composition
 * is policy-mediated aggregation, never raw joins (cleanup §4). Concrete
 * remote backends are NOT implemented in Phase 1.
 */

/** TODO(at M4): concrete query shape — minimal placeholder per plan §15. */
export interface DomainQuery {
  readonly kind: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * TODO(at M4): concrete access-context shape — minimal placeholder per
 * plan §15. Composition requests carry a purpose (cleanup §4).
 */
export interface DomainAccessContext {
  readonly principalId: string;
  readonly purpose: string;
}

/** TODO(at M4): concrete result shape — minimal placeholder per plan §15. */
export interface DomainQueryResult {
  readonly rows: readonly unknown[];
}

/** TODO(at M4): concrete request shape — minimal placeholder per plan §15. */
export interface ContextRequest {
  readonly purpose: string;
}

/**
 * TODO(at M4): concrete packet shape — minimal placeholder per plan §15.
 * Packages carry an event watermark for freshness checks (T10, plan §11).
 */
export interface ContextPacket {
  readonly watermark?: string;
  readonly items: readonly unknown[];
}

/** TODO(at M4): concrete capability shape — minimal placeholder per plan §15. */
export interface DomainCapability {
  readonly name: string;
  readonly available: boolean;
}

/**
 * TODO(at M4): concrete health shape — minimal placeholder per plan §15.
 * For opaque domains, health/existence is the only signal that may cross
 * the boundary (ADR-0010).
 */
export interface DomainHealth {
  readonly status: "healthy" | "degraded" | "unavailable";
}

/** Copied verbatim from plan §10. Do not reshape without an ADR-0010 update. */
export interface DomainBackend {
  id: string;
  mode: "local" | "remote" | "federated" | "opaque";
  query(request: DomainQuery, ctx: DomainAccessContext): Promise<DomainQueryResult>;
  context(request: ContextRequest, ctx: DomainAccessContext): Promise<ContextPacket>;
  capabilities(): Promise<DomainCapability[]>;
  health(): Promise<DomainHealth>;
}
