import { describe, expect, it } from "vitest";
import {
  createWorkflowWorkerServer,
  gmailSyncWorkflow,
  calendarOccurrenceSweepWorkflow,
  calibrationWorkflows,
} from "@jehad/workflow";
import { main } from "./index.js";
import { workflows } from "./workflows.js";

describe("@jehad/worker", () => {
  it("exposes the thin serving entry (M3 shape)", () => {
    expect(typeof main).toBe("function");
  });

  it("registers its workflows through @jehad/workflow exports only", () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      expect(["event", "cron"]).toContain(workflow.kind);
    }
    const server = createWorkflowWorkerServer({ workflows });
    expect(typeof server.listen).toBe("function");
    server.close();
  });

  it("registers gmail-sync exactly once (idempotent registration)", () => {
    expect(workflows).toContain(gmailSyncWorkflow);
    const gmail = workflows.filter((workflow) => workflow.name === "gmail-sync");
    expect(gmail).toHaveLength(1);
    expect(gmail[0]).toMatchObject({ kind: "cron", cron: "*/5 * * * *" });
    const names = workflows.map((workflow) => workflow.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers calendar-occurrence-sweep exactly once (W5b hourly sweep)", () => {
    expect(workflows).toContain(calendarOccurrenceSweepWorkflow);
    const sweeps = workflows.filter((workflow) => workflow.name === "calendar-occurrence-sweep");
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ kind: "cron", cron: "0 * * * *" });
    const names = workflows.map((workflow) => workflow.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers both calibration workflows exactly once (idempotent registration)", () => {
    for (const def of calibrationWorkflows) {
      expect(workflows).toContain(def);
      expect(workflows.filter((workflow) => workflow.name === def.name)).toHaveLength(1);
    }
    expect(workflows).toContainEqual(
      expect.objectContaining({ kind: "cron", name: "calibration-daily", cron: "30 * * * *" }),
    );
    expect(workflows).toContainEqual(
      expect.objectContaining({ kind: "cron", name: "calibration-weekly", cron: "0 * * * *" }),
    );
    const names = workflows.map((workflow) => workflow.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
