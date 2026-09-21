/**
 * W3 answer-quality bake-off harness (plan §7 W3 + §13, R5).
 *
 * Compares candidate ANSWER-tier models on the REAL gateway answer pass
 * (`buildAnswerPrompt` from @jehad/core) over scenario fixtures shaped
 * exactly like `executeReadTool` output (synthesis / what's-going-on with
 * sample DATA blocks, multi-turn reasoning with prior exchanges,
 * explain-why, plain chat).
 *
 * Two modes:
 *  - HERMETIC (always, no network): structural smoke with the fake
 *    provider — every scenario prompt must carry the expected DATA
 *    boundary / history block / question, and the full scoring pipeline
 *    (reply → blind judge → rubric parse → aggregation) must run green on
 *    scripted outputs.
 *  - LIVE (needs OPENROUTER_API_KEY): each scenario is sent to every
 *    candidate; every reply is then scored 1-5 on five rubric items by an
 *    INDEPENDENT-FAMILY judge (default google/gemini-2.5-flash — a
 *    different family from every candidate) that sees scenario + reply
 *    ONLY (blind: never the model name). Total live spend is capped
 *    ($3.00 default); the run aborts when actual + projected spend would
 *    exceed the ceiling. Results land in docs/evals/.
 */

import type { ModelRequest, ModelResult } from "@jehad/adapters";
import { FakeModelProvider } from "@jehad/adapters";
import { buildAnswerPrompt } from "@jehad/core";
import type { ReadToolResult, WorkingContext } from "@jehad/core";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- fixtures

export interface PriorTurn {
  readonly direction: "inbound" | "outbound";
  readonly content: string;
}

export interface AnswerScenario {
  readonly id: string;
  readonly group: "synthesis" | "multiturn" | "explainwhy" | "plainchat";
  readonly question: string;
  readonly results: readonly ReadToolResult[];
  readonly priorTurns?: readonly PriorTurn[];
}

export interface AnswerFixtures {
  readonly version: number;
  readonly principalName: string;
  readonly scenarios: readonly AnswerScenario[];
}

const GROUPS = new Set(["synthesis", "multiturn", "explainwhy", "plainchat"]);

export function loadAnswerFixtures(file: string): AnswerFixtures {
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<AnswerFixtures>;
  if (raw.version !== 1 || typeof raw.principalName !== "string" || !Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    throw new Error(`answer-quality fixtures: malformed (${file})`);
  }
  for (const scenario of raw.scenarios) {
    if (
      typeof scenario?.id !== "string" ||
      !GROUPS.has(scenario.group ?? "") ||
      typeof scenario.question !== "string" ||
      !Array.isArray(scenario.results)
    ) {
      throw new Error(`answer-quality fixtures: malformed scenario '${JSON.stringify(scenario?.id)}' (${file})`);
    }
  }
  return raw as AnswerFixtures;
}

// ------------------------------------------------------- prompt fabrication

const HISTORY_BASE_MS = Date.parse("2026-09-21T17:00:00.000Z");

/** Fabricates the thread WorkingContext a multi-turn scenario implies —
 *  the same flattened BEGIN HISTORY block shape production renders. */
export function historyOf(priorTurns: readonly PriorTurn[]): WorkingContext | null {
  if (priorTurns.length === 0) return null;
  const messages = priorTurns.map((turn, index) => ({
    direction: turn.direction,
    trustClass: turn.direction === "inbound" ? ("authenticated_user_intent" as const) : ("assistant_output" as const),
    content: turn.content,
    receivedAt: new Date(HISTORY_BASE_MS + index * 60_000).toISOString(),
    tokenEstimate: Math.ceil(turn.content.length / 4),
  }));
  return {
    threadId: "00000000-0000-0000-0000-000000000000",
    messages,
    tokenEstimate: messages.reduce((sum, m) => sum + m.tokenEstimate, 0),
    truncated: false,
    oldestAt: messages[0]?.receivedAt ?? null,
  };
}

/** The REAL gateway answer prompt for one scenario at one candidate model. */
export function buildScenarioPrompt(principalName: string, model: string, scenario: AnswerScenario): string {
  return buildAnswerPrompt(
    principalName,
    model,
    scenario.question,
    scenario.results,
    null,
    historyOf(scenario.priorTurns ?? []),
  );
}

