/**
 * Workflow authoring surface + compilation to Inngest functions.
 *
 * `defineWorkflow` / `defineScheduledWorkflow` describe workflows in
 * executor-neutral terms (the only workflow vocabulary the rest of the
 * repo consumes — no Inngest imports leak, M3 criterion). Compiling a
 * definition (internal, done by the serve surface) binds it to an
 * Inngest client, the per-run signal/approval wait primitives, and the
 * runs/human_waits correlator.
 *
 * Durability notes (ADR-0008 spike):
 * - correlation open/close happens inside memoized `step.run` bodies so
 *   crash+replay cannot duplicate rows;
 * - waits use per-run event names (no `if` filters — dev-server caveat).
 */

import type { Inngest } from "inngest";
import type { InngestFunction } from "inngest";
import {
  approvalEvent,
  approvalStepId,
  assertWorkflowToken,
  signalEvent,
  signalStepId,
  workflowStartEvent,
} from "./names.js";
import type { RunCorrelator } from "./correlator.js";
import { logCorrelationError } from "./correlator.js";

export const DEFAULT_SIGNAL_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 24 * 60 * 60_000;

/** Executor-neutral step tools handed to workflow bodies. */
export interface WorkflowStepTools {
  /** Durable, memoized step — reruns only if it never completed. */
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  /** Durable sleep that survives worker restarts. */
  sleep(id: string, ms: number): Promise<void>;
}

export interface SignalReceipt {
  readonly name: string;
  readonly payload?: unknown;
}

export interface ApprovalOutcome {
  /** false when the wait timed out without a decision. */
  readonly approved: boolean;
  readonly payload?: unknown;
}

export interface WorkflowContext<TInput = unknown> {
  readonly input: TInput;
  /** Correlation id — the value `start()` returned as handle.runId. */
  readonly runId: string;
  readonly workflow: string;
  readonly step: WorkflowStepTools;
  /** Wait for a signal sent via `runtime.signal(handle, { name })`. Resolves null on timeout. */
  waitForSignal(name: string, opts?: { timeoutMs?: number }): Promise<SignalReceipt | null>;
  /**
   * Park for human approval. Opens a `human_waits` row (correlation) on
   * entry and closes it on resume or timeout; survives worker restarts.
   */
  pauseForApproval(
    id: string,
    opts?: { reason?: string; timeoutMs?: number },
  ): Promise<ApprovalOutcome>;
}

export type WorkflowFn<TInput> = (ctx: WorkflowContext<TInput>) => Promise<unknown>;

export interface WorkflowDefinition<TInput = unknown> {
  readonly kind: "event";
  readonly name: string;
  readonly fn: WorkflowFn<TInput>;
}

export interface ScheduledWorkflowDefinition {
  readonly kind: "cron";
  readonly name: string;
  /** Five-field cron expression (executor granularity is per-minute). */
  readonly cron: string;
  readonly fn: WorkflowFn<undefined>;
}

export function defineWorkflow<TInput>(def: {
  name: string;
  fn: WorkflowFn<TInput>;
}): WorkflowDefinition<TInput> {
  assertWorkflowToken("workflow name", def.name);
  return { kind: "event", name: def.name, fn: def.fn };
}

export function defineScheduledWorkflow(def: {
  name: string;
  cron: string;
  fn: WorkflowFn<undefined>;
}): ScheduledWorkflowDefinition {
  assertWorkflowToken("workflow name", def.name);
  return { kind: "cron", name: def.name, cron: def.cron, fn: def.fn };
}

// `any` (not `unknown`) on the payload: definitions are consumed at this
// boundary by NAME only (registration/serve) — inputs are supplied by the
// runtime, never through this type, so payload contravariance would make
// the union reject every parametrized definition for no safety gain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWorkflowDefinition = WorkflowDefinition<any> | ScheduledWorkflowDefinition;

// ---------------------------------------------------------------------------
// Compilation to Inngest functions (internal)
// ---------------------------------------------------------------------------

/* Minimal structural view of the Inngest step tools the adapter uses. */
interface InngestStep {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  sleep(id: string, ms: number): Promise<void>;
  waitForEvent(
    id: string,
    opts: { event: string; timeout: number },
  ): Promise<{ data?: unknown } | null>;
}

interface InngestEventContext {
  readonly event: { readonly id?: string; readonly data?: unknown };
  readonly step: InngestStep;
  readonly runId: string;
}

function assertUserStepId(id: string): void {
  assertWorkflowToken("step id", id);
}

function readPayload(event: { data?: unknown } | null): unknown {
  return (event?.data as { payload?: unknown } | undefined)?.payload;
}

