/**
 * Hermetic-vs-live comparison (Wave 5 live-eval prep) — `pnpm eval:compare`.
 *
 * Runs the hermetic tier fresh (deterministic, free) and the live tier
 * (real provider, or its last captured summary when the key is absent /
 * EVAL_FAKE_LIVE dry-run), then prints a side-by-side per-field table and
 * writes a human-readable markdown report the owner reads for the step-2
 * Calendar-wiring decision (docs/evals.md §3.1): gates are evaluated
 * against the LIVE numbers — overall F1 ≥ 0.80, action-precision ≥ 0.90,
 * commitment-state accuracy ≥ 0.80 (normalizer accuracy is a diagnostic
 * row, not a gate) — and the process exits nonzero when a live gate fails.
 *
 * Rendering is pure (unit-tested with a golden string); the CLI only wires
 * env → options → run → render → write.
 */

import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CalibrationBucket } from "./metrics.js";
import type { CategoryAccuracy, TierRun } from "./tiers.js";
import { runHermeticEval, type HermeticRun } from "./runner.js";
import { runLiveEval, type LiveEvalSuccess } from "./live.js";

export interface CompareFieldRow {
  readonly label: string;
  readonly hermetic: number;
  readonly live: number;
  readonly delta: number;
}

export interface CompareResult {
  readonly fields: readonly CompareFieldRow[];
  readonly calibration: readonly {
    readonly label: string;
    readonly hermetic: CalibrationBucket;
    readonly live: CalibrationBucket;
  }[];
  readonly categories: readonly {
    readonly category: string;
    readonly n: number;
    readonly hermetic: number;
    readonly live: number;
    readonly delta: number;
  }[];
  /** Gates evaluated against the LIVE tier (the step-2 decision numbers). */
  readonly gates: readonly { readonly name: string; readonly requirement: string; readonly live: number; readonly passed: boolean }[];
  readonly gatesPassed: boolean;
  /** True when every compared number is identical (EVAL_FAKE_LIVE dry-run proof). */
  readonly identical: boolean;
}

function fieldRow(label: string, hermetic: number, live: number): CompareFieldRow {
  return { label, hermetic, live, delta: live - hermetic };
}

export function compareTiers(hermetic: TierRun, live: TierRun): CompareResult {
  const fields: CompareFieldRow[] = [
    fieldRow("F1", hermetic.report.detection.f1, live.report.detection.f1),
    fieldRow("precision", hermetic.report.detection.precision, live.report.detection.precision),
    fieldRow("recall", hermetic.report.detection.recall, live.report.detection.recall),
    fieldRow("FPR", hermetic.report.detection.fpr, live.report.detection.fpr),
    fieldRow("due-date acc (e2e)", hermetic.report.dueDate.accuracy, live.report.dueDate.accuracy),
    fieldRow("normalizer acc", hermetic.report.normalizer.accuracy, live.report.normalizer.accuracy),
    fieldRow("state acc", hermetic.report.commitmentState.overall.accuracy, live.report.commitmentState.overall.accuracy),
    fieldRow("direction acc", hermetic.report.direction.accuracy, live.report.direction.accuracy),
    fieldRow("counterparty acc", hermetic.report.counterparty.accuracy, live.report.counterparty.accuracy),
    fieldRow("conf-in-band acc", hermetic.report.confidenceInBand.accuracy, live.report.confidenceInBand.accuracy),
    fieldRow("action-precision", hermetic.report.actionDriving.accuracy, live.report.actionDriving.accuracy),
  ];

  const calibration = hermetic.report.calibration.map((hBucket) => {
    const lBucket = live.report.calibration.find((b) => b.label === hBucket.label);
    return {
      label: hBucket.label,
      hermetic: hBucket,
      live: lBucket ?? { label: hBucket.label, n: 0, meanConfidence: 0, observedAccuracy: 0 },
    };
  });

  const categories = hermetic.categories.map((hCat: CategoryAccuracy) => {
    const lCat = live.categories.find((c) => c.category === hCat.category);
    const liveAcc = lCat?.accuracy ?? 0;
    return { category: hCat.category, n: hCat.n, hermetic: hCat.accuracy, live: liveAcc, delta: liveAcc - hCat.accuracy };
  });

  const gates = live.gates.gates.map((g) => ({
    name: g.name,
    requirement: g.requirement,
    live: g.actual,
    passed: g.passed,
  }));

  const calibrationIdentical = calibration.every(
    (pair) =>
      pair.hermetic.n === pair.live.n &&
      pair.hermetic.meanConfidence === pair.live.meanConfidence &&
      pair.hermetic.observedAccuracy === pair.live.observedAccuracy,
  );

  return {
    fields,
    calibration,
    categories,
    gates,
    gatesPassed: gates.every((g) => g.passed),
    identical:
      fields.every((f) => f.delta === 0) &&
      categories.every((c) => c.delta === 0) &&
      calibrationIdentical,
  };
}

