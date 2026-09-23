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
  calendarOccurrenceSweepWorkflow,
  type CalendarOccurrenceSweepResult,
} from "./occurrence-workflows.js";
export {
  reminderSweepWorkflow,
  REMINDER_SWEEP_ACTOR,
  REMINDER_SWEEP_CRON,
  REMINDER_SURFACE,
  REMINDER_TOUCH_AUDIT_ACTION,
  REMINDER_NOTIFICATION_TITLE,
  runReminderSweepTick,
  type PendingProbe,
  type ReminderSweepResult,
} from "./reminder-workflows.js";
export { grantReminderWorkflow } from "./grant-workflows.js";export {
  gmailSyncWorkflow,
  gmailContentSweepWorkflow,
  GMAIL_INGEST_CAPABILITY,
  GMAIL_INGEST_RESOURCE,
  GMAIL_SYNC_ACTOR,
  GMAIL_SYNC_DOMAIN_KEY,
  GMAIL_SYNC_GRANT_TTL_MS,
  runGmailContentSweep,
  runGmailSyncTick,
  type GmailContentSweepResult,
  type GmailSyncResult,
} from "./gmail-workflows.js";
export {
  outcomeExecutorWorkflow,
  outcomeReaperWorkflow,
  outcomeResumeScannerWorkflow,
  OUTCOME_EXECUTOR_ACTOR,
  OUTCOME_EXECUTOR_MAX_ITERATIONS,
  OUTCOME_REAPER_ACTOR,
  OUTCOME_SCANNER_ACTOR,
  runOutcomeExecutor,
  runOutcomeReapTick,
  runOutcomeResumeScan,
  getHarness,
  loadWorkersPolicy,
  type OutcomeExecutorInput,
  type OutcomeExecutorOpts,
  type OutcomeExecutorPrimitives,
  type OutcomeExecutorResult,
  type OutcomeReapResult,
  type OutcomeScanResult,
} from "./outcome-workflows.js";
export {
  threadRetentionWorkflow,
  type ThreadRetentionResult,
} from "./thread-workflows.js";
export {
  calibrationPromptWorkflow,
  calibrationWeeklyWorkflow,
  calibrationWorkflows,
  CALIBRATION_LOCAL_TZ,
  CALIBRATION_PROMPT_CRON_MINUTE,
  CALIBRATION_PROMPT_LOCAL_HOUR_DEFAULT,
  CALIBRATION_WEEKLY_LOCAL_HOUR,
  CALIBRATION_WEEKLY_LOCAL_WEEKDAY,
  calibrationPolicyOf,
  DEFAULT_CALIBRATION_POLICY,
  isLocalWeekdayHour,
  loadCalibrationPolicy,
  runDailyCalibrationTick,
  runWeeklyCalibrationTick,
  type CalibrationPolicy,
  type CalibrationPrincipalOutcome,
  type CalibrationTickResult,
} from "./calibration-workflows.js";

export {
  aggregateClaimAudits,
  aggregateExpiredRatified,
  aggregateRateLimits,
  CLAIM_DRIFT_SUBJECT_PREFIX,
  CLAIM_MISMATCH_THRESHOLD,
  EXPIRED_RATIFIED_SUBJECT,
  EXPIRED_RATIFIED_THRESHOLD,
  lessonHarvestWorkflow,
  lessonHarvestWorkflows,
  LESSON_HARVEST_CRON,
  LESSON_HARVEST_LOCAL_HOUR,
  LESSON_HARVEST_WINDOW_HOURS,
  normalizeClaimType,
  RATE_LIMIT_SUBJECT,
  RATE_LIMIT_THRESHOLD,
  RATIFIED_SENTINEL_KINDS,
  runLessonHarvestTick,
  SAFE_FALLBACK_THRESHOLD,
  type ClaimTypeEvidence,
  type LessonCandidate,
  type LessonHarvestResult,
} from "./lesson-harvest-workflows.js";

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

export type { GrantReminderOutcome, GrantReminderResult } from "./grant-workflows.js";
