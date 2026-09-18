// Renderer tests (M6D): renderMetricsText is pure string formatting — output
// must be stable (golden string) for a fixed MetricsReport, including the
// empty report (zeros, not crashes) and formatting boundaries.

import { describe, expect, it } from "vitest";
import type { MetricsReport } from "./compute.js";
import { formatMs, formatUsd, renderMetricsText, shortRunId } from "./render.js";

const run = (n: number): string =>
  `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

const FIXTURE: MetricsReport = {
  window: { since: "2026-09-10T00:00:00.000Z", generatedAt: "2026-09-17T06:00:00.000Z" },
  humanBlocked: {
    totalMs: 5_490_000,
    openWaits: 1,
    byReason: [
      {
        reason: "approval_required",
        waits: 9,
        totalMs: 4_260_000,
        percentiles: { p50: 240_000, p90: 1_800_000, p99: 1_800_000 },
      },
      {
        reason: "unknown",
        waits: 1,
        totalMs: 1_200_000,
        percentiles: { p50: 1_200_000, p90: 1_200_000, p99: 1_200_000 },
      },
      {
        reason: "missing_credentials",
        waits: 1,
        totalMs: 30_000,
        percentiles: { p50: 30_000, p90: 30_000, p99: 30_000 },
      },
    ],
    perRun: [
      { runId: run(0xaaaaaaaa), waits: 2, totalMs: 1_950_000 },
      { runId: run(0xbbbbbbbb), waits: 3, totalMs: 1_560_000 },
      { runId: run(0xcccccccc), waits: 3, totalMs: 1_020_000 },
      { runId: run(0xdddddddd), waits: 2, totalMs: 900_000 },
      { runId: run(0xeeeeeeee), waits: 1, totalMs: 60_000 },
    ],
  },
  interruptions: { resolvedWaits: 11, interruptiveVerdicts: 2, total: 13, distinctDays: 3, perDay: 13 / 3 },
  signalQuality: {
    total: 10,
    counts: { useful: 6, noise: 2, missed: 1, incorrect: 1, interruptive: 0 },
    rates: { useful: 0.6, noise: 0.2, missed: 0.1, incorrect: 0.1, interruptive: 0 },
    byItemType: [
      { itemType: "notification", total: 6, counts: { useful: 3, noise: 2, missed: 0, incorrect: 1, interruptive: 0 } },
      { itemType: "attention_item", total: 3, counts: { useful: 3, noise: 0, missed: 0, incorrect: 0, interruptive: 0 } },
      { itemType: "brief_section", total: 1, counts: { useful: 0, noise: 0, missed: 1, incorrect: 0, interruptive: 0 } },
    ],
    falseAttentionRate: 0.25,
  },
  autonomousCompletion: { completedRuns: 3, endedRuns: 4, cancelledExcluded: 1, rate: 0.75 },
  falseEscalation: { resolved: 3, notNeeded: 1, rate: 1 / 3 },
  modelCost: {
    totalUsd: 0.0425,
    calls: 5,
    byProviderModel: [
      { provider: "openrouter", model: "anthropic/claude-3.5-sonnet", calls: 2, costUsd: 0.03 },
      { provider: "openrouter", model: "openai/gpt-4o", calls: 2, costUsd: 0.0125 },
      { provider: "ollama", model: "llama3", calls: 1, costUsd: 0 },
    ],
    topRuns: [
      { runId: run(0xaaaaaaaa), costUsd: 0.03 },
      { runId: run(0xdddddddd), costUsd: 0.0075 },
      { runId: run(0xcccccccc), costUsd: 0.005 },
      { runId: run(0xbbbbbbbb), costUsd: 0 },
    ],
  },
  workflowStatus: {
    statuses: [
      { status: "blocked", runs: 1 },
      { status: "cancelled", runs: 1 },
      { status: "completed", runs: 3 },
      { status: "failed", runs: 1 },
    ],
  },
  failures: {
    actionAttempts: { failed: 1, unknown: 1 },
    outboxErrors: [
      { signature: "ECONNREFUSED 127.0.0.1:5432", count: 2 },
      { signature: "timeout after 30000ms", count: 1 },
    ],
  },
};

const EMPTY: MetricsReport = {
  window: { since: null, generatedAt: "2026-09-17T06:00:00.000Z" },
  humanBlocked: { totalMs: 0, openWaits: 0, byReason: [], perRun: [] },
  interruptions: { resolvedWaits: 0, interruptiveVerdicts: 0, total: 0, distinctDays: 0, perDay: 0 },
  autonomousCompletion: { completedRuns: 0, endedRuns: 0, cancelledExcluded: 0, rate: 0 },
  falseEscalation: { resolved: 0, notNeeded: 0, rate: 0 },
  modelCost: { totalUsd: 0, calls: 0, byProviderModel: [], topRuns: [] },
  workflowStatus: { statuses: [] },
  failures: { actionAttempts: { failed: 0, unknown: 0 }, outboxErrors: [] },
  signalQuality: null,
};

describe("renderMetricsText", () => {
  it("renders the §14 rollup tables (golden string)", () => {
    expect(renderMetricsText(FIXTURE)).toEqual(`Jehad OS metrics — window since 2026-09-10T00:00:00.000Z, generated 2026-09-17T06:00:00.000Z

