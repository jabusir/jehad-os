import { describe, expect, it } from "vitest";
import { loadScenarioFile } from "./scenarios.js";
import { runConversationEval } from "./runner.js";
import { runCognitiveTurn } from "@jehad/core";
import { probeCoreCapabilities } from "./run.js";

// §22 dual-window: legacy scenarios in this suite run through handleInbound,
// which reads the repo-root policy (now routing: single for dogfood) — pin
// the legacy fixture so legacy scripting stays valid; single-path scenarios
// are invoked directly (runCognitiveTurn) and never consult this flag.
process.env.POLICY_YAML_PATH ??= new URL("../../packages/core/src/imessage/legacy-routing.fixture.yaml", import.meta.url).pathname;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const FILE = new URL("./scenarios-single-path.yaml", import.meta.url).pathname;

describe.skipIf(!TEST_DATABASE_URL)("scenarios-single-path.yaml (§22.15 golden batch, real cognitive loop)", () => {
  const scenarios = loadScenarioFile(FILE).scenarios;

  it("parses: 8 single-path scenarios", () => {
    expect(scenarios.length).toBe(8);
    expect(scenarios.every((s) => s.path === "single")).toBe(true);
  });

  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.description?.slice(0, 60) ?? ""}`, async () => {
      const run = await runConversationEval({
        databaseUrl: TEST_DATABASE_URL!,
        dbTag: `conv_single_${scenario.id.replace(/[^a-z0-9]+/gi, "_").slice(0, 24)}`,
        scenarios: [scenario as never],
        capabilityProbes: await probeCoreCapabilities(["cognitive_turn"]),
        cognitiveTurn: runCognitiveTurn as never,
      });
      const result = run.results[0]!;
      expect(result.failures).toEqual([]);
      expect(result.status).toBe("pass");
    });
  }
});
