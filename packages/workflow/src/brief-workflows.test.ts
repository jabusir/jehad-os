// Smoke tests for the scheduled brief/close workflow definitions (M6B):
// the exported registration array carries valid shapes (cron kind, 5-field
// cron, NAME_RE-safe names, callable fns), compiles through the real serve
// path, and honors the UTC time-window guard. Hermetic — no DB, no executor
// (fake timers pin the clock).

import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowWorkerServer } from "./index.js";
import { assertWorkflowToken } from "./names.js";
import {
  briefWorkflows,
  EVENING_CLOSE_UTC_HOUR,
  eveningCloseWorkflow,
  isUtcHour,
  MORNING_BRIEF_UTC_HOUR,
  morningBriefWorkflow,
} from "./brief-workflows.js";

const FIVE_FIELD_CRON_RE = /^(\S+ ){4}\S+$/;

function fakeContext(stepRun: (id: string) => Promise<unknown>) {
  return {
    input: undefined,
    runId: "test-run",
    workflow: "brief-morning",
    step: { run: stepRun, sleep: async () => undefined },
    waitForSignal: async () => null,
    pauseForApproval: async () => ({ approved: false }),
  } as const;
}

describe("brief workflow registration (smoke)", () => {
  it("exports the morning + evening definitions with valid shapes", () => {
    expect(briefWorkflows).toHaveLength(2);
    for (const def of briefWorkflows) {
      expect(def.kind).toBe("cron");
      expect(() => assertWorkflowToken("workflow name", def.name)).not.toThrow();
      expect(def.cron).toMatch(FIVE_FIELD_CRON_RE);
      expect(typeof def.fn).toBe("function");
    }
    expect(briefWorkflows).toContain(morningBriefWorkflow);
    expect(briefWorkflows).toContain(eveningCloseWorkflow);
  });

  it("pins the names, crons, and UTC windows", () => {
    expect(morningBriefWorkflow).toMatchObject({ name: "brief-morning", cron: "0 * * * *" });
    expect(eveningCloseWorkflow).toMatchObject({ name: "brief-evening", cron: "0 21 * * *" });
    expect(MORNING_BRIEF_UTC_HOUR).toBe(7);
    expect(EVENING_CLOSE_UTC_HOUR).toBe(21);
  });

  it("serves through the worker server (compiles to executor functions)", () => {
    const server = createWorkflowWorkerServer({ workflows: [...briefWorkflows] });
    expect(typeof server.listen).toBe("function");
    server.close();
  });

  it("isUtcHour matches only its UTC hour", () => {
    expect(isUtcHour(new Date("2026-09-17T07:00:00.000Z"), 7)).toBe(true);
    expect(isUtcHour(new Date("2026-09-17T07:59:59.999Z"), 7)).toBe(true);
    expect(isUtcHour(new Date("2026-09-17T08:00:00.000Z"), 7)).toBe(false);
    // 07:00 in a non-UTC offset is NOT the 07:00 UTC window.
    expect(isUtcHour(new Date("2026-09-17T07:00:00+02:00"), 7)).toBe(false);
    expect(isUtcHour(new Date("2026-09-17T21:00:00.000Z"), 21)).toBe(true);
  });

  it("workflow body no-ops outside its UTC window (no step, no DB)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T08:30:00.000Z")); // outside both windows
      const mustNotRun = async (): Promise<never> => {
        throw new Error("step must not run outside the window");
      };
      const morning = await morningBriefWorkflow.fn(fakeContext(mustNotRun));
      const evening = await eveningCloseWorkflow.fn(fakeContext(mustNotRun));
      expect(morning).toEqual({ skippedWindow: true });
      expect(evening).toEqual({ skippedWindow: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("workflow body runs its render step inside the window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T07:00:00.000Z"));
      const sentinel = { suppressed: false } as const;
      const ran: string[] = [];
      const result = await morningBriefWorkflow.fn(
        fakeContext(async (id) => {
          ran.push(id);
          return sentinel;
        }),
      );
      expect(ran).toEqual(["render-morning-brief"]);
      expect(result).toEqual({ outcome: sentinel });

      vi.setSystemTime(new Date("2026-09-17T21:00:00.000Z"));
      const closeResult = await eveningCloseWorkflow.fn(
        fakeContext(async (id) => {
          ran.push(id);
          return sentinel;
        }),
      );
      expect(ran).toEqual(["render-morning-brief", "render-evening-close"]);
      expect(closeResult).toEqual({ outcome: sentinel });
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
