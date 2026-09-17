import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  createWorkflowWorkerServer,
  defineWorkflow,
  defineScheduledWorkflow,
} from "./index.js";

describe("@jehad/workflow", () => {
  it("exports the M3 adapter surface (port types, runtime, authoring, serve)", () => {
    expect(typeof createWorkflowRuntime).toBe("function");
    expect(typeof createWorkflowWorkerServer).toBe("function");
    expect(typeof defineWorkflow).toBe("function");
    expect(typeof defineScheduledWorkflow).toBe("function");
  });

  it("createWorkflowWorkerServer returns a plain node http server (ADR-0008 serve shape)", () => {
    const server = createWorkflowWorkerServer({
      workflows: [defineWorkflow({ name: "smoke", fn: async () => null })],
    });
    expect(typeof server.listen).toBe("function");
    expect(typeof server.close).toBe("function");
    server.close();
  });
});
