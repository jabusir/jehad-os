/**
 * Fake DomainBackends (M4 proof adapters — ADR-0010, A16). Fakes only: no
 * concrete remote backend exists in Phase 1. `federated` exports only the
 * policy-defined sanitized metadata projection; `opaque` exports
 * existence/health/capability only — zero semantic payload (cleanup §3).
 */
export {
  FakeFederatedBackend,
  type FakeFederatedOptions,
  type FakeFederatedReview,
  type SanitizedFederatedProjection,
} from "./fake-federated.js";
export { FakeOpaqueBackend, type FakeOpaqueOptions } from "./fake-opaque.js";
