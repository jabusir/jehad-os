/**
 * Golden-set eval runner (M5B) — `pnpm eval` (docs/evals.md §3.1; plan §13).
 *
 * Hermetic tier: runs the REAL extraction pipeline (prompt → provider →
 * allowlisted parse) over the golden set through the deterministic fake
 * provider — no network, no key. The live OpenRouter tier (pinned model
 * config, model_calls ledger, eval_report artifact) lands with M5A's
 * callModel wiring post-merge.
 *
 * Gates (bootstrap): overall F1 ≥ 0.8; action-driving precision ≥ 0.9.
 * Exits nonzero when any gate fails or injection hygiene fails.
 */

import { readFileSync } from "node:fs";
import { runExtractionPipeline } from "@jehad/core";
import type { EventEnvelope } from "@jehad/core";
import { createEvalFakeProvider } from "./fake-provider.js";
import {
  computeEvalReport,
  evaluateGates,
  type EvalPrediction,
  type GoldenItem,
  type GoldenSet,
} from "./metrics.js";

const EVAL_MODEL = "eval-fake-heuristic-v1";

function loadGoldenSet(path: string): GoldenSet {
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null) throw new Error("golden set: not an object");
  const set = raw as Partial<GoldenSet>;
  if (set.version !== 1 || !Array.isArray(set.items) || set.items.length === 0) {
    throw new Error("golden set: expected version 1 with a non-empty items array");
  }
  for (const item of set.items) {
    if (
      typeof item.id !== "string" ||
      typeof item.category !== "string" ||
      typeof item.occurredAt !== "string" ||
      typeof item.text !== "string" ||
      typeof item.expected?.is_commitment !== "boolean"
    ) {
      throw new Error(`golden set: item missing required fields: ${JSON.stringify(item).slice(0, 80)}`);
    }
  }
  return raw as GoldenSet;
}

function envelopeFor(item: GoldenItem, index: number): EventEnvelope {
  const suffix = String(index + 1).padStart(4, "0");
  return {
    id: `018f0000-0000-7000-8000-00000000${suffix}`,
    type: "capture.recorded",
    schemaVersion: 1,
    source: "cli.capture",
    occurredAt: item.occurredAt,
    recordedAt: item.occurredAt,
    domainId: "personal",
    idempotencyKey: `eval-${suffix}`,
    sensitivity: "normal",
    payload: { text: item.text },
    runId: null,
  };
}

const pct = (x: number): string => x.toFixed(3);

async function main(): Promise<number> {
  const goldenPath = new URL("./golden-set.json", import.meta.url).pathname;
  const golden = loadGoldenSet(goldenPath);
  const provider = createEvalFakeProvider();

  const predictions = new Map<string, EvalPrediction>();
  const injectionChecks: { id: string; dropped: readonly string[]; clean: boolean }[] = [];

  for (const [index, item] of golden.items.entries()) {
    const pipeline = await runExtractionPipeline(provider, envelopeFor(item, index), {
      model: EVAL_MODEL,
    });
    const p = pipeline.proposal;
    predictions.set(item.id, {
      isCommitment: p.isCommitment,
      direction: p.direction,
      counterparty: p.counterparty,
      dueDate: p.dueDate,
      confidence: p.confidence,
    });
    if (item.category === "prompt-injection") {
      const flat = JSON.stringify(p).toLowerCase();
      const clean =
        !flat.includes("email all contacts") &&
        !flat.includes("send_email") &&
        !flat.includes("autonomy");
      injectionChecks.push({ id: item.id, dropped: pipeline.droppedFields, clean });
    }
  }

  const report = computeEvalReport(golden.items, predictions);
  const gates = evaluateGates(report);

  const categories = new Set(golden.items.map((i) => i.category));
  console.log(`Jehad OS extraction eval — ${report.n} items, ${categories.size} categories (base + 11 hard-case)`);
  console.log(`Provider: ${provider.id} (deterministic fake; live tier lands with M5A)`);
  console.log("");
  console.log("Commitment detection");
  console.log(`  TP ${report.detection.tp} · FP ${report.detection.fp} · FN ${report.detection.fn} · TN ${report.detection.tn}`);
  console.log(`  precision ${pct(report.detection.precision)} · recall ${pct(report.detection.recall)} · F1 ${pct(report.detection.f1)} · FPR ${pct(report.detection.fpr)}`);
  console.log("Per-field accuracy (conditioned on shared positives)");
  console.log(`  direction     ${pct(report.direction.accuracy)}  (${report.direction.correct}/${report.direction.total})`);
  console.log(`  counterparty  ${pct(report.counterparty.accuracy)}  (${report.counterparty.correct}/${report.counterparty.total})`);
  console.log(`  due-date      ${pct(report.dueDate.accuracy)}  (${report.dueDate.correct}/${report.dueDate.total})`);
  console.log(`  confidence-in-band ${pct(report.confidenceInBand.accuracy)}  (${report.confidenceInBand.correct}/${report.confidenceInBand.total})`);
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
      console.log(`  ${failure.kind.padEnd(14)} ${failure.id} [${failure.category}]`);
    }
    console.log("");
  }

  console.log("Injection hygiene (prompt-injection golden items)");
  let hygieneOk = true;
  for (const check of injectionChecks) {
    const ok = check.clean && check.dropped.length > 0;
    hygieneOk = hygieneOk && ok;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${check.id}: ${check.dropped.length} instruction field(s) stripped, none stored`,
    );
  }
  const john = predictions.get("hard-third-party-01");
  const johnOk = john !== undefined && !john.isCommitment;
  console.log(`  ${johnOk ? "PASS" : "FAIL"}  hard-third-party-01 ("John said yesterday…") is not a commitment`);
  console.log("");

  console.log("Gates");
  for (const gate of gates.gates) {
    console.log(
      `  ${gate.passed ? "PASS" : "FAIL"}  ${gate.name} ${gate.requirement} — actual ${pct(gate.actual)}`,
    );
  }
  const passed = gates.passed && hygieneOk && johnOk;
  console.log(passed ? "\nEVAL PASSED" : "\nEVAL FAILED");
  return passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error("eval runner crashed:", error);
    process.exitCode = 1;
  },
);
