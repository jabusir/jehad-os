/**
 * Serve-seam correlation tests (hermetic fake runner): the compiled
 * workflow functions that `createWorkflowWorkerServer` serves must write
 * runs correlation around every firing — start → running → terminal, and
 * approval waits → human_waits — with correlator failures never breaking
 * execution. DB-backed proof of the actual rows lives in
 * tests/serve-correlator.db.test.ts (TEST_DATABASE_URL-gated).
 */

import { describe, expect, it, vi } from "vitest";
import { Inngest } from "inngest";
import {
  compileWorkflow,
  defineScheduledWorkflow,
  defineWorkflow,
} from "./definition.js";
import { createWorkflowWorkerServer } from "./serve.js";
import type { RunCorrelator } from "./correlator.js";

const client = new Inngest({ id: "serve-correlator-test" });

function fakeCorrelator(): RunCorrelator {
  return {
    runStarted: vi.fn().mockResolvedValue(undefined),
    runStatus: vi.fn().mockResolvedValue(undefined),
    approvalOpened: vi.fn().mockResolvedValue(undefined),
    approvalResolved: vi.fn().mockResolvedValue(undefined),
    openWaitsResolved: vi.fn().mockResolvedValue(undefined),
  } satisfies RunCorrelator;
}

/** Fake memoizing step tools: run bodies execute directly (no executor). */
function fakeStep() {
  return {
    run: async <T>(_id: string, fn: () => Promise<T> | T): Promise<T> => await fn(),
    sleep: async () => undefined,
    waitForEvent: async () => null,
  };
}

type RawContext = {
  event: { id?: string; data?: unknown };
  step: ReturnType<typeof fakeStep>;
  runId: string;
};

/** The raw handler behind a compiled function (the seam `serve()` drives). */
function rawFn(compiled: ReturnType<typeof compileWorkflow>) {
  return (compiled as unknown as { fn: (ctx: RawContext) => Promise<unknown> }).fn;
}

describe("workflow serve correlation (serve.ts seam, hermetic)", () => {
  it("a workflow run correlates start → completed and returns its result", async () => {
    const correlator = fakeCorrelator();
    const def = defineWorkflow({
      name: "correlated-smoke",
      fn: async (ctx) => ctx.step.run("echo", () => ({ got: ctx.input })),
    });
    const result = await rawFn(compileWorkflow(client, def, correlator))({
      event: { id: "evt-1", data: { input: { n: 1 } } },
      step: fakeStep(),
      runId: "exec-run-1",
    });

    expect(result).toEqual({ got: { n: 1 } });
    expect(correlator.runStarted).toHaveBeenCalledTimes(1);
    expect(correlator.runStarted).toHaveBeenCalledWith({
      runId: "evt-1",
      workflow: "correlated-smoke",
    });
    expect(correlator.runStatus).toHaveBeenCalledTimes(1);
    expect(correlator.runStatus).toHaveBeenCalledWith({
      runId: "evt-1",
      status: "completed",
    });
    expect(correlator.approvalOpened).not.toHaveBeenCalled();
  });

  it("a crashing run records failed and still rethrows the original error", async () => {
    const correlator = fakeCorrelator();
    const def = defineWorkflow({
      name: "correlated-crash",
      fn: async () => {
        throw new Error("boom");
      },
    });
    const raw = rawFn(compileWorkflow(client, def, correlator));
    await expect(
      raw({ event: { id: "evt-2", data: {} }, step: fakeStep(), runId: "exec-run-2" }),
    ).rejects.toThrow("boom");

    expect(correlator.runStarted).toHaveBeenCalledWith({
      runId: "evt-2",
      workflow: "correlated-crash",
    });
    expect(correlator.runStatus).toHaveBeenCalledWith({
      runId: "evt-2",
      status: "failed",
    });
  });

  it("correlator failures never break workflow execution", async () => {
    const correlator = fakeCorrelator();
    correlator.runStarted.mockRejectedValue(new Error("db down"));
    correlator.runStatus.mockRejectedValue(new Error("db down"));
    const def = defineWorkflow({
      name: "correlated-resilient",
      fn: async (ctx) => ctx.step.run("work", () => "ok"),
    });
    const result = await rawFn(compileWorkflow(client, def, correlator))({
      event: { id: "evt-3", data: {} },
      step: fakeStep(),
      runId: "exec-run-3",
    });

    expect(result).toBe("ok");
    expect(correlator.runStarted).toHaveBeenCalledTimes(1);
    expect(correlator.runStatus).toHaveBeenCalledWith({
      runId: "evt-3",
      status: "completed",
    });
  });

  it("a cron firing correlates by executor run id with a cron:<name> intent", async () => {
    const correlator = fakeCorrelator();
    const def = defineScheduledWorkflow({
      name: "correlated-tick",
      cron: "* * * * *",
      fn: async (ctx) => ctx.step.run("tick", () => ({ ran: ctx.workflow })),
    });
    const result = await rawFn(compileWorkflow(client, def, correlator))({
      event: {},
      step: fakeStep(),
      runId: "exec-run-4",
    });

    expect(result).toEqual({ ran: "correlated-tick" });
    expect(correlator.runStarted).toHaveBeenCalledTimes(1);
    expect(correlator.runStarted).toHaveBeenCalledWith({
      runId: "exec-run-4",
      workflow: "correlated-tick",
      intent: "cron:correlated-tick",
    });
    expect(correlator.runStatus).toHaveBeenCalledWith({
      runId: "exec-run-4",
      status: "completed",
    });
  });

  it("an approval wait opens its human_waits correlation on entry and closes it on resume", async () => {
    const correlator = fakeCorrelator();
    const def = defineWorkflow({
      name: "correlated-approval",
      fn: async (ctx) => {
        const outcome = await ctx.pauseForApproval("release", { reason: "dangerous" });
        return { approved: outcome.approved };
      },
    });
    const step = fakeStep();
    // The approval signal arrives (resume path).
    step.waitForEvent = async () => ({ data: { payload: { by: "owner" } } });
    const result = await rawFn(compileWorkflow(client, def, correlator))({
      event: { id: "evt-5", data: {} },
      step,
      runId: "exec-run-5",
    });

    expect(result).toEqual({ approved: true });
    expect(correlator.approvalOpened).toHaveBeenCalledTimes(1);
    expect(correlator.approvalOpened).toHaveBeenCalledWith({
      runId: "evt-5",
      approvalId: "release",
      reason: "dangerous",
    });
    expect(correlator.approvalResolved).toHaveBeenCalledTimes(1);
    expect(correlator.approvalResolved).toHaveBeenCalledWith({
      runId: "evt-5",
      approvalId: "release",
    });
    expect(correlator.runStatus).toHaveBeenCalledWith({
      runId: "evt-5",
      status: "completed",
    });
  });

  it("createWorkflowWorkerServer accepts the correlator option (serve wiring)", () => {
    const server = createWorkflowWorkerServer({
      workflows: [defineWorkflow({ name: "wired", fn: async () => null })],
      correlator: fakeCorrelator(),
    });
    expect(typeof server.listen).toBe("function");
    server.close();
  });
});
