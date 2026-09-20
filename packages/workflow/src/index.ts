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
  briefWorkflows,
  BRIEF_LOCAL_TZ,
  EVENING_CLOSE_LOCAL_HOUR,
  eveningCloseWorkflow,
  isLocalHour,
  MORNING_BRIEF_LOCAL_HOUR,
  morningBriefWorkflow,
  type ScheduledRenderResult,
} from "./brief-workflows.js";

export { calendarSyncWorkflow, type CalendarSyncResult } from "./calendar-workflows.js";
export {
  gmailSyncWorkflow,
  GMAIL_INGEST_CAPABILITY,
  GMAIL_INGEST_RESOURCE,
  GMAIL_SYNC_ACTOR,
  GMAIL_SYNC_DOMAIN_KEY,
  GMAIL_SYNC_GRANT_TTL_MS,
  runGmailSyncTick,
  type GmailSyncResult,
} from "./gmail-workflows.js";
export {
  threadRetentionWorkflow,
  type ThreadRetentionResult,
} from "./thread-workflows.js";

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