const pct = (x: number): string => x.toFixed(3);
const delta = (d: number): string => (d === 0 ? "0.000" : `${d > 0 ? "+" : ""}${d.toFixed(3)}`);

/** Console side-by-side summary (kept terse; the markdown report is the artifact). */
export function renderCompareConsole(cmp: CompareResult, liveFromCache: boolean): string {
  const lines: string[] = [];
  lines.push("Hermetic vs live — per-field comparison");
  lines.push(`  metric              hermetic   live       Δ (live−hermetic)${liveFromCache ? "   [live: cached .last-live.json]" : ""}`);
  for (const field of cmp.fields) {
    lines.push(
      `  ${field.label.padEnd(20)}${pct(field.hermetic).padEnd(10)} ${pct(field.live).padEnd(10)} ${delta(field.delta)}`,
    );
  }
  lines.push("");
  lines.push("Per-category accuracy (hard-case categories flagged with *)");
  for (const cat of cmp.categories) {
    const flag = cat.category === "base" ? " " : "*";
    lines.push(` ${flag}${cat.category.padEnd(24)} n=${String(cat.n).padStart(2)}  ${pct(cat.hermetic).padEnd(9)} ${pct(cat.live).padEnd(9)} ${delta(cat.delta)}`);
  }
  lines.push("");
  lines.push("Gates (evaluated against the LIVE tier)");
  for (const gate of cmp.gates) {
    lines.push(`  ${gate.passed ? "PASS" : "FAIL"}  ${gate.name} ${gate.requirement} — live ${pct(gate.live)}`);
  }
  if (cmp.identical) {
    lines.push("");
    lines.push("Tiers are numerically identical with zero delta (expected for an EVAL_FAKE_LIVE dry-run).");
  }
  return lines.join("\n");
}

export interface CompareInput {
  readonly hermetic: HermeticRun;
  readonly live: LiveEvalSuccess;
  /** ISO timestamp on the report header. */
  readonly generatedAt: string;
  /** True when the live side came from evals/.last-live.json, not a fresh run. */
  readonly liveFromCache: boolean;
}

function tierLine(run: TierRun, fakeNote: string): string {
  const fake = run.meta.fakeLive === true ? ` (${fakeNote})` : "";
  return `${run.meta.provider} / ${run.meta.model}${fake} — ran ${run.meta.ranAt}`;
}

/** The markdown artifact the owner reads (structure is golden-tested). */
export function renderCompareMarkdown(input: CompareInput): string {
  const { hermetic, live } = input;
  const cmp = compareTiers(hermetic, live.run);
  const lines: string[] = [];

  lines.push("# Extraction eval report — live vs hermetic");
  lines.push("");
  lines.push(`- Generated: ${input.generatedAt}`);
  lines.push(`- Golden set: ${hermetic.report.n} items (v${hermetic.meta.goldenVersion ?? 1})`);
  lines.push(`- Hermetic tier: ${tierLine(hermetic, "deterministic fake")}`);
  lines.push(
    `- Live tier: ${tierLine(live.run, "EVAL_FAKE_LIVE dry-run")} — source: ${input.liveFromCache ? "cached .last-live.json" : "fresh run"}`,
  );
  lines.push(
    `- Live spend: $${live.spend.totalUsd.toFixed(4)} across ${live.ledger.rows} model_calls rows on isolated db \`${live.dbName}\` (${live.ledger.errorRows} error rows) · parse failures: ${live.parseFailures.length > 0 ? live.parseFailures.join(", ") : "none"}`,
  );
  lines.push("");
  lines.push("## Per-field comparison");
  lines.push("");
  lines.push("| Metric | Hermetic | Live | Δ (live−hermetic) |");
  lines.push("| --- | --- | --- | --- |");
  for (const field of cmp.fields) {
    lines.push(`| ${field.label} | ${pct(field.hermetic)} | ${pct(field.live)} | ${delta(field.delta)} |`);
  }
  lines.push("");
  lines.push("## Commitment-state accuracy (per state; scored on every golden item)");
  lines.push("");
  lines.push("| State | n (H/L) | Hermetic | Live |");
  lines.push("| --- | --- | --- | --- |");
  const states = hermetic.report.commitmentState.perState;
  for (const hState of states) {
    const lState = live.run.report.commitmentState.perState.find((s) => s.state === hState.state);
    lines.push(
      `| ${hState.state} | ${hState.total}/${lState?.total ?? 0} | ${pct(hState.accuracy)} | ${lState === undefined ? "—" : pct(lState.accuracy)} |`,
    );
  }
  lines.push("");
  lines.push("## Calibration (commitment predictions, bucketed)");
  lines.push("");
  lines.push("| Bucket | n (H/L) | mean conf (H/L) | observed acc (H/L) |");
  lines.push("| --- | --- | --- | --- |");
  for (const pair of cmp.calibration) {
    lines.push(
      `| ${pair.label} | ${pair.hermetic.n}/${pair.live.n} | ${pct(pair.hermetic.meanConfidence)} / ${pct(pair.live.meanConfidence)} | ${pct(pair.hermetic.observedAccuracy)} / ${pct(pair.live.observedAccuracy)} |`,
    );
  }
  lines.push("");
  lines.push("## Per-category accuracy (Δ = live − hermetic; * marks hard-case categories)");
  lines.push("");
  lines.push("| Category | n | Hermetic | Live | Δ |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const cat of cmp.categories) {
    const flag = cat.category === "base" ? "" : " *";
    lines.push(`| ${cat.category}${flag} | ${cat.n} | ${pct(cat.hermetic)} | ${pct(cat.live)} | ${delta(cat.delta)} |`);
  }
  lines.push("");
  lines.push("## Injection hygiene");
  lines.push("");
  lines.push("| Tier | Item | Result | Notes |");
  lines.push("| --- | --- | --- | --- |");
  for (const check of hermetic.hygiene.checks) {
    const ok = check.clean && check.dropped.length > 0;
    lines.push(`| hermetic | ${check.id} | ${ok ? "PASS" : "FAIL"} | ${check.dropped.length} instruction field(s) stripped by the allowlist, none stored |`);
  }
  for (const check of live.hygiene.checks) {
    lines.push(`| live | ${check.id} | ${check.clean ? "PASS" : "FAIL"} | no instruction content stored (${check.dropped} field(s) dropped) |`);
  }
  lines.push("");
  lines.push("## Gates (evaluated against the LIVE tier)");
  lines.push("");
  lines.push("| Gate | Requirement | Live | Result |");
  lines.push("| --- | --- | --- | --- |");
  for (const gate of cmp.gates) {
    lines.push(`| ${gate.name} | ${gate.requirement} | ${pct(gate.live)} | ${gate.passed ? "PASS" : "FAIL"} |`);
  }
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(
    cmp.gatesPassed
      ? "LIVE GATES PASS — the live tier clears the bar (F1 ≥ 0.80, action-precision ≥ 0.90, commitment-state accuracy ≥ 0.80); Calendar wiring may proceed."
      : "LIVE GATES FAIL — do NOT wire Calendar automation yet: the live tier must clear F1 ≥ 0.80, action-precision ≥ 0.90, and commitment-state accuracy ≥ 0.80 first.",
  );
  lines.push("");
  return lines.join("\n");
}

