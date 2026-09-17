/**
 * Test workflows for the dev-server integration suite. Executed inside the
 * spawned worker process; observed via marker files under WORKFLOW_MARKER_DIR
 * (`<key>.log`, one JSON line per event) and via the runs/human_waits tables.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  defineScheduledWorkflow,
  defineWorkflow,
} from "../../src/index.js";

export function markerDir(): string {
  return process.env.WORKFLOW_MARKER_DIR ?? "/tmp/jehad-workflow-it";
}

export function markerFile(key: string): string {
  return join(markerDir(), `${key}.log`);
}

export function mark(key: string, event: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(markerDir(), { recursive: true });
  appendFileSync(markerFile(key), `${JSON.stringify({ event, ...extra })}\n`, "utf8");
}

export const WORKFLOW_NAMES = {
  quick: "it-quick",
  signalFlow: "it-signal-flow",
  approvalFlow: "it-approval-flow",
  ticker: "it-ticker",
} as const;

export const quickWorkflow = defineWorkflow({
  name: WORKFLOW_NAMES.quick,
  fn: async (ctx) => {
    await ctx.step.run("only", async () => {
      mark("quick", "step", { runId: ctx.runId });
      return { ok: true };
    });
    return { ok: true };
  },
});

export const signalFlowWorkflow = defineWorkflow({
  name: WORKFLOW_NAMES.signalFlow,
  fn: async (ctx) => {
    await ctx.step.run("prep", async () => {
      mark("signal-flow", "prep", { runId: ctx.runId });
      return {};
    });
    const sig = await ctx.waitForSignal("go", { timeoutMs: 120_000 });
    await ctx.step.run("finalize", async () => {
      mark("signal-flow", "finalize", { runId: ctx.runId, signal: sig?.name ?? "timeout" });
      return {};
    });
    return { signal: sig?.name ?? "timeout" };
  },
});

export const approvalFlowWorkflow = defineWorkflow({
  name: WORKFLOW_NAMES.approvalFlow,
  fn: async (ctx) => {
    await ctx.step.run("persist", async () => {
      // Memoization probe (spike pattern): this line must appear exactly
      // once per run even across worker kill -9 + restart.
      mark("approval-flow", "persist-step", { runId: ctx.runId });
      return {};
    });
    const decision = await ctx.pauseForApproval("release", {
      reason: "it-approval",
      timeoutMs: 300_000,
    });
    await ctx.step.run("finalize", async () => {
      mark("approval-flow", "finalize", { runId: ctx.runId, approved: decision.approved });
      return {};
    });
    return { approved: decision.approved };
  },
});

export const tickerWorkflow = defineScheduledWorkflow({
  name: WORKFLOW_NAMES.ticker,
  cron: "* * * * *", // executor cron granularity floor is one minute
  fn: async (ctx) => {
    await ctx.step.run("tick", async () => {
      mark("ticker", "tick", { runId: ctx.runId });
      return {};
    });
    return { tick: true };
  },
});
