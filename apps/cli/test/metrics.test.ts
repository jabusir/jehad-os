// josctl metrics unit tests — hermetic: fake MetricsDb factory returning
// canned rows per query, no Postgres, no Keychain, no network. Args parsing +
// output shape + error paths.

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  METRICS_USAGE,
  parseMetricsArgs,
  runMetricsCommand,
  type MetricsDbFactory,
} from "../src/commands/metrics";

function captureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

interface Recording {
  queryTexts: string[];
  endCalls: number;
  url: string;
}

/** Fake db whose canned rows make computeMetrics render the fixture below. */
function fakeFactory(fail?: Error): { factory: MetricsDbFactory; recording: Recording } {
  const recording: Recording = { queryTexts: [], endCalls: 0, url: "" };
  const rowsFor = (text: string): Record<string, unknown>[] => {
    if (text.includes("FROM human_waits hw")) {
      // 11 resolved waits, 5490s total (1h 31m).
      return [{ run_id: "r-1", reason: "approval_required", duration_ms: 5_490_000 }];
    }
    if (text.includes("resolved_at IS NULL")) return [{ n: 1 }];
    if (text.includes("both_days")) return [{ resolved: 11, interruptive: 2, days: 3 }];
    if (text.includes("fa_noise")) {
      // signal quality: 5 verdicts, false-attention 1/(1+2).
      return [{ useful: 2, noise: 1, missed: 0, incorrect: 0, interruptive: 2, total: 5, fa_noise: 1, fa_useful: 2 }];
    }
    if (text.includes("GROUP BY item_type")) {
      return [{ item_type: "notification", total: 5, useful: 2, noise: 1, missed: 0, incorrect: 0, interruptive: 2 }];
    }
    if (text.includes("FROM runs")) {
      if (text.includes("ended_at")) return [{ completed: 3, cancelled: 1, ended_total: 5 }];
      return [{ status: "completed", runs: 3 }];
    }
    if (text.includes("FROM escalations")) return [{ resolved_total: 3, not_needed: 1 }];
    if (text.includes("COALESCE(SUM(cost_usd)")) return [{ total_usd: "0.0425", calls: 5 }];
    if (text.includes("FROM outbox")) return [];
    if (text.includes("FROM action_attempts")) {
      return [
        { outcome: "failed", n: 1 },
        { outcome: "unknown", n: 1 },
      ];
    }
    return []; // by-provider/model, top-runs group-bys
  };
  const factory: MetricsDbFactory = (url) => {
    recording.url = url;
    return {
      query: async (text: string) => {
        if (fail) throw fail;
        recording.queryTexts.push(text);
        return { rows: rowsFor(text) };
      },
      end: async () => {
        recording.endCalls += 1;
      },
    };
  };
  return { factory, recording };
}

describe("parseMetricsArgs", () => {
  it("accepts bare metrics and --since ISO", () => {
    expect(parseMetricsArgs(["node", "josctl", "metrics"])).toEqual({});
    expect(parseMetricsArgs(["node", "josctl", "metrics", "--since", "2026-09-10T00:00:00Z"])).toEqual({
      since: "2026-09-10T00:00:00Z",
    });
  });

  it("rejects other commands, bad flags, and unparseable dates", () => {
    expect(parseMetricsArgs(["node", "josctl", "capture", "x"])).toBeNull();
    expect(parseMetricsArgs(["node", "josctl", "metrics", "--until", "x"])).toBeNull();
    expect(parseMetricsArgs(["node", "josctl", "metrics", "--since"])).toBeNull();
    expect(parseMetricsArgs(["node", "josctl", "metrics", "--since", "not-a-date"])).toBeNull();
  });
});

describe("runMetricsCommand", () => {
  it("queries the DB directly via DATABASE_URL and renders the report (exit 0)", async () => {
    const { factory, recording } = fakeFactory();
    const out = captureStream();
    const errOut = captureStream();
    const code = await runMetricsCommand(["node", "josctl", "metrics"], {
      databaseUrl: "postgres://localhost:5432/jehad_test",
      output: out.stream,
      errOutput: errOut.stream,
      connect: factory,
    });

    expect(code).toBe(0);
    expect(recording.url).toBe("postgres://localhost:5432/jehad_test");
    expect(recording.queryTexts.length).toBeGreaterThan(5); // read-only derived queries ran
    expect(recording.queryTexts.every((t) => /^\s*SELECT/.test(t))).toBe(true); // reads only
    expect(recording.endCalls).toBe(1); // pool closed
    expect(errOut.text()).toBe("");

    const text = out.text();
    expect(text).toContain("Jehad OS metrics");
    expect(text).toContain("human blocked time (derived from human_waits — plan §14)");
    expect(text).toContain("total blocked: 1h 31m  (open waits now: 1)");
    expect(text).toContain("interruptions");
    expect(text).toContain("resolved waits 11 + interruptive verdicts 2 = 13 over 3 distinct days → 4.33/day");
    expect(text).toContain("signal quality (dogfooding feedback");
    expect(text).toContain("verdicts: 5 (useful 2, noise 1, missed 0, incorrect 0, interruptive 2)");
    expect(text).toContain("false attention rate: 33.3% (noise / (noise + useful) on notification/attention items)");
    expect(text).toContain("completed 3 / 4 ended runs (1 cancelled excluded) → 75.0%");
    expect(text).toContain("not_needed 1 / 3 resolved → 33.3%");
    expect(text).toContain("total: $0.0425 across 5 calls");
    expect(text).toContain("runs by status");
    expect(text).toContain("action attempts: 1 failed, 1 unknown");
  });

  it("passes --since into the report window", async () => {
    const { factory } = fakeFactory();
    const out = captureStream();
    const code = await runMetricsCommand(["node", "josctl", "metrics", "--since", "2026-09-10T00:00:00Z"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: out.stream,
      errOutput: captureStream().stream,
      connect: factory,
    });
    expect(code).toBe(0);
    expect(out.text()).toContain("window since 2026-09-10T00:00:00.000Z");
  });

  it("exits 2 with usage on bad args, without touching the DB", async () => {
    const { factory, recording } = fakeFactory();
    const out = captureStream();
    const errOut = captureStream();
    const code = await runMetricsCommand(["node", "josctl", "metrics", "--since", "nope"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: out.stream,
      errOutput: errOut.stream,
      connect: factory,
    });
    expect(code).toBe(2);
    expect(errOut.text()).toBe(METRICS_USAGE);
    expect(out.text()).toBe("");
    expect(recording.queryTexts).toHaveLength(0);
  });

  it("exits 1 and still closes the pool when the DB is unreachable", async () => {
    const { factory, recording } = fakeFactory(new Error("ECONNREFUSED"));
    const errOut = captureStream();
    const code = await runMetricsCommand(["node", "josctl", "metrics"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: captureStream().stream,
      errOutput: errOut.stream,
      connect: factory,
    });
    expect(code).toBe(1);
    expect(errOut.text()).toContain("metrics query failed");
    expect(errOut.text()).toContain("ECONNREFUSED");
    expect(recording.endCalls).toBe(1);
  });
});
