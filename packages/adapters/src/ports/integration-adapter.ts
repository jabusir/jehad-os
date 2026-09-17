/**
 * IntegrationAdapter port — external systems / actions
 * (read, watch, prepare, execute).
 *
 * Source: plan §4 (ports list; docs/architecture.md §4), plan §15 (phase
 * discipline). Defining ADR: ADR-0002 (vendor touchpoints live only in
 * adapter packages), with the phasing rule from final-cleanup review §1:
 * this interface is DEFINED now (Phase 1); the first concrete
 * IntegrationAdapter is implemented in Phase 2 at E3 (first authorized
 * source). Its Phase-1 read path is covered by the SourceAdapter port —
 * no concrete adapter is built merely to exercise this interface.
 *
 * TODO(at E3 / Phase 2): read/watch/prepare/execute surface, aligned with
 * the action intent → attempt → outcome semantics of plan §9 (ADR-0011:
 * attempts append, ambiguous outcomes are `unknown` until reconciled).
 */
export interface IntegrationAdapter {
  readonly id: string;
}
