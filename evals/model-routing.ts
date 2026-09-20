/**
 * Model-routing eval (lane R2 — docs/evals/model-routing-2026-09.md).
 *
 * Compares candidate route+answer models on the REAL gateway prompts:
 * the route pass is built by buildRoutingPrompt and scored through the
 * REAL strict parsers (parseRouteJson / parseActionRouteJson imported
 * from @jehad/core — the exact fail-safe posture production uses); the
 * answer pass is built by buildAnswerPrompt over synthetic DATA blocks
 * shaped like executeReadTool output, scored by a coarse checklist
 * (fraction of points; per-case reply text is kept in the raw artifact
 * for manual eyeballing — this is deliberately review-friendly, not a
 * fine-grained judge).
 *
 * Live calls mirror the production request shape exactly
 * (packages/adapters model-providers/openrouter.ts: single user-role
 * message, same headers/body) plus eval-only temperature 0 and a
 * max_tokens cap (route 300 / answer 800) to keep spend bounded.
 *
 * Politeness/safety: strictly sequential, 150ms sleep between calls,
 * one retry per failed call, a model with 2 hard failures is reported
 * and excluded, and a global spend ceiling aborts the run.
 *
 * The API key is read from the environment (or repo .env) and sent ONLY
 * in the Authorization header — never logged, never in artifacts.
 * Skips cleanly without OPENROUTER_API_KEY.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAnswerPrompt,
  buildRoutingPrompt,
  parseActionRouteJson,
  parseRouteJson,
  type ReadToolResult,
} from "@jehad/core";

// ---------------------------------------------------------------- fixtures

interface RouteCase {
  readonly id: string;
  readonly group: "lookup" | "action" | "chitchat" | "adversarial";
  readonly text: string;
  readonly expected:
    | { readonly kind: "read"; readonly call: { readonly tool: string; readonly day?: string } }
    | { readonly kind: "action"; readonly request: Record<string, unknown> }
    | { readonly kind: "none" };
}

interface AnswerCheck {
  readonly id: string;
  readonly type: "includesAll" | "includesAny" | "includesNone" | "timeExact" | "maxChars" | "regexAbsent";
  readonly values?: readonly string[];
  readonly value?: number;
  readonly pattern?: string;
}

interface AnswerCase {
  readonly id: string;
  readonly group: string;
  readonly question: string;
  readonly lookupNote: "denied" | "failed" | null;
  readonly results: readonly ReadToolResult[];
  readonly checklist: readonly AnswerCheck[];
}

interface Fixtures {
  readonly version: number;
  readonly principalName: string;
  readonly routeCases: readonly RouteCase[];
  readonly answerCases: readonly AnswerCase[];
}

function loadFixtures(file: string): Fixtures {
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<Fixtures>;
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.routeCases) ||
    raw.routeCases.length === 0 ||
    !Array.isArray(raw.answerCases) ||
    raw.answerCases.length === 0
  ) {
    throw new Error(`model-routing fixtures: malformed (${file})`);
  }
  return raw as Fixtures;
}

// ------------------------------------------------------------ live plumbing

const BASE_URL = "https://openrouter.ai/api/v1";
const ROUTE_MAX_TOKENS = 300;
const ANSWER_MAX_TOKENS = 800;
/** Env-overridable pacing (EVAL_SLEEP_MS); rate-limited models need ~3.2s. */
const DEFAULT_SLEEP_MS = 150;
/** Hard abort well under the $2 lane budget. */
const SPEND_CEILING_USD = 1.75;
/** A model with this many hard failures (post-retry) is reported + excluded. */
const MODEL_MAX_HARD_FAILURES = 2;

