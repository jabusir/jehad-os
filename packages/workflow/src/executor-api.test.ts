import { describe, expect, it } from "vitest";
import { mapExecutorDetail, type ExecutorRunDetail } from "./executor-api.js";

const detail = (status: string, waitingStepIds: readonly string[] = []): ExecutorRunDetail => ({
  status,
  waitingStepIds,
});

describe("mapExecutorDetail (truthful gql/trace view only)", () => {
  it("maps terminal executor states", () => {
    expect(mapExecutorDetail(detail("COMPLETED"))).toBe("completed");
    expect(mapExecutorDetail(detail("FAILED"))).toBe("failed");
    expect(mapExecutorDetail(detail("CANCELLED"))).toBe("cancelled");
  });

  it("maps never-started runs to failed", () => {
    expect(mapExecutorDetail(detail("SKIPPED"))).toBe("failed");
  });

  it("maps parked runs by their waiting step id, not by RUNNING label", () => {
    expect(mapExecutorDetail(detail("RUNNING", ["wait:signal:go"]))).toBe(
      "waiting_signal",
    );
    expect(mapExecutorDetail(detail("RUNNING", ["wait:approval:release"]))).toBe(
      "waiting_approval",
    );
    // ADR-0008 friction note 4: the events-runs API reports "Completed"
    // while parked; this mapping only ever sees the gql/trace view.
    expect(mapExecutorDetail(detail("Completed", ["wait:signal:go"]))).toBe(
      "waiting_signal",
    );
  });

  it("maps un-parked active runs to running", () => {
    expect(mapExecutorDetail(detail("RUNNING"))).toBe("running");
    expect(mapExecutorDetail(detail("QUEUED"))).toBe("running");
    expect(mapExecutorDetail(detail("RUNNING", ["extract"]))).toBe("running");
  });
});
