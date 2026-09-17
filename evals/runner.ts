/**
 * Golden-set eval runner v2 (golden set v2 / lane W6B) — `pnpm eval`
 * (docs/evals.md §3.1; plan §13).
 *
 * Hermetic tier: REAL prompt builder → deterministic fake provider (v3
 * model shape) → eval v3 allowlist parse → reference normalizer → metrics.
 * No network, no key. The real v3 extraction pipeline is lane W6A's; the
 * eval tiers run the contract adapter (extraction-v3.ts) so the hermetic
 * tier is self-consistent before W6A merges — metrics consume the exact
 * TemporalProvenance/commitment_state shapes their lane will emit.
 *
 * Gates (golden v2): overall F1 ≥ 0.8; action-driving precision ≥ 0.9;
 * commitment-state accuracy ≥ 0.8. Normalizer accuracy is reported as a
 * DIAGNOSTIC (deterministic code is unit-tested in W6A). Exits nonzero
 * when any gate fails or injection hygiene fails. Also writes
 * evals/.last-hermetic.json — the deterministic baseline the live tier is
 * compared against (generated artifact, gitignored).
 */

import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEvalFakeProvider } from "./fake-provider.js";
import { runV3Extraction } from "./extraction-v3.js";
import { loadDefaultGoldenSet, envelopeFor } from "./golden.js";
import {
  computeEvalReport,
  evaluateGates,
  type EvalPrediction,
  type GoldenSet,
} from "./metrics.js";
import { isInjectionClean, perCategoryAccuracy, type TierRun } from "./tiers.js";

const EVAL_MODEL = "eval-fake-heuristic-v2";

export interface HermeticHygieneCheck {
  readonly id: string;
  readonly dropped: readonly string[];
  readonly clean: boolean;
}

export interface HermeticRun extends TierRun {
  readonly hygiene: {
    readonly checks: readonly HermeticHygieneCheck[];
    readonly passed: boolean;
    readonly johnOk: boolean;
  };
}

/** Runs the full hermetic tier and returns everything; no process I/O. */
export async function runHermeticEval(): Promise<HermeticRun> {
  const golden: GoldenSet = loadDefaultGoldenSet();
  const provider = createEvalFakeProvider();

  const predictions = new Map<string, EvalPrediction>();
  const injectionChecks: HermeticHygieneCheck[] = [];

  for (const [index, item] of golden.items.entries()) {
    const pipeline = await runV3Extraction(provider, envelopeFor(item, index), {
      model: EVAL_MODEL,
    });
    const prediction = pipeline.prediction;
    predictions.set(item.id, prediction);
    if (item.category === "prompt-injection") {
      injectionChecks.push({
        id: item.id,
        dropped: pipeline.droppedFields,
        clean: isInjectionClean(prediction),
      });
    }
  }

  const report = computeEvalReport(golden.items, predictions);
  const gates = evaluateGates(report);
  const john = predictions.get("hard-third-party-01");
  const johnOk = john !== undefined && !john.isCommitment;

  return {
    meta: {
      tier: "hermetic",
      provider: provider.id,
      model: EVAL_MODEL,
      ranAt: new Date().toISOString(),
      goldenVersion: golden.version,
    },
    report,
    gates,
    categories: perCategoryAccuracy(golden.items, predictions),
    hygiene: {
      checks: injectionChecks,
      passed: injectionChecks.every((check) => check.clean && check.dropped.length > 0),
      johnOk,
    },
  };
}

const pct = (x: number): string => x.toFixed(3);