// --------------------------------------------------------- hermetic checks

export interface HermeticFailure {
  readonly scenarioId: string;
  readonly problem: string;
}

/** Structural smoke over every scenario's REAL prompt. Pure — no IO, no
 *  provider. Catches fixture drift (missing DATA blocks, silent history)
 *  before any live spend. */
export function checkPromptStructure(fixtures: AnswerFixtures): readonly HermeticFailure[] {
  const failures: HermeticFailure[] = [];
  for (const scenario of fixtures.scenarios) {
    const prompt = buildScenarioPrompt(fixtures.principalName, "fake/candidate", scenario);
    if (!prompt.includes(scenario.question)) {
      failures.push({ scenarioId: scenario.id, problem: "question not present in the built prompt" });
    }
    const hasData = prompt.includes("BEGIN DATA") && prompt.includes("END DATA");
    if (scenario.results.length > 0 && !hasData) {
      failures.push({ scenarioId: scenario.id, problem: "results present but no BEGIN/END DATA boundary" });
    }
    if (scenario.results.length === 0 && hasData) {
      failures.push({ scenarioId: scenario.id, problem: "no results but a DATA boundary appeared" });
    }
    for (const result of scenario.results) {
      if (!prompt.includes(`[tool: ${result.tool}`)) {
        failures.push({ scenarioId: scenario.id, problem: `DATA block for ${result.tool} missing` });
      }
    }
    if ((scenario.priorTurns?.length ?? 0) > 0 && !prompt.includes("BEGIN HISTORY")) {
      failures.push({ scenarioId: scenario.id, problem: "priorTurns present but no BEGIN HISTORY block" });
    }
    if ((scenario.priorTurns?.length ?? 0) === 0 && prompt.includes("BEGIN HISTORY")) {
      failures.push({ scenarioId: scenario.id, problem: "no priorTurns but a HISTORY block appeared" });
    }
  }
  return failures;
}

// ------------------------------------------------------------ judge scoring

export const RUBRIC_ITEMS = ["groundedness", "prioritization", "honesty", "concision", "referents"] as const;
export type RubricItem = (typeof RUBRIC_ITEMS)[number];

export interface JudgeScores {
  readonly groundedness: number;
  readonly prioritization: number;
  readonly honesty: number;
  readonly concision: number;
  readonly referents: number;
  readonly notes: string;
}

const RUBRIC_DEFINITIONS: Readonly<Record<RubricItem, string>> = {
  groundedness:
    "every factual claim is traceable to the DATA or the prior conversation; nothing invented, nothing contradicted by the data",
  prioritization:
    "the reply leads with what actually matters most for the user (blocked/overdue/urgent first) instead of an unranked dump or trivia",
  honesty:
    "coverage limits, staleness, unverified-occurrence and unknowns are stated plainly; no false comprehensiveness, no claiming checks that did not happen",
  concision: "appropriate for a text message: tight, no filler, no restating the question",
  referents:
    "references to earlier turns or DATA items ('the second one', 'the earlier one', 'it') resolve correctly — and no referents are hallucinated where none exist",
};

/** BLIND judge prompt: scenario + reply only. The candidate model's name
 *  never appears (R5 — independent-family judge, no self-preference). */
export function buildJudgePrompt(scenario: AnswerScenario, reply: string): string {
  const lines = [
    "You are an impartial quality evaluator for a personal-assistant SMS/iMessage gateway. You are judging ONE reply against the reference data the assistant had.",
    "Score the reply 1-5 on each rubric item (1 = failing, 3 = acceptable, 5 = excellent). Judge only what is in front of you.",
  ];
  for (const item of RUBRIC_ITEMS) {
    lines.push(`- ${item}: ${RUBRIC_DEFINITIONS[item]}`);
  }
  lines.push("", "== SCENARIO ==", `User message: ${scenario.question}`);
  if ((scenario.priorTurns?.length ?? 0) > 0) {
    lines.push("Conversation so far:");
    for (const turn of scenario.priorTurns ?? []) {
      lines.push(`${turn.direction === "inbound" ? "User" : "Assistant"}: ${turn.content}`);
    }
  }
  if (scenario.results.length > 0) {
    lines.push("Reference DATA the assistant had (ground truth for groundedness):");
    for (const result of scenario.results) {
      lines.push(`[tool: ${result.tool} | coverage: ${result.coverage}]`);
      lines.push(JSON.stringify(result.data));
    }
  } else {
    lines.push("Reference DATA the assistant had: none (plain conversational turn).");
  }
  lines.push("", "== REPLY TO EVALUATE ==", reply, "");
  lines.push(
    'Respond with ONLY one JSON object on a single line, no prose, no markdown: {"groundedness":n,"prioritization":n,"honesty":n,"concision":n,"referents":n,"notes":"one short sentence"}',
  );
  return lines.join("\n");
}

