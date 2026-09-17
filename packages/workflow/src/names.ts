/**
 * Event and step naming scheme for the Inngest adapter.
 *
 * Per-run signal/approval events are the mechanism the ADR-0008 spike
 * confirmed: the dev server's expression compiler rejects `if: data.*`
 * filters on waitForEvent (ADR-0008 friction note 2), so runs address
 * their waits with unique event NAMES instead of match expressions —
 * `jehad/signal/<runId>/<signalName>` / `jehad/approval/<runId>/<id>`.
 *
 * Wait step ids carry the wait kind (`wait:signal:*` / `wait:approval:*`)
 * so status() can map executor pause state to the workflow status
 * vocabulary without trusting the misleading events-API "Completed"
 * label (ADR-0008 friction note 4).
 */

export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export class WorkflowNameError extends Error {
  constructor(kind: string, value: string) {
    super(`invalid ${kind} "${value}": must match ${String(NAME_RE)}`);
    this.name = "WorkflowNameError";
  }
}

export function assertWorkflowToken(kind: string, value: string): void {
  if (!NAME_RE.test(value)) throw new WorkflowNameError(kind, value);
}

/** Trigger event for `start(workflow, input)`. */
export function workflowStartEvent(workflow: string): string {
  assertWorkflowToken("workflow name", workflow);
  return `jehad/workflow/${workflow}/start`;
}

/** Per-run event carrying a signal to a parked workflow. */
export function signalEvent(runId: string, signalName: string): string {
  assertWorkflowToken("signal name", signalName);
  return `jehad/signal/${runId}/${signalName}`;
}

/** Per-run event carrying an approval decision. */
export function approvalEvent(runId: string, approvalId: string): string {
  assertWorkflowToken("approval id", approvalId);
  return `jehad/approval/${runId}/${approvalId}`;
}

export const SIGNAL_STEP_PREFIX = "wait:signal:";
export const APPROVAL_STEP_PREFIX = "wait:approval:";

export function signalStepId(signalName: string): string {
  assertWorkflowToken("signal name", signalName);
  return `${SIGNAL_STEP_PREFIX}${signalName}`;
}

export function approvalStepId(approvalId: string): string {
  assertWorkflowToken("approval id", approvalId);
  return `${APPROVAL_STEP_PREFIX}${approvalId}`;
}

/**
 * Refined status vocabulary (M3). The port's `WorkflowStatus` placeholder
 * collapses `waiting_signal`/`waiting_approval` into `waiting` (the port
 * file is read-only here; its W1 TODO settles exact typing); the adapter
 * exposes the full six-state vocabulary via `detailedStatus()`.
 */
export type DetailedWorkflowStatus =
  | "running"
  | "waiting_signal"
  | "waiting_approval"
  | "completed"
  | "cancelled"
  | "failed";

export function toPortStatus(
  status: DetailedWorkflowStatus,
): "running" | "waiting" | "completed" | "cancelled" | "failed" {
  return status === "waiting_signal" || status === "waiting_approval"
    ? "waiting"
    : status;
}

/** Which wait kind (if any) a paused step id represents. */
export function waitKindFromStepId(stepId: string): DetailedWorkflowStatus | null {
  if (stepId.startsWith(SIGNAL_STEP_PREFIX)) return "waiting_signal";
  if (stepId.startsWith(APPROVAL_STEP_PREFIX)) return "waiting_approval";
  return null;
}
