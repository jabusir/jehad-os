import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "./scenarios.js";
import { runConversationEval } from "./runner.js";
import type { ConversationEvalRun, ScenarioResult } from "./runner.js";

const CAPABILITY_EXPORT_PATTERNS: Readonly<Record<string, RegExp>> = {
  "day.state": /day[\s_.-]?state/i,
  staleness: /staleness|freshness|last[_-]?synced/i,
  "memory.recall": /memory[\s_.-]?recall|recallMemory/i,
  "system.state": /system[\s_.-]?state|collectSystemState/i,
};

export async function probeCoreCapabilities(capabilities: readonly string[]): Promise<Record<string, boolean>> {
  const core = (await import("@jehad/core")) as unknown as Record<string, unknown>;
  const exportNames = Object.keys(core);
  const probes: Record<string, boolean> = {};
  for (const capability of capabilities) {
    const pattern = CAPABILITY_EXPORT_PATTERNS[capability];
    probes[capability] = pattern !== undefined && exportNames.some((name) => pattern.test(name));
  }
  return probes;
}

function scenarioSummary(result: ScenarioResult): string {
  if (result.status === "skip") return result.reason ?? "skipped";
  const last = result.turns.at(-1);
  if (last === undefined) return "no turns";
  const reply = last.reply === null ? "(no reply)" : `reply="${last.reply.slice(0, 60)}"`;
  return `final tools=[${last.routedTools.join(", ")}] ${reply}`;
}

function print(run: ConversationEvalRun): void {
  console.log("Jehad OS conversation eval — hermetic (fake provider, real pipeline, no network)");
  console.log("");
  for (const result of run.results) {
    console.log(`${result.status.toUpperCase().padEnd(4)}  ${result.id.padEnd(26)} ${scenarioSummary(result)}`);
  }
  console.log("");
  const failures = run.results.filter((result) => result.status === "fail");
  if (failures.length > 0) {
    console.log("Failures");
    for (const result of failures) {
      console.log(`  ${result.id}`);
      for (const failure of result.failures) console.log(`    - ${failure}`);
    }
    console.log("");
  }
  const { pass, fail, skip } = run.counts;
  console.log(`${pass} pass · ${fail} fail · ${skip} skip (skips are capabilities not yet exported by core)`);
}

async function main(): Promise<number> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("eval:conversation: TEST_DATABASE_URL is required (hermetic test database)");
    return 1;
  }
  const scenariosDir = path.dirname(fileURLToPath(new URL("./scenarios.yaml", import.meta.url)));
  const scenarioFiles = (await readdir(scenariosDir))
    .filter((name) => name.endsWith(".yaml"))
    .sort();
  const scenarios = scenarioFiles.flatMap((name) =>
    loadScenarioFile(path.join(scenariosDir, name)).scenarios,
  );
  const requires = [...new Set(scenarios.flatMap((scenario) => [...scenario.requires]))];
  const probes = await probeCoreCapabilities(requires);
  const run = await runConversationEval({
    databaseUrl,
    scenarios,
    capabilityProbes: probes,
    dbTag: "conv_eval_cli",
  });
  print(run);
  const passed = run.counts.fail === 0;
  console.log(passed ? "\nEVAL PASSED" : "\nEVAL FAILED");
  return passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("conversation eval crashed:", error);
      process.exitCode = 1;
    },
  );
}
