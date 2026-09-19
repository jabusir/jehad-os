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
  BRIEF_LOCAL_TZ,
  EVENING_CLOSE_LOCAL_HOUR,
  eveningCloseWorkflow,
  isLocalHour,
  MORNING_BRIEF_LOCAL_HOUR,
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

  it("pins the names, crons, and local-hour windows", () => {
    expect(morningBriefWorkflow).toMatchObject({ name: "brief-morning", cron: "0 * * * *" });
    expect(eveningCloseWorkflow).toMatchObject({ name: "brief-evening", cron: "0 * * * *" });
    expect(MORNING_BRIEF_LOCAL_HOUR).toBe(6); // 6 AM PT
    expect(EVENING_CLOSE_LOCAL_HOUR).toBe(21); // 9 PM PT
    expect(BRIEF_LOCAL_TZ).toBe("America/Los_Angeles");
  });

  it("serves through the worker server (compiles to executor functions)", () => {
    const server = createWorkflowWorkerServer({ workflows: [...briefWorkflows] });
    expect(typeof server.listen).toBe("function");
    server.close();
  });

  it("isLocalHour matches only its PT hour (DST-safe)", () => {
    // PDT (UTC-7): 6 AM PT === 13:00 UTC
    expect(isLocalHour(new Date("2026-09-17T13:00:00.000Z"), 6)).toBe(true);
    expect(isLocalHour(new Date("2026-09-17T13:59:59.999Z"), 6)).toBe(true);
    expect(isLocalHour(new Date("2026-09-17T14:00:00.000Z"), 6)).toBe(false);
    expect(isLocalHour(new Date("2026-09-17T13:00:00.000Z"), 7)).toBe(false);
    // PST (UTC-8): 6 AM PT === 14:00 UTC in January
    expect(isLocalHour(new Date("2027-01-15T14:00:00.000Z"), 6)).toBe(true);
    expect(isLocalHour(new Date("2027-01-15T14:00:00.000Z"), 7)).toBe(false);
    // 9 PM PT === 04:00 UTC next day (PDT)
    expect(isLocalHour(new Date("2026-09-17T04:00:00.000Z"), 21)).toBe(true);
  });

  it("workflow body no-ops outside its local-hour window (no step, no DB)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T08:30:00.000Z")); // 1:30 AM PT — outside both windows
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
      vi.setSystemTime(new Date("2026-09-17T13:00:00.000Z")); // 6 AM PDT
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

      vi.setSystemTime(new Date("2026-09-17T04:00:00.000Z")); // 9 PM PDT (prev local day)
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
