// Live eval tier tests. Skip semantics are hermetic (no network, no key,
// no database); the run tests need TEST_DATABASE_URL and exercise the
// callModel composition (egress gate → A13 budget → dispatch → ledger)
// on a real isolated Postgres — with the deterministic fake in
// EVAL_FAKE_LIVE mode, and with a stubbed local HTTP server for the real
// OpenRouter provider path. No real API key is ever required.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { loadDefaultGoldenSet } from "./golden.js";
import { DEFAULT_EVAL_MODEL, runLiveEval } from "./live.js";
import { runHermeticEval } from "./runner.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("runLiveEval skip semantics (hermetic)", () => {
  it("skips cleanly with a clear message when the API key is absent (real mode)", async () => {
    const result = await runLiveEval({ apiKey: "", fakeLive: false, databaseUrl: TEST_DATABASE_URL });
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.reason).toBe("missing-api-key");
      expect(result.message).toMatch(/OPENROUTER_API_KEY/);
    }
  });

  it("treats a whitespace key as absent", async () => {
    const result = await runLiveEval({ apiKey: "   ", fakeLive: false, databaseUrl: TEST_DATABASE_URL });
    expect(result).toMatchObject({ skipped: true, reason: "missing-api-key" });
  });

  it("skips with missing-database when TEST_DATABASE_URL is absent (fake-live needs the ledger too)", async () => {
    const result = await runLiveEval({ fakeLive: true, databaseUrl: undefined });
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.reason).toBe("missing-database");
      expect(result.message).toMatch(/TEST_DATABASE_URL/);
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("runLiveEval — EVAL_FAKE_LIVE through the real callModel path", () => {
  it("produces identical metrics to the hermetic tier, one ok ledger row per item, spend reported", async () => {
    const live = await runLiveEval({ fakeLive: true, databaseUrl: TEST_DATABASE_URL, sleepMs: 0 });
    expect(live.skipped).toBe(false);
    if (live.skipped) return;

    const hermetic = await runHermeticEval();
    expect(live.run.report).toEqual(hermetic.report);
    expect(live.run.gates).toEqual(hermetic.gates);
    expect(live.run.categories).toEqual(hermetic.categories);
    expect(live.run.meta.tier).toBe("live");
    expect(live.run.meta.fakeLive).toBe(true);
    expect(live.run.meta.model).toBe(DEFAULT_EVAL_MODEL);

    expect(live.ledger.rows).toBe(hermetic.report.n);
    expect(live.ledger.errorRows).toBe(0);
    expect(live.spend.calls).toBe(hermetic.report.n);
    expect(live.spend.totalUsd).toBe(0); // the fake provider reports no usage
    expect(live.parseFailures).toEqual([]);
    expect(live.hygiene.checks.map((c) => c.id)).toContain("hard-injection-01");
    expect(live.hygiene.passed).toBe(true);
  }, { timeout: 120_000 });
});

describe.skipIf(!TEST_DATABASE_URL)("runLiveEval — real provider path against a stubbed OpenRouter", () => {
  it("egress policy allows openrouter, usage lands in the ledger, spend is reported; the key never leaks into the result", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        void body;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "stub-completion-1",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    is_commitment: false,
                    confidence: 0.2,
                    commitment_state: "historical",
                    temporal_expression: null,
                    rationale: "stub",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const items = loadDefaultGoldenSet().items.slice(0, 2);
      const live = await runLiveEval({
        apiKey: "stub-key-never-a-real-secret",
        databaseUrl: TEST_DATABASE_URL,
        sleepMs: 0,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        items,
      });
      expect(live.skipped).toBe(false);
      if (live.skipped) return;
      expect(live.run.meta.provider).toBe("openrouter");
      expect(live.ledger.rows).toBe(2);
      expect(live.ledger.errorRows).toBe(0);
      expect(live.spend.totalUsd).toBeCloseTo(0.0002, 10);
      expect(live.ledger.totalCostUsd).toBeCloseTo(0.0002, 10);
      expect(JSON.stringify(live)).not.toContain("stub-key-never-a-real-secret");
    } finally {
      server.close();
    }
  }, { timeout: 60_000 });
});
