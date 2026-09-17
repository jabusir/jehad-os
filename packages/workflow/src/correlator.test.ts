import { describe, expect, it } from "vitest";
import { createSqlRunCorrelator, type SqlQueryExecutor } from "./correlator.js";

function recordingExecutor(): SqlQueryExecutor & { calls: Array<{ text: string; values?: readonly unknown[] }> } {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows: [] };
    },
  };
}

const opts = { principalId: "p-1", domainId: "d-1" };

describe("createSqlRunCorrelator (hermetic: SQL shape)", () => {
  it("runStarted writes an idempotent runs row keyed by workflow_id", async () => {
    const exec = recordingExecutor();
    await createSqlRunCorrelator(exec, opts).runStarted({
      runId: "r-1",
      workflow: "ingest",
      intent: "cron:brief",
    });
    const call = exec.calls[0]!;
    expect(call.text).toContain("INSERT INTO runs");
    expect(call.text).toContain("WHERE NOT EXISTS (SELECT 1 FROM runs WHERE workflow_id = $1)");
    expect(call.values).toEqual(["r-1", "p-1", "cron:brief", "d-1"]);
  });

  it("runStatus stamps ended_at only for terminal statuses", async () => {
    const exec = recordingExecutor();
    const correlator = createSqlRunCorrelator(exec, opts);
    await correlator.runStatus({ runId: "r-1", status: "waiting_approval" });
    await correlator.runStatus({ runId: "r-1", status: "completed" });
    const [nonTerminal, terminal] = exec.calls as Array<{ values: readonly unknown[] }>;
    expect(nonTerminal.values).toEqual(["r-1", "waiting_approval", false]);
    expect(terminal.values).toEqual(["r-1", "completed", true]);
  });

  it("approvalOpened keys human_waits by run + approval-prefixed reason, exactly once", async () => {
    const exec = recordingExecutor();
    await createSqlRunCorrelator(exec, opts).approvalOpened({
      runId: "r-1",
      approvalId: "release",
      reason: "needs owner sign-off",
    });
    const call = exec.calls[0]!;
    expect(call.text).toContain("INSERT INTO human_waits");
    expect(call.values?.[1]).toBe("approval:release needs owner sign-off");
    expect(call.text).toContain("hw.resolved_at IS NULL");
  });

  it("approvalResolved closes only that approval's open row", async () => {
    const exec = recordingExecutor();
    await createSqlRunCorrelator(exec, opts).approvalResolved({
      runId: "r-1",
      approvalId: "release",
    });
    const call = exec.calls[0]!;
    expect(call.text).toContain("UPDATE human_waits");
    expect(call.text).toContain("hw.reason LIKE $2");
    expect(call.values).toEqual(["r-1", "approval:release%"]);
  });

  it("openWaitsResolved closes every open row for a run (cancel path)", async () => {
    const exec = recordingExecutor();
    await createSqlRunCorrelator(exec, opts).openWaitsResolved({ runId: "r-1" });
    const call = exec.calls[0]!;
    expect(call.text).toContain("UPDATE human_waits");
    expect(call.text).toContain("hw.resolved_at IS NULL");
    expect(call.values).toEqual(["r-1"]);
  });
});