/** Strict-ish judge-output parse: one JSON object, five integer rubric
 *  scores in 1-5, notes string. Anything else → null (recorded as a judge
 *  failure, never silently rescored). */
export function parseJudgeScores(text: string): JudgeScores | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const scores: Partial<Record<RubricItem, number>> = {};
  for (const item of RUBRIC_ITEMS) {
    const value = obj[item];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) return null;
    scores[item] = value;
  }
  return {
    groundedness: scores.groundedness!,
    prioritization: scores.prioritization!,
    honesty: scores.honesty!,
    concision: scores.concision!,
    referents: scores.referents!,
    notes: typeof obj["notes"] === "string" ? obj["notes"].slice(0, 300) : "",
  };
}

// ------------------------------------------------- hermetic pipeline smoke

/** End-to-end pipeline smoke with the fake provider: scripted candidate
 *  reply + scripted judge JSON through the SAME dispatch/score path the
 *  live runner uses. Returns failures; empty = green. */
export async function hermeticPipelineSmoke(fixtures: AnswerFixtures): Promise<readonly HermeticFailure[]> {
  const failures: HermeticFailure[] = [];
  const scenarios = fixtures.scenarios.slice(0, 4); // smoke, not the corpus
  const provider = new FakeModelProvider({
    respond: (request: ModelRequest): ModelResult => {
      if (request.prompt.includes("impartial quality evaluator")) {
        return {
          text: '{"groundedness":5,"prioritization":4,"honesty":5,"concision":3,"referents":5,"notes":"scripted judge"}',
        };
      }
      return { text: "scripted candidate reply" };
    },
  });
  for (const scenario of scenarios) {
    const prompt = buildScenarioPrompt(fixtures.principalName, provider.id, scenario);
    const candidate = await provider.complete({ ...emptyRequest(), prompt });
    const judgePrompt = buildJudgePrompt(scenario, candidate.text);
    if (judgePrompt.includes(scenarios[0]!.question) && scenario !== scenarios[0]) {
      failures.push({ scenarioId: scenario.id, problem: "judge prompt cross-contaminated between scenarios" });
    }
    if (judgePrompt.includes("gpt-4.1") || judgePrompt.includes("sonnet")) {
      failures.push({ scenarioId: scenario.id, problem: "judge prompt leaks a candidate model name (not blind)" });
    }
    const judged = await provider.complete({ ...emptyRequest(), prompt: judgePrompt });
    const scores = parseJudgeScores(judged.text);
    if (scores === null || scores.groundedness !== 5 || scores.concision !== 3) {
      failures.push({ scenarioId: scenario.id, problem: "judge score parse failed on scripted output" });
    }
  }
  return failures;
}

function emptyRequest(): ModelRequest {
  return {
    domainId: "personal",
    sensitivity: "normal",
    provider: "fake",
    model: "fake/candidate",
    prompt: "",
    runId: "hermetic",
  };
}

// ------------------------------------------------------------ aggregation

export interface ScoredReply {
  readonly scenarioId: string;
  readonly group: string;
  readonly model: string;
  readonly reply: string;
  readonly scores: JudgeScores | null;
  readonly latencyMs: number | null;
  readonly costUsd: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly error?: string;
}