function print(run: HermeticRun): void {
  const { report, gates, hygiene } = run;
  const categories = new Set(run.categories.map((c) => c.category));
  console.log(`Jehad OS extraction eval — ${report.n} items, ${categories.size} categories (golden set v${run.meta.goldenVersion ?? "?"}: base + hard-case + temporal-rules + state-adversarials)`);
  console.log(`Provider: ${run.meta.provider} (deterministic fake; live tier: pnpm eval:live)`);
  console.log("");
  console.log("Commitment detection");
  console.log(`  TP ${report.detection.tp} · FP ${report.detection.fp} · FN ${report.detection.fn} · TN ${report.detection.tn}`);
  console.log(`  precision ${pct(report.detection.precision)} · recall ${pct(report.detection.recall)} · F1 ${pct(report.detection.f1)} · FPR ${pct(report.detection.fpr)}`);
  console.log("Per-field accuracy (conditioned on shared positives)");
  console.log(`  direction     ${pct(report.direction.accuracy)}  (${report.direction.correct}/${report.direction.total})`);
  console.log(`  counterparty  ${pct(report.counterparty.accuracy)}  (${report.counterparty.correct}/${report.counterparty.total})`);
  console.log(`  due-date (end-to-end, via normalizedTime) ${pct(report.dueDate.accuracy)}  (${report.dueDate.correct}/${report.dueDate.total})`);
  console.log(`  confidence-in-band ${pct(report.confidenceInBand.accuracy)}  (${report.confidenceInBand.correct}/${report.confidenceInBand.total})`);
  console.log(`Normalizer accuracy (DIAGNOSTIC — echo→resolve chain; the normalizer itself is unit-tested in W6A)`);
  console.log(`  normalizer    ${pct(report.normalizer.accuracy)}  (${report.normalizer.correct}/${report.normalizer.total})`);
  console.log("Commitment-state accuracy (scored on every item)");
  console.log(`  overall       ${pct(report.commitmentState.overall.accuracy)}  (${report.commitmentState.overall.correct}/${report.commitmentState.overall.total})`);
  for (const state of report.commitmentState.perState) {
    console.log(`  ${state.state.padEnd(13)} ${pct(state.accuracy)}  (${state.correct}/${state.total})`);
  }
  console.log("Calibration (commitment predictions, bucketed)");
  for (const bucket of report.calibration) {
    console.log(
      `  ${bucket.label}  n=${String(bucket.n).padStart(3)}  meanConf=${pct(bucket.meanConfidence)}  observed=${pct(bucket.observedAccuracy)}`,
    );
  }
  console.log(`Action-driving (confidence ≥ ${report.actionDriving.threshold})`);
  console.log(`  precision ${pct(report.actionDriving.accuracy)}  (${report.actionDriving.correct}/${report.actionDriving.total})`);
  console.log("");
  if (report.failures.length > 0) {
    console.log("Failures (designed for the fake provider — non-trivial metrics):");
    for (const failure of report.failures) {
      console.log(`  ${failure.kind.padEnd(17)} ${failure.id} [${failure.category}]`);
    }
    console.log("");
  }

  console.log("Injection hygiene (prompt-injection golden items)");
  for (const check of hygiene.checks) {
    const ok = check.clean && check.dropped.length > 0;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${check.id}: ${check.dropped.length} instruction field(s) stripped, none stored`,
    );
  }
  console.log(`  ${hygiene.johnOk ? "PASS" : "FAIL"}  hard-third-party-01 ("John said yesterday…") is not a commitment`);
  console.log("");

  console.log("Gates");
  for (const gate of gates.gates) {
    console.log(
      `  ${gate.passed ? "PASS" : "FAIL"}  ${gate.name} ${gate.requirement} — actual ${pct(gate.actual)}`,
    );
  }
}

async function main(): Promise<number> {
  const run = await runHermeticEval();
  print(run);

  const artifact = new URL("./.last-hermetic.json", import.meta.url).pathname;
  writeFileSync(artifact, `${JSON.stringify(run, null, 2)}\n`);

  const passed = run.gates.passed && run.hygiene.passed && run.hygiene.johnOk;
  console.log(passed ? "\nEVAL PASSED" : "\nEVAL FAILED");
  console.log(`Hermetic baseline captured: ${path.relative(process.cwd(), artifact)}`);
  return passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("eval runner crashed:", error);
      process.exitCode = 1;
    },
  );
}