human blocked time (derived from human_waits — plan §14)
  total blocked: 1h 31m  (open waits now: 1)
  by escalation reason:
    reason               waits   total     p50     p90     p99
    approval_required        9  1h 11m   4m 0s  30m 0s  30m 0s
    unknown                  1  20m 0s  20m 0s  20m 0s  20m 0s
    missing_credentials      1     30s     30s     30s     30s
  runs by blocked time (top 5):
    run       waits  blocked
    aaaaaaaa      2  32m 30s
    bbbbbbbb      3   26m 0s
    cccccccc      3   17m 0s
    dddddddd      2   15m 0s
    eeeeeeee      1    1m 0s

interruptions
  resolved waits 11 + interruptive verdicts 2 = 13 over 3 distinct days → 4.33/day

signal quality (dogfooding feedback — plan: signal, not parsing)
  verdicts: 10 (useful 6, noise 2, missed 1, incorrect 1, interruptive 0)
  rates: useful 60.0% · noise 20.0% · missed 10.0% · incorrect 10.0% · interruptive 0.0%
  false attention rate: 25.0% (noise / (noise + useful) on notification/attention items)
  by item type:
    item_type       total  useful  noise  missed  incorrect  interruptive
    notification        6       3      2       0          1             0
    attention_item      3       3      0       0          0             0
    brief_section       1       0      0       1          0             0

autonomous completion
  completed 3 / 4 ended runs (1 cancelled excluded) → 75.0%

false escalations
  not_needed 1 / 3 resolved → 33.3%

model cost
  total: $0.0425 across 5 calls
  by provider/model:
    provider    model                        calls     cost
    openrouter  anthropic/claude-3.5-sonnet      2  $0.0300
    openrouter  openai/gpt-4o                    2  $0.0125
    ollama      llama3                           1  $0.0000
  top runs by spend:
    run          cost
    aaaaaaaa  $0.0300
    dddddddd  $0.0075
    cccccccc  $0.0050
    bbbbbbbb  $0.0000

runs by status (snapshot — current state, unwindowed)
  status     runs
  blocked       1
  cancelled     1
  completed     3
  failed        1

failures
  action attempts: 1 failed, 1 unknown
  outbox error signatures:
    count  signature
        2  ECONNREFUSED 127.0.0.1:5432
        1  timeout after 30000ms
`);
  });

  it("renders an empty report with zeros and placeholders, not crashes", () => {
    const text = renderMetricsText(EMPTY);
    expect(text).toContain("Jehad OS metrics — all time");
    expect(text).toContain("total blocked: 0ms  (open waits now: 0)");
    expect(text).toContain("no resolved waits in window");
    expect(text).toContain("no blocked runs in window");
    expect(text).toContain("resolved waits: 0, interruptive verdicts: 0 (nothing in window)");
    expect(text).toContain("no feedback recorded in window (rates null, not zero)");
    expect(text).toContain("→ 0.0%");
    expect(text).toContain("total: $0.0000 across 0 calls");
    expect(text).toContain("no runs");
    expect(text).toContain("action attempts: 0 failed, 0 unknown");
    expect(text).toContain("no failed outbox rows in window");
    expect(text).not.toMatch(/ +\n/);
  });
});

describe("formatting helpers", () => {
  it("formatMs covers unit boundaries", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(999)).toBe("999ms");
    expect(formatMs(1000)).toBe("1s");
    expect(formatMs(59_000)).toBe("59s");
    expect(formatMs(60_000)).toBe("1m 0s");
    expect(formatMs(3_599_000)).toBe("59m 59s");
    expect(formatMs(3_600_000)).toBe("1h 0m");
    expect(formatMs(5_490_000)).toBe("1h 31m");
  });

  it("formatUsd and shortRunId", () => {
    expect(formatUsd(0.0425)).toBe("$0.0425");
    expect(formatUsd(0)).toBe("$0.0000");
    expect(shortRunId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("aaaaaaaa");
  });
});
