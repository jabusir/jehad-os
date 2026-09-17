/**
 * Live eval tier (Wave 5 live-eval prep) — `pnpm eval:live`.
 *
 * Same golden set, same REAL extraction pipeline as the hermetic tier, but
 * through the live path (docs/evals.md §2): the provider is built via
 * createOpenRouterProvider and wrapped by callModel's composition — A13
 * budget caps + ADR-0012 egress gate before every dispatch — against an
 * ISOLATED database carrying one run row and one model_calls ledger row
 * per item (the ledger FK is why the envelopes carry the run id). Spend is
 * reported from the ledger when it exists.
 *
 * Politeness: strictly sequential (no parallel calls), small sleep between
 * items (EVAL_LIVE_SLEEP_MS, default 250ms).
 *
 * Secrets: the API key is read from the environment by the CLI entry and
 * handed to the provider only — never logged, never in results or artifacts.
 *
 * Skips cleanly (message + exit 0) when OPENROUTER_API_KEY is absent.
 * EVAL_FAKE_LIVE=1 swaps the network provider for the deterministic eval
 * fake (with an eval-only egress rule) — a hermetic dry-run of this exact
 * plumbing, used by eval:compare to prove the comparison end-to-end.
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOpenRouterProvider } from "@jehad/adapters";
import type { ModelProvider } from "@jehad/adapters";
import {
  EXTRACTION_PROMPT_VERSION,
  callModel,
  loadEgressPolicyRegistry,
  ModelEgressPolicyRegistry,
} from "@jehad/core";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb } from "../packages/db/tests/test-db.js";
import { createEvalFakeProvider } from "./fake-provider.js";
import { runV3Extraction, EvalParseError } from "./extraction-v3.js";
import { envelopeFor, loadDefaultGoldenSet } from "./golden.js";
import { computeEvalReport, evaluateGates, type EvalPrediction, type GoldenItem } from "./metrics.js";
import { isInjectionClean, perCategoryAccuracy, type TierRun } from "./tiers.js";

/** Pinned via env EVAL_MODEL (docs/evals.md §2: pinned model config). */
export const DEFAULT_EVAL_MODEL = "openai/gpt-4o-mini";
/** Env-overridable sleep between sequential live items (EVAL_LIVE_SLEEP_MS). */
export const DEFAULT_LIVE_SLEEP_MS = 250;

/** Dry-run egress widening: EVAL_FAKE_LIVE routes the deterministic fake
 *  through the same gate the real provider passes. The repo policy file
 *  allows openrouter for personal/normal; the fake id is appended to THAT
 *  rule (appending a separate rule would lose the most-specific tie-break
 *  and deny — fail closed, but not what the dry-run means). Eval-only;
 *  never written to the policy file. */
function fakeLiveRegistry(base: ModelEgressPolicyRegistry): ModelEgressPolicyRegistry {
  return new ModelEgressPolicyRegistry(
    base.rules.map((rule) =>
      rule.domainId === "personal" && rule.sensitivity === "normal"
        ? { ...rule, allowedProviders: [...rule.allowedProviders, "eval-fake"] }
        : rule,
    ),
  );
}

export interface LiveEvalOptions {
  /** OpenRouter API key (CLI reads it from the env; never logged). */
  readonly apiKey?: string;
  /** Defaults to DEFAULT_EVAL_MODEL. */
  readonly model?: string;
  /** Isolated-db base DSN (TEST_DATABASE_URL); the tier skips without it. */
  readonly databaseUrl?: string;
  /** Deterministic-fake dry-run (EVAL_FAKE_LIVE). */
  readonly fakeLive?: boolean;
  /** Sleep between sequential items; default DEFAULT_LIVE_SLEEP_MS. */
  readonly sleepMs?: number;
  /** OpenRouter base-URL override (tests stub it; never set in prod runs). */
  readonly baseUrl?: string;
  /** Item subset override (tests); default: the full golden set. */
  readonly items?: readonly GoldenItem[];
  /** Clock injection (tests / deterministic artifacts). */
  readonly now?: () => Date;
}

export type LiveEvalResult = LiveEvalSkipped | LiveEvalSuccess;

export interface LiveEvalSkipped {
  readonly skipped: true;
  readonly reason: "missing-api-key" | "missing-database";
  readonly message: string;
}

