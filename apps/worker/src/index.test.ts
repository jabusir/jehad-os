import { describe, expect, it } from "vitest";
import { createWorkflowWorkerServer } from "@jehad/workflow";
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
});
