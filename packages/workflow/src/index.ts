/**
 * @jehad/workflow — the Inngest-backed WorkflowRuntime implementation
 * (ADR-0008; plan §12, plan §15 M3). Inngest imports are confined to
 * this package (M3 criterion); the rest of the repo consumes the port
 * from @jehad/adapters and the executor-neutral surface exported here.
 */

export type {
  WorkflowHandle,
  WorkflowName,
  WorkflowRuntime,
  WorkflowSignal,
  WorkflowStatus,
} from "@jehad/adapters";

export {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_SIGNAL_TIMEOUT_MS,
  defineScheduledWorkflow,
  defineWorkflow,
  type ApprovalOutcome,
  type AnyWorkflowDefinition,
  type ScheduledWorkflowDefinition,
  type SignalReceipt,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowFn,
  type WorkflowStepTools,
} from "./definition.js";

export {
  APPROVE_SIGNAL_PREFIX,
  createWorkflowRuntime,
  type EventSender,
  type JehadWorkflowRuntime,
  type WorkflowRuntimeOptions,
} from "./runtime.js";

export {
  createWorkflowWorkerServer,
  type WorkflowWorkerOptions,
} from "./serve.js";

export {
  createInngestClient,
  resolveWorkflowClientConfig,
  type ResolvedWorkflowClientConfig,
  type WorkflowClientConfig,
} from "./config.js";

export {
  createSqlRunCorrelator,
  logCorrelationError,
  type RunCorrelator,
  type RunStartedInfo,
  type SqlQueryExecutor,
} from "./correlator.js";

export {
  approvalEvent,
  approvalStepId,
  assertWorkflowToken,
  type DetailedWorkflowStatus,
  NAME_RE,
  signalEvent,
  signalStepId,
  toPortStatus,
  waitKindFromStepId,
  workflowStartEvent,
  type WorkflowNameError,
} from "./names.js";

export {
  createHttpExecutorApi,
  mapExecutorDetail,
  type ExecutorApi,
  type ExecutorRunDetail,
  type FetchLike,
  type FetchResponseLike,
} from "./executor-api.js";
