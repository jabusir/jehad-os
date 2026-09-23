/**
 * Adapter ports — packages/adapters/src/ports.
 *
 * Domain code imports interfaces only from packages/adapters (AGENTS.md hard
 * rule; plan §4.2, ADR-0002). Pure types: zero vendor SDK imports, no
 * implementations, no runtime code. Phase discipline (plan §15; final-cleanup
 * review §1): define the port now; implement the adapter only when needed.
 * The Principal/auth port (plan §4) is owned separately and is not
 * re-exported here.
 */
export type {
  ContextPacket,
  ContextRequest,
  DomainAccessContext,
  DomainBackend,
  DomainCapability,
  DomainHealth,
  DomainQuery,
  DomainQueryResult,
} from "./domain-backend.js";
export type {
  NormalizedExternalEvent,
  Sensitivity,
  SourceAdapter,
} from "./source-adapter.js";
export type { IntegrationAdapter } from "./integration-adapter.js";
export type {
  HarnessAdapter,
  HarnessCapableAdapter,
  HarnessRunResult,
  HarnessRunSpec,
  HarnessRunStatus,
} from "./harness-adapter.js";
export type {
  ModelEgressPolicy,
  ModelProvider,
  ModelRequest,
  ModelResult,
} from "./model-provider.js";
export type {
  WorkflowHandle,
  WorkflowName,
  WorkflowRuntime,
  WorkflowSignal,
  WorkflowStatus,
} from "./workflow-runtime.js";