/** `.eval-report-<YYYYMMDD-HHMMSS>.md` from the report's generated-at stamp. */
export function reportFileName(generatedAtIso: string): string {
  const d = new Date(generatedAtIso);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `.eval-report-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.md`;
}

function loadLastLive(): LiveEvalSuccess | null {
  const file = new URL("./.last-live.json", import.meta.url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  const candidate = parsed as Partial<LiveEvalSuccess> & { run?: Partial<TierRun> };
  if (candidate.skipped !== false || candidate.run?.report === undefined || candidate.run?.gates === undefined) {
    return null;
  }
  return parsed as LiveEvalSuccess;
}

async function main(): Promise<number> {
  const hermetic = await runHermeticEval();
  const live = await runLiveEval({
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    fakeLive: process.env.EVAL_FAKE_LIVE === "1",
    model: process.env.EVAL_MODEL && process.env.EVAL_MODEL.length > 0 ? process.env.EVAL_MODEL : undefined,
    databaseUrl: process.env.TEST_DATABASE_URL,
    sleepMs:
      process.env.EVAL_LIVE_SLEEP_MS !== undefined && process.env.EVAL_LIVE_SLEEP_MS.length > 0
        ? Number(process.env.EVAL_LIVE_SLEEP_MS)
        : undefined,
  });

  let liveResult: LiveEvalSuccess;
  let liveFromCache = false;
  if (live.skipped) {
    const cached = loadLastLive();
    if (cached === null) {
      console.error(`cannot compare: live tier unavailable (${live.message}) and evals/.last-live.json has no prior live run`);
      return 1;
    }
    liveResult = cached;
    liveFromCache = true;
    console.log(`live tier: using cached evals/.last-live.json (ran ${cached.run.meta.ranAt}) — ${live.message}`);
  } else {
    liveResult = live;
    const artifact = new URL("./.last-live.json", import.meta.url).pathname;
    writeFileSync(artifact, `${JSON.stringify(live, null, 2)}\n`);
  }

  const cmp = compareTiers(hermetic, liveResult.run);
  console.log(renderCompareConsole(cmp, liveFromCache));

  const generatedAt = new Date().toISOString();
  const fileName = reportFileName(generatedAt);
  const artifact = new URL(`./${fileName}`, import.meta.url).pathname;
  writeFileSync(artifact, renderCompareMarkdown({ hermetic, live: liveResult, generatedAt, liveFromCache }));

  console.log("");
  console.log(`Report artifact: ${path.relative(process.cwd(), artifact)}`);
  console.log(cmp.gatesPassed ? "LIVE GATES PASS" : "LIVE GATES FAIL");
  return cmp.gatesPassed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("compare runner crashed:", error instanceof Error ? `${error.name}: ${error.message}` : error);
      process.exitCode = 1;
    },
  );
}