export interface LiveEvalSuccess {
  readonly skipped: false;
  readonly run: TierRun;
  /** Spend accumulated from callModel outcomes (A13 ledger currency). */
  readonly spend: { readonly totalUsd: number; readonly calls: number; readonly budgetWarnings: number };
  /** Ledger truth queried from the isolated db after the run. */
  readonly ledger: { readonly rows: number; readonly errorRows: number; readonly totalCostUsd: number };
  /** Golden item ids whose model output failed the allowlisted parse. */
  readonly parseFailures: readonly string[];
  readonly hygiene: {
    readonly checks: readonly { readonly id: string; readonly dropped: number; readonly clean: boolean }[];
    readonly passed: boolean;
  };
  readonly dbName: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runLiveEval(options: LiveEvalOptions = {}): Promise<LiveEvalResult> {
  const fakeLive = options.fakeLive ?? false;
  const apiKey = options.apiKey ?? "";
  if (!fakeLive && apiKey.trim().length === 0) {
    return {
      skipped: true,
      reason: "missing-api-key",
      message:
        "OPENROUTER_API_KEY is not set (copy .env.example to .env); set it for a real live run, or use EVAL_FAKE_LIVE=1 for a dry-run of the live plumbing",
    };
  }
  const databaseUrl = options.databaseUrl;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    return {
      skipped: true,
      reason: "missing-database",
      message:
        "TEST_DATABASE_URL is not set — the live tier records its run row + model_calls ledger on an isolated database (callModel composition requires it)",
    };
  }

  const model = options.model ?? DEFAULT_EVAL_MODEL;
  const sleepMs = options.sleepMs ?? DEFAULT_LIVE_SLEEP_MS;
  const now = options.now ?? (() => new Date());
  const items = options.items ?? loadDefaultGoldenSet().items;

  const db = await createIsolatedTestDb(databaseUrl, "evalive");
  try {
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`);
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name, credential_hash) VALUES ('user', 'eval-live', NULL) RETURNING id`,
    );
    const runRow = await db.pool.query(
      `INSERT INTO runs (kind, status, domain_id, principal_id)
       VALUES ('workflow', 'running', $1, $2) RETURNING id`,
      [domain.rows[0]!.id, principal.rows[0]!.id],
    );
    const runId = String(runRow.rows[0]!.id);

    const raw: ModelProvider = fakeLive
      ? createEvalFakeProvider()
      : createOpenRouterProvider({ apiKey, baseUrl: options.baseUrl });
    const baseRegistry = await loadEgressPolicyRegistry();
    const registry = fakeLive ? fakeLiveRegistry(baseRegistry) : baseRegistry;

    let spendUsd = 0;
    let calls = 0;
    let budgetWarnings = 0;
    const provider: ModelProvider = {
      id: raw.id,
      async complete(request) {
        const outcome = await callModel(
          { db: db.pool, provider: raw, registry },
          { ...request, promptVersion: EXTRACTION_PROMPT_VERSION },
        );
        calls += 1;
        spendUsd += outcome.costUsd;
        if (outcome.resultStatus === "ok_budget_warning") budgetWarnings += 1;
        return outcome.result;
      },
    };

    const predictions = new Map<string, EvalPrediction>();
    const parseFailures: string[] = [];
    const hygieneChecks: { id: string; dropped: number; clean: boolean }[] = [];

    for (const [index, item] of items.entries()) {
      if (index > 0 && sleepMs > 0) await sleep(sleepMs);
      let prediction: EvalPrediction;
      let dropped = 0;
      try {
        const pipeline = await runV3Extraction(provider, envelopeFor(item, index, runId), { model });
        prediction = pipeline.prediction;
        dropped = pipeline.droppedFields.length;
      } catch (err) {
        // A live model can emit unparseable output for an item; score it as
        // a no-commitment miss (honest — recall pays for it) and keep the
        // paid run alive. Listed in the report's parse-failure section.
        if (err instanceof EvalParseError) {
          parseFailures.push(item.id);
          prediction = {
            isCommitment: false,
            direction: null,
            counterparty: null,
            confidence: 0,
            commitmentState: null,
            temporal: null,
          };
        } else {
          throw err;
        }
      }
      predictions.set(item.id, prediction);
      if (item.category === "prompt-injection") {
        hygieneChecks.push({ id: item.id, dropped, clean: isInjectionClean(prediction) });
      }
    }

    const ledgerRow = await db.pool.query<{ rows: string; error_rows: string; total: string }>(
      `SELECT count(*) AS rows,
              count(*) FILTER (WHERE result_status = 'error') AS error_rows,
              COALESCE(SUM(cost_usd), 0) AS total
       FROM model_calls`,
    );

    const report = computeEvalReport(items, predictions);
    return {
      skipped: false,
      run: {
        meta: {
          tier: "live",
          provider: raw.id,
          model,
          ranAt: now().toISOString(),
          fakeLive,
          goldenVersion: loadDefaultGoldenSet().version,
        },
        report,
        gates: evaluateGates(report),
        categories: perCategoryAccuracy(items, predictions),
      },
      spend: { totalUsd: spendUsd, calls, budgetWarnings },
      ledger: {
        rows: Number(ledgerRow.rows[0]?.rows ?? 0),
        errorRows: Number(ledgerRow.rows[0]?.error_rows ?? 0),
        totalCostUsd: Number(ledgerRow.rows[0]?.total ?? 0),
      },
      parseFailures,
      hygiene: { checks: hygieneChecks, passed: hygieneChecks.every((check) => check.clean) },
      dbName: db.dbName,
    };
  } finally {
    await dropIsolatedTestDb(databaseUrl, db);
  }
}

const pct = (x: number): string => x.toFixed(3);