interface CallOutcome {
  readonly text: string;
  readonly latencyMs: number;
  readonly costUsd: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

/**
 * One chat completion through the REAL provider request shape: the exact
 * body packages/adapters openrouter.ts sends (single user-role message),
 * plus eval-only temperature 0 and the max_tokens cap.
 */
async function callOnce(
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<CallOutcome> {
  const started = Date.now();
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    let message: string | undefined;
    try {
      message = (JSON.parse(bodyText) as { error?: { message?: unknown } }).error?.message as string | undefined;
    } catch {
      // unparseable body — nothing safe to surface
    }
    throw new Error(`openrouter HTTP ${response.status}${message !== undefined ? `: ${message}` : ""}`);
  }
  const body = (await response.json()) as {
    choices?: readonly { readonly message?: { readonly content?: string | null } }[];
    usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number; readonly cost?: number };
  };
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    latencyMs: Date.now() - started,
    costUsd: body.usage?.cost ?? null,
    promptTokens: body.usage?.prompt_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
  };
}

/** Retry policy: one immediate retry for any failure; rate-limit (HTTP 429)
 *  failures additionally back off RATE_LIMIT_BACKOFF_MS first and earn a
 *  third attempt — a 429 is pacing, not model quality, so only non-429
 *  failures count toward the exclusion threshold. */
const RATE_LIMIT_BACKOFF_MS = 30_000;

async function callWithRetry(
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<{ ok: true; outcome: CallOutcome } | { ok: false; error: string; hard: boolean; retries: number }> {
  let lastError = "unknown error";
  let lastRateLimited = false;
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(lastRateLimited ? RATE_LIMIT_BACKOFF_MS : 500);
    }
    try {
      return { ok: true, outcome: await callOnce(apiKey, model, prompt, maxTokens) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastRateLimited = lastError.includes("429");
      if (attempt === attempts - 1) break;
    }
  }
  return { ok: false, error: lastError, hard: !lastRateLimited, retries: attempts - 1 };
}

/** Verify every candidate id exists via GET /models (substitutions were
 *  resolved by hand against the same endpoint before this run). */
