/**
 * WorkflowRuntime implementation over Inngest (ADR-0008).
 *
 * Executor only, never a source of truth: beyond dispatching events and
 * reading executor run state, the runtime writes nothing except
 * runs/human_waits correlation through the injected correlator.
 *
 * Handle.runId is the trigger event id returned by the executor's event
 * API (a ULID). status() maps from the executor's truthful run/trace
 * view, never from the events-runs endpoint's "Completed"-while-parked
 * label (ADR-0008 friction note 4).
 */

import type {
  WorkflowHandle,
  WorkflowName,
  WorkflowRuntime,
  WorkflowSignal,
  WorkflowStatus,
} from "@jehad/adapters";
import { createInngestClient, resolveWorkflowClientConfig, type WorkflowClientConfig } from "./config.js";
import {
  createHttpExecutorApi,
  mapExecutorDetail,
  type ExecutorApi,
} from "./executor-api.js";
import {
  approvalEvent,
  signalEvent,
  toPortStatus,
  workflowStartEvent,
  type DetailedWorkflowStatus,
} from "./names.js";
import type { RunCorrelator } from "./correlator.js";
import { logCorrelationError } from "./correlator.js";

/** Structural slice of the Inngest client the runtime needs (test-injectable). */
export interface EventSender {
  send(payload: { name: string; data?: unknown }): Promise<{ ids: string[] }>;
}

export interface WorkflowRuntimeOptions {
  config?: WorkflowClientConfig;
  /** Defaults to an Inngest client built from `config`. */
  client?: EventSender;
  /** Defaults to the HTTP executor API at `config.baseUrl`. */
  executor?: ExecutorApi;
  /** Optional runs/human_waits correlation. */
  correlator?: RunCorrelator;
}

export interface JehadWorkflowRuntime extends WorkflowRuntime {
  /** Six-state status (the port's `status()` collapses waits to "waiting"). */
  detailedStatus(handle: WorkflowHandle): Promise<DetailedWorkflowStatus>;
}

export const APPROVE_SIGNAL_PREFIX = "approve:";

/**
 * Signal-name routing: plain names wake `waitForSignal` waits; names
 * prefixed `approve:` carry an approval decision into a
 * `pauseForApproval` wait (same name after the prefix). This keeps the
 * four-operation port surface complete for approval workflows.
 */
function resolveSignalEvent(handle: WorkflowHandle, name: string): string {
  if (name.startsWith(APPROVE_SIGNAL_PREFIX)) {
    return approvalEvent(handle.runId, name.slice(APPROVE_SIGNAL_PREFIX.length));
  }
  return signalEvent(handle.runId, name);
}

export function createWorkflowRuntime(options: WorkflowRuntimeOptions = {}): JehadWorkflowRuntime {
  const config = resolveWorkflowClientConfig(options.config);
  const client: EventSender = options.client ?? createInngestClient(config);
  const executor: ExecutorApi =
    options.executor ?? createHttpExecutorApi(config.baseUrl);

  const sendEvent = (name: string, data: unknown): Promise<{ ids: string[] }> =>
    client.send({ name, data: data === undefined ? {} : data });

  const correlated = async (
    operation: string,
    run: (correlator: RunCorrelator) => Promise<void>,
  ): Promise<void> => {
    if (!options.correlator) return;
    await run(options.correlator).catch((err: unknown) =>
      logCorrelationError(operation, err),
    );
  };

  return {
    async start<TInput>(workflow: WorkflowName, input: TInput): Promise<WorkflowHandle> {
      const out = await sendEvent(workflowStartEvent(workflow), { input });
      const eventId = out.ids[0];
      if (eventId === undefined) {
        throw new Error(`executor returned no event id for workflow "${workflow}"`);
      }
      await correlated("runStarted", (c) =>
        c.runStarted({ runId: eventId, workflow }),
      );
      return { runId: eventId };
    },

    async signal(handle: WorkflowHandle, signal: WorkflowSignal): Promise<void> {
      await sendEvent(
        resolveSignalEvent(handle, signal.name),
        { payload: signal.payload },
      );
    },

    async cancel(handle: WorkflowHandle): Promise<void> {
      const executorRunId = await executor.runIdForEvent(handle.runId);
      if (executorRunId !== undefined) {
        await executor.cancel(executorRunId);
      }
      await correlated("runStatus:cancelled", (c) =>
        c.runStatus({ runId: handle.runId, status: "cancelled" }),
      );
      await correlated("openWaitsResolved", (c) => c.openWaitsResolved({ runId: handle.runId }));
    },

    async detailedStatus(handle: WorkflowHandle): Promise<DetailedWorkflowStatus> {
      const executorRunId = await executor.runIdForEvent(handle.runId);
      if (executorRunId === undefined) return "running"; // accepted, not yet started
      return mapExecutorDetail(await executor.runDetail(executorRunId));
    },

    async status(handle: WorkflowHandle): Promise<WorkflowStatus> {
      const detailed = await this.detailedStatus(handle);
      return toPortStatus(detailed);
    },
  };
}