function print(result: LiveEvalSuccess): void {
  const { run } = result;
  console.log(`Jehad OS extraction eval — LIVE tier${run.meta.fakeLive ? " (EVAL_FAKE_LIVE dry-run: deterministic fake through the live plumbing)" : ""}`);
  console.log(`Provider: ${run.meta.provider} · model ${run.meta.model} · ${run.report.n} items · sequential, ${process.env.EVAL_LIVE_SLEEP_MS ?? String(DEFAULT_LIVE_SLEEP_MS)}ms sleep`);
  console.log(`Ledger: ${result.ledger.rows} model_calls row(s) on isolated db ${result.dbName} (errors: ${result.ledger.errorRows})`);
  console.log(`Spend this run: $${result.spend.totalUsd.toFixed(4)} (A13 caps enforced by callModel; budget warnings: ${result.spend.budgetWarnings})`);
  console.log("");
  const { report, gates } = run;
  console.log("Commitment detection");
  console.log(`  TP ${report.detection.tp} · FP ${report.detection.fp} · FN ${report.detection.fn} · TN ${report.detection.tn}`);
  console.log(`  precision ${pct(report.detection.precision)} · recall ${pct(report.detection.recall)} · F1 ${pct(report.detection.f1)} · FPR ${pct(report.detection.fpr)}`);
  console.log("Per-field accuracy (conditioned on shared positives)");
  console.log(`  direction     ${pct(report.direction.accuracy)}  (${report.direction.correct}/${report.direction.total})`);
  console.log(`  counterparty  ${pct(report.counterparty.accuracy)}  (${report.counterparty.correct}/${report.counterparty.total})`);
  console.log(`  due-date (end-to-end, via normalizedTime) ${pct(report.dueDate.accuracy)}  (${report.dueDate.correct}/${report.dueDate.total})`);
  console.log(`  confidence-in-band ${pct(report.confidenceInBand.accuracy)}  (${report.confidenceInBand.correct}/${report.confidenceInBand.total})`);
  console.log(`Normalizer accuracy (DIAGNOSTIC)`);
  console.log(`  normalizer    ${pct(report.normalizer.accuracy)}  (${report.normalizer.correct}/${report.normalizer.total})`);
  console.log("Commitment-state accuracy (scored on every item)");
  console.log(`  overall       ${pct(report.commitmentState.overall.accuracy)}  (${report.commitmentState.overall.correct}/${report.commitmentState.overall.total})`);
  for (const state of report.commitmentState.perState) {
    console.log(`  ${state.state.padEnd(13)} ${pct(state.accuracy)}  (${state.correct}/${state.total})`);
  }
  console.log(`Action-driving (confidence ≥ ${report.actionDriving.threshold})`);
  console.log(`  precision ${pct(report.actionDriving.accuracy)}  (${report.actionDriving.correct}/${report.actionDriving.total})`);
  if (result.parseFailures.length > 0) {
    console.log(`Parse failures (live output failed the allowlist; scored as misses): ${result.parseFailures.join(", ")}`);
  }
  console.log("");
  console.log("Injection hygiene (prompt-injection golden items; content-clean check)");
  for (const check of result.hygiene.checks) {
    console.log(`  ${check.clean ? "PASS" : "FAIL"}  ${check.id}: no instruction content stored (${check.dropped} field(s) dropped)`);
  }
  console.log("");
  console.log("Gates (live tier)");
  for (const gate of gates.gates) {
    console.log(`  ${gate.passed ? "PASS" : "FAIL"}  ${gate.name} ${gate.requirement} — actual ${pct(gate.actual)}`);
  }
}

/** Minimal .env loader (no dep): KEY=VALUE lines; env wins over file. */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  const lineRe = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = lineRe.exec(line.trim());
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function main(): Promise<number> {
  loadDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"));
  const result = await runLiveEval({
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    fakeLive: process.env.EVAL_FAKE_LIVE === "1",
    model: process.env.EVAL_MODEL && process.env.EVAL_MODEL.length > 0 ? process.env.EVAL_MODEL : undefined,
    databaseUrl: process.env.TEST_DATABASE_URL,
    sleepMs:
      process.env.EVAL_LIVE_SLEEP_MS !== undefined && process.env.EVAL_LIVE_SLEEP_MS.length > 0
        ? Number(process.env.EVAL_LIVE_SLEEP_MS)
        : undefined,
  });
  if (result.skipped) {
    console.log(`live eval skipped: ${result.message}`);
    return 0;
  }
  print(result);

  const artifact = new URL("./.last-live.json", import.meta.url).pathname;
  writeFileSync(artifact, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Live summary captured: ${path.relative(process.cwd(), artifact)} (used by pnpm eval:compare when the key is absent)`);

  const passed = result.run.gates.passed && result.hygiene.passed;
  console.log(passed ? "\nLIVE EVAL PASSED" : "\nLIVE EVAL FAILED");
  return passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("live eval runner crashed:", error instanceof Error ? `${error.name}: ${error.message}` : error);
      process.exitCode = 1;
    },
  );
}