async function verifyModelIds(apiKey: string, models: readonly string[]): Promise<void> {
  const response = await fetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`model verification: GET /models returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: readonly { id?: string }[] };
  const ids = new Set((body.data ?? []).map((m) => m.id).filter((id): id is string => id !== undefined));
  const missing = models.filter((m) => !ids.has(m));
  if (missing.length > 0) throw new Error(`model verification: unknown ids on OpenRouter: ${missing.join(", ")}`);
}

// ----------------------------------------------------------------- scoring

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Route compliance against the REAL parsers — the same two-step branch
 *  the gateway takes (action arm first, then the strict lookup arm). */
function scoreRoute(output: string, expected: RouteCase["expected"]): { ok: boolean; parsed: unknown } {
  const action = parseActionRouteJson(output);
  if (expected.kind === "action") {
    return { ok: deepEqual(action, expected.request), parsed: action };
  }
  const parsed = parseRouteJson(output);
  if (expected.kind === "read") {
    return { ok: action === null && deepEqual(parsed, expected.call), parsed };
  }
  // none: the pinned expectation is the literal single-line {"tool":"none"}
  // (which parseRouteJson deliberately fails safe to null → plain chat).
  const trimmed = output.trim();
  let literal: unknown;
  try {
    literal = trimmed.startsWith("{") && trimmed.endsWith("}") ? JSON.parse(trimmed) : undefined;
  } catch {
    literal = undefined;
  }
  return {
    ok: deepEqual(literal, { tool: "none" }),
    parsed: action === null && parsed === null ? { tool: "none" } : (parsed ?? action),
  };
}

/** Case-fold + normalize curly apostrophes to straight ones (models emit
 *  both; synonym checks must not depend on which quote glyph was used). */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\u2018\u2019]/g, "'");
}

const FUZZY_STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "and", "at",
  // substance is nouns/names/numbers; verbs paraphrase freely
  // ("return a library book" ≈ "you owe Maria a library book")
  "return", "pay", "paying", "rsvp", "call", "send", "reply", "submit", "schedule", "check",
]);

/** Substring first; then a token fallback that ignores articles/verbs,
 *  tolerates inflections by prefix ("returning" satisfies "return"), and
 *  strips a trailing .com/.net/.org ("3 from LinkedIn" satisfies
 *  "linkedin.com") — grounded substance, formatting differences only. */
function fuzzyIncludes(hay: string, needle: string): boolean {
  if (hay.includes(needle)) return true;
  const words = needle
    .replace(/\.(com|net|org)$/i, "")
    .split(/[\s,]+/)
    .filter((w) => w.length >= 4 && !FUZZY_STOPWORDS.has(w));
  if (words.length === 0) return false;
  const escape = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b only exists next to word chars; tokens like "#2231" need a
  // space/start boundary instead.
  const pattern = (w: string): string => {
    const boundary = /^[A-Za-z0-9]/.test(w) ? "\\b" : "(?:^|\\s)";
    return `${boundary}${escape(w)}`;
  };
  return words.every((w) => new RegExp(pattern(w)).test(hay));
}

function runCheck(reply: string, check: AnswerCheck): boolean {
  const hay = normalize(reply);
  switch (check.type) {
    case "includesAll":
      return (check.values ?? []).every((v) => fuzzyIncludes(hay, normalize(v)));
    case "includesAny":
      return (check.values ?? []).some((v) => hay.includes(normalize(v)));
    case "includesNone":
      return !(check.values ?? []).some((v) => hay.includes(normalize(v)));
    case "timeExact":
      return (check.values ?? []).every((v) => reply.includes(v));
    case "maxChars":
      return reply.length <= (check.value ?? 1500);
    case "regexAbsent":
      return check.pattern === undefined || !new RegExp(check.pattern, "i").test(reply);
  }
}

// ------------------------------------------------------------------- runner

interface CallRecord {
  readonly id: string;
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly costUsd: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly output: string;
  readonly parsed?: unknown;
  readonly checks?: readonly { readonly id: string; readonly pass: boolean }[];
  readonly error?: string;
}

interface PassSummary {
  readonly calls: number;
  readonly okCount: number;
  readonly compliancePct: number;
  readonly byGroup: readonly { readonly group: string; readonly ok: number; readonly n: number }[];
  readonly avgLatencyMs: number | null;
  readonly avgCostUsd: number | null;
  readonly totalCostUsd: number;
}

function summarize(records: readonly CallRecord[]): PassSummary {
  const done = records.filter((r) => r.error === undefined);
  const latencies = done.map((r) => r.latencyMs).filter((l): l is number => l !== null);
  const costs = done.map((r) => r.costUsd).filter((c): c is number => c !== null);
  const groups = new Map<string, { ok: number; n: number }>();
  for (const record of records) {
    if (record.error !== undefined) continue;
    const bucket = groups.get(record.id.replace(/[0-9]+$/, "")) ?? { ok: 0, n: 0 };
    bucket.n += 1;
    if (record.ok) bucket.ok += 1;
    groups.set(record.id.replace(/[0-9]+$/, ""), bucket);
  }
  const groupKeys = [...groups.keys()].sort().map((k) => k.toUpperCase());
  const totalCost = costs.reduce((sum, c) => sum + c, 0);
  return {
    calls: done.length,
    okCount: done.filter((r) => r.ok).length,
    compliancePct: done.length === 0 ? 0 : (done.filter((r) => r.ok).length / done.length) * 100,
    byGroup: groupKeys.map((label) => {
      const bucket = groups.get(label.toLowerCase()) ?? groups.get(label) ?? { ok: 0, n: 0 };
      return { group: label, ok: bucket.ok, n: bucket.n };
    }),
    avgLatencyMs: latencies.length === 0 ? null : latencies.reduce((s, l) => s + l, 0) / latencies.length,
    avgCostUsd: costs.length === 0 ? null : totalCost / costs.length,
    totalCostUsd: totalCost,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${x.toFixed(1)}%`);