function makeContext<TInput>(
  params: {
    workflow: string;
    correlationId: string;
    input: TInput;
    correlator?: RunCorrelator;
  },
  step: InngestStep,
): WorkflowContext<TInput> {
  const runId = params.correlationId;
  const correlator = params.correlator;
  const stepTools: WorkflowStepTools = {
    run: (id, fn) => {
      assertUserStepId(id);
      return step.run(id, fn);
    },
    sleep: (id, ms) => {
      assertUserStepId(id);
      return step.sleep(id, ms);
    },
  };

  return {
    input: params.input,
    runId,
    workflow: params.workflow,
    step: stepTools,
    waitForSignal: async (name, opts) => {
      const ev = await step.waitForEvent(signalStepId(name), {
        event: signalEvent(runId, name),
        timeout: opts?.timeoutMs ?? DEFAULT_SIGNAL_TIMEOUT_MS,
      });
      return ev === null ? null : { name, payload: readPayload(ev) };
    },
    pauseForApproval: async (id, opts) => {
      // Open the human_waits row exactly once: the memoized step guard
      // means crash+replay cannot duplicate it.
      await step.run(`open:approval:${id}`, async () => {
        await correlator
          ?.approvalOpened({ runId, approvalId: id, reason: opts?.reason })
          .catch((err: unknown) => logCorrelationError("approvalOpened", err));
        return { openedAt: new Date().toISOString() };
      });
      const ev = await step.waitForEvent(approvalStepId(id), {
        event: approvalEvent(runId, id),
        timeout: opts?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
      });
      // Close the wait exactly once, on resume or timeout alike.
      await step.run(`close:approval:${id}`, async () => {
        await correlator
          ?.approvalResolved({ runId, approvalId: id })
          .catch((err: unknown) => logCorrelationError("approvalResolved", err));
        return { resolvedAt: new Date().toISOString() };
      });
      return ev === null ? { approved: false } : { approved: true, payload: readPayload(ev) };
    },
  };
}

/**
 * Compile a definition into an Inngest function. The client must be the
 * same app the worker serves. Returned function is vendor-typed; callers
 * outside this package only see it served opaquely.
 */
export function compileWorkflow(
  client: Inngest,
  def: AnyWorkflowDefinition,
  correlator?: RunCorrelator,
): InngestFunction.Like {
  if (def.kind === "cron") {
    const name = def.name;
    return client.createFunction(
      { id: `jehad/scheduled/${name}`, triggers: [{ cron: def.cron }] },
      async (ctx: InngestEventContext) => {
        // Cron firings are executor-initiated: correlate by executor run id.
        const correlationId = ctx.runId;
        const context = makeContext(
          { workflow: name, correlationId, input: undefined, correlator },
          ctx.step,
        );
        await ctx.step.run("open:run", async () => {
          await correlator
            ?.runStarted({ runId: correlationId, workflow: name, intent: `cron:${name}` })
            .catch((err: unknown) => logCorrelationError("runStarted", err));
          return { openedAt: new Date().toISOString() };
        });
        try {
          const result = await def.fn(context);
          await ctx.step.run("close:run", async () => {
            await correlator
              ?.runStatus({ runId: correlationId, status: "completed" })
              .catch((err: unknown) => logCorrelationError("runStatus", err));
            return { closedAt: new Date().toISOString() };
          });
          return result;
        } catch (err) {
          await correlator
            ?.runStatus({ runId: correlationId, status: "failed" })
            .catch((corrErr: unknown) => logCorrelationError("runStatus", corrErr));
          throw err;
        }
      },
    );
  }

  const name = def.name;
  return client.createFunction(
    { id: `jehad/workflow/${name}`, triggers: [{ event: workflowStartEvent(name) }] },
    async (ctx: InngestEventContext) => {
      // Trigger events carry the correlation id: start() returns the event
      // id as handle.runId, so the body correlates on the same value.
      const correlationId = ctx.event.id ?? ctx.runId;
      const input = (ctx.event.data as { input?: unknown } | undefined)?.input;
      const context = makeContext(
        { workflow: name, correlationId, input, correlator },
        ctx.step,
      );
      await ctx.step.run("open:run", async () => {
        await correlator
          ?.runStarted({ runId: correlationId, workflow: name })
          .catch((err: unknown) => logCorrelationError("runStarted", err));
        return { openedAt: new Date().toISOString() };
      });
      try {
        const result = await def.fn(context);
        await ctx.step.run("close:run", async () => {
          await correlator
            ?.runStatus({ runId: correlationId, status: "completed" })
            .catch((err: unknown) => logCorrelationError("runStatus", err));
          return { closedAt: new Date().toISOString() };
        });
        return result;
      } catch (err) {
        await correlator
          ?.runStatus({ runId: correlationId, status: "failed" })
          .catch((corrErr: unknown) => logCorrelationError("runStatus", corrErr));
        throw err;
      }
    },
  );
}
