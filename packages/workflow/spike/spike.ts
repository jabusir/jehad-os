/**
 * ADR-0008 M3 spike — shared workflow definition (THROWAWAY SCAFFOLDING).
 *
 * Proves the protocol from plan §12 / ADR-0008 decision 4:
 *   start workflow → persist step → terminate app/worker (kill -9) → restart
 *   → resume → wait for external signal → signal → complete
 *
 * Scratch state lives ONLY under spike/.run/ (marker files). Executor state is
 * never canonical state (ADR-0008 authority split) — no world-state writes.
 *
 * Inngest imports are confined to packages/workflow (M3 criterion).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Inngest } from "inngest";

export const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
export const RUN_DIR = join(SPIKE_DIR, ".run");

export const DEV_PORT = 8288;
export const APP_PORT = 4040;
export const DEV_BASE = `http://127.0.0.1:${DEV_PORT}`;
export const APP_URL = `http://127.0.0.1:${APP_PORT}/api/inngest`;

export const TRIGGER_EVENT = "spike/run.requested";
export const SIGNAL_EVENT = "spike/external.signal";

/**
 * SPIKE_RUNTIME=dev  -> `inngest dev` (dev server; unsigned, INNGEST_DEV=1)
 * SPIKE_RUNTIME=start-> `inngest start` (self-hosted single binary; signed,
 *                        INNGEST_SIGNING_KEY required)
 */
export const RUNTIME = process.env.SPIKE_RUNTIME === "start" ? "start" : "dev";

if (RUNTIME === "dev") {
  // SDK v4 dev mode: trust the local dev server (no signing/event keys needed).
  process.env.INNGEST_DEV ??= "1";
}

export const inngestClient = new Inngest({
  id: "jehad-spike",
  baseUrl: DEV_BASE,
  eventKey: process.env.SPIKE_EVENT_KEY ?? "spike-dev",
});

const appendLine = (runKey: string, file: string, text: string): void => {
  mkdirSync(RUN_DIR, { recursive: true });
  appendFileSync(join(RUN_DIR, `${file}-${runKey}.log`), `${text}\n`, "utf8");
};

/**
 * The spike workflow. Top-of-body invocation logging runs on EVERY executor
 * invocation (replay included); step bodies run only when actually executed.
 * Memoization proof: invocation count grows across resume, but the
 * persist-step marker line is written exactly once.
 */
export const spikeWorkflow = inngestClient.createFunction(
  { id: "spike/crash-resume-signal", triggers: [{ event: TRIGGER_EVENT }] },
  async ({ event, step }) => {
    const data = event.data as Record<string, unknown>;
    const runKey = String(data.runKey);
    const waitTimeoutMs = typeof data.waitTimeoutMs === "number" ? data.waitTimeoutMs : 600_000;

    appendLine(runKey, "invocations", `invocation\t${new Date().toISOString()}`);

    await step.run("persist-step", async () => {
      const persistedAt = new Date().toISOString();
      appendLine(runKey, "marker", `persist-step\t${persistedAt}`);
      return { persistedAt };
    });

    const signal = await step.waitForEvent("wait-for-signal", {
      event: SIGNAL_EVENT,
      timeout: waitTimeoutMs,
      // NOTE: no `if` filter — dev server 1.44.0's expression compiler rejects
      // `data.x` references in waitForEvent matchers (InvalidExpression; see
      // ADR-0008 spike friction notes). Sole workflow + sole signal event in
      // this dev server, so unfiltered matching is acceptable here.
    });

    await step.run("finalize", async () => {
      const completedAt = new Date().toISOString();
      const outcome = signal ? "received" : "timeout";
      appendLine(runKey, "marker", `complete\tsignal=${outcome}\t${completedAt}`);
      return { completedAt, signal: outcome };
    });

    return { status: "done", signal: signal ? "received" : "timeout" };
  },
);