async function main(): Promise<number> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Minimal .env loader (same as live.ts): env wins over file.
  const envFile = path.resolve(here, "../.env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (match !== null) {
        const [, key, value] = match;
        if (key !== undefined && value !== undefined && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  }
  const fixtures = loadFixtures(path.join(here, "model-routing.fixtures.json"));
  const artifactPath = path.resolve(here, "../docs/evals/model-routing-2026-09.raw.json");

  // EVAL_RESCORE=1: deterministic re-score of the recorded outputs in the
  // raw artifact against the CURRENT fixtures/scoring — zero API calls
  // (used when a checker bug is fixed after a live run).
  if (process.env.EVAL_RESCORE === "1") {
    if (!existsSync(artifactPath)) throw new Error("EVAL_RESCORE=1 but no raw artifact exists yet");
    const { perModel, totalSpend } = rescoreFromArtifact(fixtures, artifactPath);
    return emit(perModel, totalSpend, fixtures, artifactPath, Object.keys(perModel));
  }

  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (apiKey.trim().length === 0) {
    console.log("model-routing eval skipped: OPENROUTER_API_KEY is not set");
    return 0;
  }

  const models = (process.env.EVAL_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  const modelList =
    models.length > 0
      ? models
      : [
          "openai/gpt-4o-mini",
          "anthropic/claude-haiku-4.5",
          "google/gemini-3.8-flash",
          "deepseek/deepseek-chat",
          "openai/gpt-4.1-mini",
        ];
  await verifyModelIds(apiKey, modelList);

  let totalSpend = 0;
  const perModel: Record<
    string,
    { route: readonly CallRecord[]; answer: readonly CallRecord[]; excluded?: string }
  > = {};
  const sleepMs =
    process.env.EVAL_SLEEP_MS !== undefined && process.env.EVAL_SLEEP_MS.length > 0
      ? Number(process.env.EVAL_SLEEP_MS)
      : DEFAULT_SLEEP_MS;

  // EVAL_MERGE=1: fold in previously-run models from the raw artifact so a
  // re-run of a subset (e.g. after rate-limit backoff) keeps the rest.
  if (process.env.EVAL_MERGE === "1" && existsSync(artifactPath)) {
    const previous = JSON.parse(readFileSync(artifactPath, "utf-8")) as {
      totalSpendUsd?: number;
      models?: Record<string, { route: readonly CallRecord[]; answer: readonly CallRecord[]; excluded?: string }>;
    };
    for (const [model, entry] of Object.entries(previous.models ?? {})) {
      if (!modelList.includes(model)) perModel[model] = entry;
    }
    totalSpend += previous.totalSpendUsd ?? 0;
  }

  outer: for (const model of modelList) {
    const routeRecords: CallRecord[] = [];
    const answerRecords: CallRecord[] = [];
    perModel[model] = { route: routeRecords, answer: answerRecords };
    let hardFailures = 0;

    for (const [pass, cases, run] of [
      ["route", fixtures.routeCases, (c: RouteCase) => buildRoutingPrompt(c.text)] as const,
      [
        "answer",
        fixtures.answerCases,
        (c: AnswerCase) =>
          buildAnswerPrompt(
            fixtures.principalName,
            model,
            c.question,
            c.results,
            c.lookupNote,
          ),
      ] as const,
    ] as const) {
      const records = pass === "route" ? routeRecords : answerRecords;
      const maxTokens = pass === "route" ? ROUTE_MAX_TOKENS : ANSWER_MAX_TOKENS;
      for (const [index, fixture] of (cases as readonly (RouteCase | AnswerCase)[]).entries()) {
        if (totalSpend >= SPEND_CEILING_USD) {
          console.error(`spend ceiling $${SPEND_CEILING_USD.toFixed(2)} hit — aborting remaining calls`);
          break outer;
        }
        if (index > 0 || pass === "answer") await sleep(sleepMs);
        const result = await callWithRetry(apiKey, model, run(fixture as never), maxTokens);
        if (!result.ok) {
          if (result.hard) hardFailures += 1;
          records.push({ id: fixture.id, ok: false, latencyMs: null, costUsd: null, promptTokens: null, completionTokens: null, output: "", error: result.error });
          console.error(`  ERROR ${model} ${fixture.id} (attempt ${result.retries + 1}): ${result.error}`);
          if (hardFailures >= MODEL_MAX_HARD_FAILURES) {
            perModel[model].excluded = `${hardFailures} hard failures (last: ${result.error})`;
            console.error(`model ${model} EXCLUDED after ${hardFailures} hard failures`);
            continue outer;
          }
          continue;
        }
        const { outcome } = result;
        totalSpend += outcome.costUsd ?? 0;
        if (pass === "route") {
          const scored = scoreRoute(outcome.text, (fixture as RouteCase).expected);
          routeRecords.push({
            id: fixture.id,
            ok: scored.ok,
            latencyMs: outcome.latencyMs,
            costUsd: outcome.costUsd,
            promptTokens: outcome.promptTokens,
            completionTokens: outcome.completionTokens,
            output: outcome.text,
            parsed: scored.parsed,
          });
        } else {
          const checks = (fixture as AnswerCase).checklist.map((check) => ({
            id: check.id,
            pass: runCheck(outcome.text, check),
          }));
          answerRecords.push({
            id: fixture.id,
            ok: checks.every((c) => c.pass),
            latencyMs: outcome.latencyMs,
            costUsd: outcome.costUsd,
            promptTokens: outcome.promptTokens,
            completionTokens: outcome.completionTokens,
            output: outcome.text,
            checks,
          });
        }
        process.stdout.write(".");
      }
    }
    const routeSum = summarize(routeRecords);
    const answerSum = summarize(answerRecords);
    console.log(
      `\n${model}: route ${routeSum.okCount}/${routeSum.calls} (${pct(routeSum.compliancePct)}) · answer ${answerSum.okCount}/${answerSum.calls} all-check (${pct(answerSum.compliancePct)}) · avg lat ${routeSum.avgLatencyMs?.toFixed(0) ?? "?"}/${answerSum.avgLatencyMs?.toFixed(0) ?? "?"}ms · spend $${(routeSum.totalCostUsd + answerSum.totalCostUsd).toFixed(4)}`,
    );
  }

  return emit(perModel, totalSpend, fixtures, artifactPath, modelList);
}

/** Deterministic offline re-score: replay the recorded outputs through the
 *  REAL parsers/checks exactly as the live path would score them. */
function rescoreFromArtifact(
  fixtures: Fixtures,
  artifactPath: string,
): {
  perModel: Record<string, { route: readonly CallRecord[]; answer: readonly CallRecord[]; excluded?: string }>;
  totalSpend: number;
} {
  const previous = JSON.parse(readFileSync(artifactPath, "utf-8")) as {
    totalSpendUsd?: number;
    models?: Record<string, { route: readonly CallRecord[]; answer: readonly CallRecord[]; excluded?: string }>;
  };
  const perModel: Record<string, { route: readonly CallRecord[]; answer: readonly CallRecord[]; excluded?: string }> = {};
  // Wallet truth: the recorded total (which includes superseded/aborted
  // attempt spend) never shrinks on a re-score — only scoring changes.
  const totalSpend = previous.totalSpendUsd ?? 0;
  for (const [model, entry] of Object.entries(previous.models ?? {})) {
    const route = entry.route.map((record) => {
      const fixture = fixtures.routeCases.find((c) => c.id === record.id);
      if (record.error !== undefined || fixture === undefined) return record;
      const scored = scoreRoute(record.output, fixture.expected);
      return { ...record, ok: scored.ok, parsed: scored.parsed };
    });
    const answer = entry.answer.map((record) => {
      const fixture = fixtures.answerCases.find((c) => c.id === record.id);
      if (record.error !== undefined || fixture === undefined) return record;
      const checks = fixture.checklist.map((check) => ({ id: check.id, pass: runCheck(record.output, check) }));
      return { ...record, ok: checks.every((c) => c.pass), checks };
    });
    perModel[model] = { route, answer, excluded: entry.excluded };
  }
  return { perModel, totalSpend };
}

/** Shared artifact write + console tables for both the live and rescore paths. */
function emit(
  perModel: Record<string, { route: readonly CallRecord[]; answer: readonly CallRecord[]; excluded?: string }>,
  totalSpend: number,
  fixtures: Fixtures,
  artifactPath: string,
  modelList: readonly string[],
): number {
  const artifact = {
    ranAt: new Date().toISOString(),
    fixturesVersion: fixtures.version,
    promptVersions: { route: "imessage-converse-v3-route (buildRoutingPrompt)", answer: "imessage-converse-v2 (buildAnswerPrompt)" },
    totalSpendUsd: totalSpend,
    models: perModel,
  };
  const outDir = path.dirname(artifactPath);
  mkdirSync(outDir, { recursive: true });
  const outFile = artifactPath;
  writeFileSync(outFile, `${JSON.stringify(artifact, null, 2)}\n`);

  const tableModels = [...modelList, ...Object.keys(perModel).filter((m) => !modelList.includes(m))];
  console.log("\nROUTE PASS (strict parser compliance)");
  console.log("model".padEnd(34), "compliance", "lookup", "action", "chitchat", "advers", "avg ms", "avg $/call");
  for (const model of tableModels) {
    const s = summarize(perModel[model]?.route ?? []);
    const g = (name: string): string => {
      const bucket = s.byGroup.find((b) => b.group === name.toUpperCase());
      return bucket === undefined ? "-" : `${bucket.ok}/${bucket.n}`;
    };
    console.log(
      model.padEnd(34),
      pct(s.compliancePct).padEnd(10),
      g("l").padEnd(6),
      g("a").padEnd(6),
      g("c").padEnd(7),
      g("x").padEnd(7),
      String(s.avgLatencyMs?.toFixed(0) ?? "n/a").padEnd(6),
      s.avgCostUsd?.toFixed(6) ?? "n/a",
    );
  }
  console.log("\nANSWER PASS (checklist fraction — coarse, see raw JSON texts for eyeballing)");
  console.log("model".padEnd(34), "all-check", "avg checklist score", "avg ms", "avg $/call");
  for (const model of tableModels) {
    const records = perModel[model]?.answer ?? [];
    const done = records.filter((r) => r.error === undefined);
    const points = done.map((r) => (r.checks ?? []).filter((c) => c.pass).length);
    const denom = done.length === 0 ? 1 : done.reduce((s, r) => s + (r.checks ?? []).length, 0);
    const s = summarize(records);
    const scorePct = denom === 0 ? 0 : (points.reduce((a, b) => a + b, 0) / denom) * 100;
    console.log(
      model.padEnd(34),
      `${s.okCount}/${s.calls}`.padEnd(9),
      scorePct.toFixed(1).padEnd(19),
      String(s.avgLatencyMs?.toFixed(0) ?? "n/a").padEnd(6),
      s.avgCostUsd?.toFixed(6) ?? "n/a",
    );
  }
  const excluded = tableModels.filter((m) => perModel[m]?.excluded !== undefined);
  if (excluded.length > 0) {
    console.log("\nEXCLUDED MODELS");
    for (const model of excluded) console.log(`  ${model}: ${perModel[model]?.excluded}`);
  }
  console.log(`\nTotal spend: $${totalSpend.toFixed(4)} (ceiling $${SPEND_CEILING_USD.toFixed(2)})`);
  console.log(`Raw results (per-case texts + checks): ${path.relative(process.cwd(), outFile)}`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("model-routing eval crashed:", error instanceof Error ? `${error.name}: ${error.message}` : error);
      process.exitCode = 1;
    },
  );
}
