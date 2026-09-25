import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioFile } from "./scenarios.js";
import { requiredCapabilities, runConversationEval } from "./runner.js";
import type { CognitiveTurnFn, ConversationEvalRun, ScenarioResult } from "./runner.js";

// §22 dual-window: legacy scenarios in this suite run through handleInbound,
// which reads the repo-root policy (now routing: single for dogfood) — pin
// the legacy fixture so legacy scripting stays valid; single-path scenarios
// are invoked directly (runCognitiveTurn) and never consult this flag.
process.env.POLICY_YAML_PATH ??= new URL("../../packages/core/src/imessage/legacy-routing.fixture.yaml", import.meta.url).pathname;

const CAPABILITY_EXPORT_PATTERNS: Readonly<Record<string, RegExp>> = {
  "day.state": /day[\s_.-]?state/i,
  staleness: /staleness|freshness|last[_-]?synced/i,
  "memory.recall": /memory[\s_.-]?recall|recallMemory/i,
  "system.state": /system[\s_.-]?state|collectSystemState/i,
  // W6(a) Turn Interpreter (R8): matches once core exports the interpreter
  // (e.g. interpretTurn / TURN_INTERPRETER_*). TRUTHFUL_UX_RULES deliberately
  // does not match either pattern.
  turn_interpreter: /turn[\s_.-]?interpret|Interpretation/i,
  // W6(b) live self-model (R9): matches once system.self_brief lands.
  self_brief: /self[\s_.-]?brief/i,
  // C11 (intelligence-reset §6): probes for the parallel reset lanes. Each
  // flips true only when core exports the lane's landing marker, so the
  // POST-state scenarios skip cleanly until the lane merges — then run as
  // hard gates. Deliberately shaped to NOT match today's exports (verified
  // against the core export list).
  // C1: the miss becomes a side effect + the answer pass still runs —
  // matches once the lane exports its miss-context seam (e.g.
  // buildCalibrationMissContext / CALIBRATION_MISS_SIDEEFFECT).
  calibration_miss_side_effect: /calibration[\s_.-]?miss[\s_.-]?(side[\s_.-]?effect|context)/i,
  // C2: configuration_directive gains address/tone keys routed into the
  // profile definition (e.g. PROFILE_ADDRESS_KEYS / applyAddressDirective).
  profile_address_keys: /profile[\s_.-]?address|address[\s_.-]?keys?[\s_.-]?(directive|routing)|preference[\s_.-]?routing/i,
  // Amendment 5 / §10: per-type pendingProposal slots + bare-yes salience
  // resolution (e.g. pendingProposalsByType / resolveSalientProposal).
  per_type_proposal_slots: /per[\s_.-]?type[\s_.-]?proposal|proposal[\s_.-]?salience|salient[\s_.-]?proposal|pending[\s_.-]?proposals?[\s_.-]?by[\s_.-]?type/i,
  // C4: gmail.search / gmail.read read tools over gmail_content (e.g.
  // gmailSearchRoutingLine / renderGmailSearchBlock — the gmailRoutingLine
  // convention). searchGmailContent (GC0 store query) deliberately does
  // NOT match.
  gmail_content_tools: /gmail[\s_.-]?(search|read)[\s_.-]?(tool|routing)|renderGmail(Search|Read)/i,
  // §22 (intelligence-reset §22.15 runner extension): the single-author
  // cognitive loop. Matches once core exports the loop entry (e.g.
  // runCognitiveTurn / COGNITIVE_TURN_LOOP) — verified NOT to match any
  // export at HEAD (the §22.11 deletion list is still in flight). The
  // loop builder satisfies the full harness contract documented on
  // CognitiveTurnFn in runner.ts: (deps, input) => ConverseOutcome &
  // {rounds?, intent?, ledger?}, model dispatch through deps.provider in
  // round order, reads consulting deps.readOverrides?.take(tool) before
  // the DB-backed tool, and the wall guard reading deps.now at each round
  // boundary. Until it lands, path: "single" scenarios skip cleanly.
  cognitive_turn: /cognitive[\s_.-]?turn/i,
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

/** §22: resolve the single-path turn entry — the (single) function export
 * whose name matches the cognitive_turn pattern. Returns null until the
 * loop builder lands the export; single-path scenarios then skip. */
export async function resolveCognitiveTurn(): Promise<CognitiveTurnFn | null> {
  const core = (await import("@jehad/core")) as unknown as Record<string, unknown>;
  const pattern = CAPABILITY_EXPORT_PATTERNS["cognitive_turn"]!;
  for (const name of Object.keys(core)) {
    if (pattern.test(name) && typeof core[name] === "function") {
      return core[name] as CognitiveTurnFn;
    }
  }
  return null;
}

function scenarioSummary(result: ScenarioResult): string {
  if (result.status === "skip") return result.reason ?? "skipped";
  const last = result.turns.at(-1);
  if (last === undefined) return "no turns";
  const reply = last.reply === null ? "(no reply)" : `reply="${last.reply.slice(0, 60)}"`;
  const single = last.rounds > 0 || last.intent !== null ? ` rounds=${last.rounds} intent=${last.intent ?? "-"}` : "";
  return `final tools=[${last.routedTools.join(", ")}] ${reply}${single}`;
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
  // §22: requiredCapabilities folds in the implicit cognitive_turn
  // requirement of path: "single" scenarios, so the probe set covers it.
  const requires = [...new Set(scenarios.flatMap((scenario) => [...requiredCapabilities(scenario)]))];
  const probes = await probeCoreCapabilities(requires);
  const run = await runConversationEval({
    databaseUrl,
    scenarios,
    capabilityProbes: probes,
    cognitiveTurn: (await resolveCognitiveTurn()) ?? undefined,
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