export interface ModelSummary {
  readonly model: string;
  readonly scored: number;
  readonly judgeFailures: number;
  readonly errors: number;
  readonly overallMean: number | null;
  readonly perRubric: Readonly<Record<RubricItem, number | null>>;
  readonly perGroup: readonly { readonly group: string; readonly mean: number | null; readonly n: number }[];
  readonly avgLatencyMs: number | null;
  readonly totalCostUsd: number;
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

export function summarizeModel(model: string, records: readonly ScoredReply[]): ModelSummary {
  const done = records.filter((r) => r.error === undefined);
  const scored = done.filter((r) => r.scores !== null);
  const perRubric = Object.fromEntries(
    RUBRIC_ITEMS.map((item) => [item, mean(scored.map((r) => r.scores![item]))]),
  ) as Record<RubricItem, number | null>;
  const groups = [...new Set(records.map((r) => r.group))].sort();
  return {
    model,
    scored: scored.length,
    judgeFailures: done.filter((r) => r.scores === null).length,
    errors: records.filter((r) => r.error !== undefined).length,
    overallMean: mean(scored.map((r) => mean(RUBRIC_ITEMS.map((i) => r.scores![i]))!)),
    perRubric,
    perGroup: groups.map((group) => {
      const bucket = scored.filter((r) => r.group === group);
      return { group, mean: mean(bucket.map((r) => mean(RUBRIC_ITEMS.map((i) => r.scores![i]))!)), n: bucket.length };
    }),
    avgLatencyMs: mean(done.map((r) => r.latencyMs).filter((l): l is number => l !== null)),
    totalCostUsd: done.reduce((s, r) => s + (r.costUsd ?? 0), 0),
  };
}

/** Family prefix of an OpenRouter id ("openai/gpt-4.1" → "openai"). */
export function modelFamily(model: string): string {
  return model.split("/")[0] ?? model;
}

// -------------------------------------------------------------- live calls

export const DEFAULT_CANDIDATES = [
  "openai/gpt-4.1",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-4o-mini", // incumbent baseline (principal default)
] as const;
export const DEFAULT_JUDGE = "google/gemini-2.5-flash";
export const ANSWER_MAX_TOKENS = 800;
export const JUDGE_MAX_TOKENS = 400;
/** Total live spend ceiling for the whole bake-off (task cap: $3). */
export const SPEND_CEILING_USD = 3.0;

export interface CallOutcome {
  readonly text: string;
  readonly latencyMs: number;
  readonly costUsd: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

/** One chat completion through the REAL provider request shape (mirrors
 *  evals/model-routing.ts: single user-role message, temperature 0,
 *  max_tokens cap). */
export async function liveCallOnce(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<CallOutcome> {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(90_000),
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

export const RATE_LIMIT_BACKOFF_MS = 30_000;

export async function liveCallWithRetry(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  maxTokens: number,
): Promise<{ ok: true; outcome: CallOutcome } | { ok: false; error: string; rateLimited: boolean }> {
  let lastError = "unknown error";
  let lastRateLimited = false;
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, lastRateLimited ? RATE_LIMIT_BACKOFF_MS : 500));
    }
    try {
      return { ok: true, outcome: await liveCallOnce(apiKey, baseUrl, model, prompt, maxTokens) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastRateLimited = lastError.includes("429");
      if (attempt === attempts - 1) break;
    }
  }
  return { ok: false, error: lastError, rateLimited: lastRateLimited };
}

/** Verify every candidate + judge id exists via GET /models. */
export async function verifyModelIds(apiKey: string, baseUrl: string, models: readonly string[]): Promise<void> {
  const response = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`model verification: GET /models returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: readonly { id?: string }[] };
  const ids = new Set((body.data ?? []).map((m) => m.id).filter((id): id is string => id !== undefined));
  const missing = models.filter((m) => !ids.has(m));
  if (missing.length > 0) throw new Error(`model verification: unknown ids on OpenRouter: ${missing.join(", ")}`);
}

// ------------------------------------------------------------------- spend

/** Spend guard: actual spend plus a linear projection from the calls
 *  completed so far. Aborts (returns false) when projected total would
 *  exceed the ceiling — before the next paid call is made. */
export function projectedWithinCeiling(input: {
  readonly spendUsd: number;
  readonly completedCalls: number;
  readonly plannedCalls: number;
  readonly ceilingUsd: number;
}): boolean {
  if (input.completedCalls <= 0) return true;
  const avg = input.spendUsd / input.completedCalls;
  return input.spendUsd + avg * (input.plannedCalls - input.completedCalls) <= input.ceilingUsd;
}

/** Loads fixtures from the conventional path next to this module. */
export function fixturesPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const file = path.join(here, "fixtures.json");
  if (!existsSync(file)) throw new Error(`answer-quality fixtures not found at ${file}`);
  return file;
}
