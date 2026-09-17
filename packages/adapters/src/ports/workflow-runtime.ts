/**
 * WorkflowRuntime port — workflow semantics: start/signal/cancel/status.
 *
 * Source: plan §12 (interface retained from directive §11.9), plan §4.2
 * (the port interface lives in packages/adapters with the other ports),
 * plan §15 M3 (Inngest implementation in packages/workflow/inngest, gated
 * on the M3 spike). Defining ADR: ADR-0008 (Inngest as the initial durable
 * workflow runtime behind this boundary — status: accepted, pending M3
 * spike confirmation).
 *
 * Authority split (plan §12; ADR-0008): Jehad OS PostgreSQL remains
 * authoritative for world state, events, and the `runs` record — the
 * runtime owns workflow execution/checkpoint state ONLY; it is an executor,
 * never a source of truth. Workflow functions mutate state through domain
 * services only.
 */

/**
 * TODO(at M3, per ADR-0008 / open item W1): typed workflow registry.
 * Placeholder: workflow name as a plain string.
 */
export type WorkflowName = string;

/**
 * TODO(at M3, per ADR-0008 / open item W1): exact handle typing.
 * Placeholder: the executor-side run identifier. The canonical "what runs
 * exist / ran" record is the `runs` table (plan §7), not this handle.
 */
export interface WorkflowHandle {
  readonly runId: string;
}

/**
 * TODO(at M3, per ADR-0008 / open item W1): signal vocabulary
 * (incl. approval-wait signals).
 */
export interface WorkflowSignal {
  readonly name: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * TODO(at M3, per ADR-0008 / open item W1): exact status typing.
 * Placeholder states only — `waiting` covers signal/approval waits.
 */
export type WorkflowStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

/** Surface fixed by plan §12 (from §11.9); shape per docs/workflow-runtime.md §4. */
export interface WorkflowRuntime {
  start<TInput>(workflow: WorkflowName, input: TInput): Promise<WorkflowHandle>;
  signal(handle: WorkflowHandle, signal: WorkflowSignal): Promise<void>;
  cancel(handle: WorkflowHandle): Promise<void>;
  status(handle: WorkflowHandle): Promise<WorkflowStatus>;
}
