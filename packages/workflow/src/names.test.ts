import { describe, expect, it } from "vitest";
import {
  approvalEvent,
  approvalStepId,
  assertWorkflowToken,
  signalEvent,
  signalStepId,
  toPortStatus,
  waitKindFromStepId,
  workflowStartEvent,
  WorkflowNameError,
} from "./names.js";

describe("event and step naming", () => {
  it("derives per-workflow trigger events", () => {
    expect(workflowStartEvent("ingest-capture")).toBe(
      "jehad/workflow/ingest-capture/start",
    );
  });

  it("derives per-run signal and approval events", () => {
    expect(signalEvent("01ABC", "go")).toBe("jehad/signal/01ABC/go");
    expect(approvalEvent("01ABC", "release")).toBe("jehad/approval/01ABC/release");
  });

  it("derives wait step ids that carry the wait kind", () => {
    expect(signalStepId("go")).toBe("wait:signal:go");
    expect(approvalStepId("release")).toBe("wait:approval:release");
  });

  it("rejects names that would break event or step addressing", () => {
    expect(() => assertWorkflowToken("workflow name", "Bad Name")).toThrow(
      WorkflowNameError,
    );
    expect(() => assertWorkflowToken("signal name", "a/b")).toThrow(WorkflowNameError);
    expect(() => assertWorkflowToken("step id", "open:run")).toThrow(WorkflowNameError);
    expect(() => workflowStartEvent("")).toThrow(WorkflowNameError);
  });
});

describe("status mapping helpers", () => {
  it("waitKindFromStepId classifies paused step ids", () => {
    expect(waitKindFromStepId("wait:signal:go")).toBe("waiting_signal");
    expect(waitKindFromStepId("wait:approval:release")).toBe("waiting_approval");
    expect(waitKindFromStepId("open:approval:x")).toBeNull();
    expect(waitKindFromStepId("extract")).toBeNull();
  });

  it("toPortStatus collapses waits per the port placeholder, keeps the rest", () => {
    expect(toPortStatus("waiting_signal")).toBe("waiting");
    expect(toPortStatus("waiting_approval")).toBe("waiting");
    expect(toPortStatus("running")).toBe("running");
    expect(toPortStatus("completed")).toBe("completed");
    expect(toPortStatus("cancelled")).toBe("cancelled");
    expect(toPortStatus("failed")).toBe("failed");
  });
});
