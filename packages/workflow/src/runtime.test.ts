import { describe, expect, it, vi } from "vitest";
import { createWorkflowRuntime, type EventSender } from "./runtime.js";
import type { ExecutorApi, ExecutorRunDetail } from "./executor-api.js";
import type { RunCorrelator } from "./correlator.js";
import type { WorkflowStatus } from "@jehad/adapters";

function fakeClient(): EventSender & { sent: Array<{ name: string; data?: unknown }> } {
  const sent: Array<{ name: string; data?: unknown }> = [];
  let n = 0;
  return {
    sent,
    send: async (payload) => {
      n += 1;
      sent.push(payload);
      return { ids: [`evt-${n}`] };
    },
  };
}

function fakeExecutor(detail?: ExecutorRunDetail): ExecutorApi & { cancelled: string[] } {
  const api: ExecutorApi & { cancelled: string[] } = {
    cancelled: [],
    runIdForEvent: async (eventId) => `run-of-${eventId}`,
    runDetail: async () => {
      if (!detail) throw new Error("runDetail not configured");
      return detail;
    },
    cancel: async (runId) => {
      api.cancelled.push(runId);
    },
  };
  return api;
}

function fakeCorrelator() {
  return {
    runStarted: vi.fn().mockResolvedValue(undefined),
    runStatus: vi.fn().mockResolvedValue(undefined),
    approvalOpened: vi.fn().mockResolvedValue(undefined),
    approvalResolved: vi.fn().mockResolvedValue(undefined),
    openWaitsResolved: vi.fn().mockResolvedValue(undefined),
  } satisfies RunCorrelator;
}

describe("createWorkflowRuntime (hermetic: injected client/executor)", () => {
  it("start() dispatches the workflow trigger event and returns its id as handle.runId", async () => {
    const client = fakeClient();
    const correlator = fakeCorrelator();
    const runtime = createWorkflowRuntime({ client, executor: fakeExecutor(), correlator });

    const handle = await runtime.start("ingest", { text: "hi" });

    expect(handle.runId).toBe("evt-1");
    expect(client.sent[0]?.name).toBe("jehad/workflow/ingest/start");
    expect(client.sent[0]?.data).toEqual({ input: { text: "hi" } });
    expect(correlator.runStarted).toHaveBeenCalledWith({
      runId: "evt-1",
      workflow: "ingest",
    });
  });

  it("start() correlation failure never fails the dispatch", async () => {
    const correlator = fakeCorrelator();
    correlator.runStarted.mockRejectedValueOnce(new Error("db down"));
    const runtime = createWorkflowRuntime({
      client: fakeClient(),
      executor: fakeExecutor(),
      correlator,
    });
    await expect(runtime.start("ingest", 1)).resolves.toEqual({ runId: "evt-1" });
  });

  it("signal() addresses the run's signal event and carries the payload", async () => {
    const client = fakeClient();
    const runtime = createWorkflowRuntime({ client, executor: fakeExecutor() });

    await runtime.signal({ runId: "run-x" }, { name: "go", payload: { ok: true } });

    expect(client.sent[0]).toEqual({
      name: "jehad/signal/run-x/go",
      data: { payload: { ok: true } },
    });
  });

  it("approve:-prefixed signals carry approval decisions into pauseForApproval waits", async () => {
    const client = fakeClient();
    const runtime = createWorkflowRuntime({ client, executor: fakeExecutor() });

    await runtime.signal({ runId: "run-x" }, { name: "approve:release" });

    expect(client.sent[0]?.name).toBe("jehad/approval/run-x/release");
  });

  it("cancel() cancels the executor run and closes correlation", async () => {
    const executor = fakeExecutor();
    const correlator = fakeCorrelator();
    const runtime = createWorkflowRuntime({
      client: fakeClient(),
      executor,
      correlator,
    });

    await runtime.cancel({ runId: "evt-9" });

    expect(executor.cancelled).toEqual(["run-of-evt-9"]);
    expect(correlator.runStatus).toHaveBeenCalledWith({
      runId: "evt-9",
      status: "cancelled",
    });
    expect(correlator.openWaitsResolved).toHaveBeenCalledWith({ runId: "evt-9" });
  });

  it("status() maps executor state through the port vocabulary", async () => {
    const statuses: WorkflowStatus[] = [];
    for (const detail of [
      { status: "RUNNING", waitingStepIds: [] },
      { status: "RUNNING", waitingStepIds: ["wait:signal:go"] },
      { status: "RUNNING", waitingStepIds: ["wait:approval:x"] },
      { status: "COMPLETED", waitingStepIds: [] },
      { status: "CANCELLED", waitingStepIds: [] },
      { status: "FAILED", waitingStepIds: [] },
    ]) {
      const runtime = createWorkflowRuntime({ client: fakeClient(), executor: fakeExecutor(detail) });
      statuses.push(await runtime.status({ runId: "e" }));
    }
    expect(statuses).toEqual([
      "running",
      "waiting",
      "waiting",
      "completed",
      "cancelled",
      "failed",
    ]);
  });

  it("detailedStatus() distinguishes signal and approval waits", async () => {
    const signalWait = createWorkflowRuntime({
      client: fakeClient(),
      executor: fakeExecutor({ status: "RUNNING", waitingStepIds: ["wait:signal:go"] }),
    });
    const approvalWait = createWorkflowRuntime({
      client: fakeClient(),
      executor: fakeExecutor({ status: "RUNNING", waitingStepIds: ["wait:approval:x"] }),
    });
    expect(await signalWait.detailedStatus({ runId: "e" })).toBe("waiting_signal");
    expect(await approvalWait.detailedStatus({ runId: "e" })).toBe("waiting_approval");
  });

  it("detailedStatus() reports running before the executor starts the run", async () => {
    const executor: ExecutorApi = {
      runIdForEvent: async () => undefined,
      runDetail: async () => {
        throw new Error("should not be called");
      },
      cancel: async () => {},
    };
    const runtime = createWorkflowRuntime({ client: fakeClient(), executor });
    expect(await runtime.detailedStatus({ runId: "not-yet" })).toBe("running");
  });

  it("start() rejects invalid workflow names", async () => {
    const runtime = createWorkflowRuntime({ client: fakeClient(), executor: fakeExecutor() });
    await expect(runtime.start("Not A Name", {})).rejects.toThrow();
  });
});
