/**
 * §5 model bake-off — TRACK A: multi-candidate answer-only runner
 * (docs/plans/intelligence-reset.md §5; extends the W3 answer-quality
 * infrastructure).
 *
 * Same fixed inputs for every candidate (the existing runner already
 * guarantees this): system context, persona fragment, self-brief, thread
 * history, tools + DATA blocks, source data, prompt version
 * `imessage-converse-v2` via the REAL `buildAnswerPrompt`. Blind judge
 * unchanged (google/gemini-2.5-flash, independent family, scenario + reply
 * only).
 *
 * Modes:
 *  - HERMETIC (default, zero network): full grid through the fake provider —
 *    validates prompt building, dispatch, judging, aggregation, the
 *    candidates[] result schema, and artifact writing.
 *  - LIVE (`--live` + OPENROUTER_API_KEY): a 2-scenario smoke measures
 *    per-answer means FIRST; the full run refuses to start if the projection
 *    (scenario count × measured means × candidate count, judge included)
 *    exceeds the $4 Track-A split. An in-run linear guard aborts before any
 *    call that would breach the ceiling.
 *
 * CLI: tsx evals/answer-quality/run.ts --track-a [--candidates id,id]
 *      [--smoke] [--live] [--judge id]
 * `--smoke` = run ONLY the live smoke and report the projection + gate
 * decision (no full grid).
 *
 * Outputs: evals/model-bakeoff/out/track-a-2026-09.{raw.json,md} — the
 * raw.json EXTENDS the existing answer-quality schema (ranAt, fixturesVersion,
 * promptVersion, judge, blind, spendCeilingUsd, aborted, totalSpendUsd,
 * models{}) with `candidates[]`: per candidate per-scenario five-dim scores,
 * mean, total cost, p50/p95 latency.
 */

import {
  ANSWER_MAX_TOKENS,
  JUDGE_MAX_TOKENS,
  RUBRIC_ITEMS,
  type AnswerFixtures,
  type JudgeScores,
  type RubricItem,
  type ScoredReply,
  buildJudgePrompt,
  buildScenarioPrompt,
  fixturesPath,
  liveCallWithRetry,
  loadAnswerFixtures,
  modelFamily,
  parseJudgeScores,
  projectedWithinCeiling,
  verifyModelIds,
} from "../answer-quality/runner.js";
import {
  TRACK_A_CEILING_USD,
  SMOKE_SCENARIOS,
  gateFullRun,
  meanOf,
  percentile,
  projectFullRun,
  type GateDecision,
} from "./gating.js";
import {
  BASE_URL,
  DEFAULT_JUDGE,
  DEFAULT_SLEEP_MS,
  TRACK_A_CANDIDATES,
  liveGate,
  outDir,
  parseArgv,
  resolveApiKey,
  resolveCandidates,
  sleepMs,
  writeArtifact,
  loadDotEnv,
} from "./shared.js";
import type { ModelRequest, ModelResult } from "@jehad/adapters";
import { FakeModelProvider } from "@jehad/adapters";
import { writeFileSync } from "node:fs";
import path from "node:path";

// ------------------------------------------------------------- dispatch

interface DispatchOutcome {
  readonly text: string;
  readonly latencyMs: number;
  readonly costUsd: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

type Dispatcher = (
  model: string,
  prompt: string,
  maxTokens: number,
) => Promise<{ ok: true; outcome: DispatchOutcome } | { ok: false; error: string }>;

/** Hermetic dispatcher: fake provider, scripted judge JSON + replies. */
function hermeticDispatcher(): Dispatcher {
  const provider = new FakeModelProvider({
    respond: (request: ModelRequest): ModelResult => {
      if (request.prompt.includes("impartial quality evaluator")) {
        return {
          text: '{"groundedness":5,"prioritization":4,"honesty":5,"concision":4,"referents":5,"notes":"hermetic scripted judge"}',
        };
      }
      return { text: `hermetic candidate reply (${request.model})` };
    },
  });
  return async (model, prompt) => {
    const started = Date.now();
    const result = await provider.complete({
      domainId: "personal",
      sensitivity: "normal",
      provider: "fake",
      model,
      prompt,
      runId: "track-a-hermetic",
    });
    return {
      ok: true,
      outcome: {
        text: result.text,
        latencyMs: Date.now() - started,
        costUsd: null,
        promptTokens: null,
        completionTokens: null,
      },
    };
  };
}

function liveDispatcher(apiKey: string, pacing: number): Dispatcher {
  let calls = 0;
  return async (model, prompt, maxTokens) => {
    if (calls > 0) await new Promise((resolve) => setTimeout(resolve, pacing));
    calls += 1;
    const call = await liveCallWithRetry(apiKey, BASE_URL, model, prompt, maxTokens);
    return call.ok ? { ok: true, outcome: call.outcome } : { ok: false, error: call.error };
  };
}

// ----------------------------------------------------------- aggregation

export interface TrackACandidateSummary {
  readonly model: string;
  readonly scored: number;
  readonly judgeFailures: number;
  readonly errors: number;
  readonly mean: number | null;
  readonly perRubric: Readonly<Record<RubricItem, number | null>>;
  readonly perScenario: readonly {
    readonly scenarioId: string;
    readonly mean: number | null;
    readonly scores: JudgeScores | null;
  }[];
  readonly totalCostUsd: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
}

/** The `candidates[]` array of the extended raw.json schema. */
export function summarizeCandidate(model: string, records: readonly ScoredReply[]): TrackACandidateSummary {
  const done = records.filter((r) => r.error === undefined);
  const scored = done.filter((r) => r.scores !== null);
  const perScenarioMean = (r: ScoredReply): number | null =>
    r.scores === null ? null : meanOf(RUBRIC_ITEMS.map((i) => r.scores![i]));
  const perRubric = Object.fromEntries(
    RUBRIC_ITEMS.map((item) => [item, meanOf(scored.map((r) => r.scores![item]))]),
  ) as Record<RubricItem, number | null>;
  const scenarioOrder = [...new Set(records.map((r) => r.scenarioId))];
  return {
    model,
    scored: scored.length,
    judgeFailures: done.filter((r) => r.scores === null).length,
    errors: records.filter((r) => r.error !== undefined).length,
    mean: meanOf(scored.map(perScenarioMean).filter((m): m is number => m !== null)),
    perRubric,
    perScenario: scenarioOrder.map((scenarioId) => {
      const record = records.find((r) => r.scenarioId === scenarioId) ?? null;
      return {
        scenarioId,
        mean: record === null ? null : perScenarioMean(record),
        scores: record?.scores ?? null,
      };
    }),
    totalCostUsd: done.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    p50LatencyMs: percentile(done.map((r) => r.latencyMs).filter((l): l is number => l !== null), 50),
    p95LatencyMs: percentile(done.map((r) => r.latencyMs).filter((l): l is number => l !== null), 95),
  };
}

export interface TrackASmokeMeasures {
  readonly candidatePerAnswerUsd: Map<string, number>;
  readonly judgePerCallUsd: number;
  readonly smokeSpendUsd: number;
}

/**
 * Smoke measures from smoke-phase records: per-candidate mean reply cost,
 * judge mean cost per completed judge call, and the smoke-phase spend
 * (candidate replies + judge calls + failed retries). Pure.
 */
export function smokeMeasuresOf(
  smokeRecords: readonly ScoredReply[],
  candidates: readonly string[],
  judgeSpendUsd: number,
  judgeCallsCompleted: number,
): TrackASmokeMeasures {
  const candidatePerAnswerUsd = new Map<string, number>();
  for (const model of candidates) {
    const costs = smokeRecords
      .filter((r) => r.model === model && r.error === undefined && r.costUsd !== null)
      .map((r) => r.costUsd!);
    if (costs.length > 0) candidatePerAnswerUsd.set(model, meanOf(costs)!);
  }
  return {
    candidatePerAnswerUsd,
    judgePerCallUsd: judgeCallsCompleted > 0 ? judgeSpendUsd / judgeCallsCompleted : 0,
    smokeSpendUsd:
      smokeRecords.reduce((s, r) => s + (r.costUsd ?? 0), 0) + judgeSpendUsd,
  };
}

// ------------------------------------------------------------ the runner

export interface TrackAOptions {
  readonly candidates: readonly string[];
  readonly judge: string;
  readonly live: boolean;
  readonly dryRunReason: string | null;
  readonly smokeOnly: boolean;
}

export interface TrackAResult {
  readonly exitCode: number;
  readonly raw: Record<string, unknown>;
  readonly records: readonly ScoredReply[];
}

export async function runTrackAWithOptions(
  fixtures: AnswerFixtures,
  apiKey: string,
  options: TrackAOptions,
): Promise<TrackAResult> {
  const { candidates, judge } = options;
  const pacing = sleepMs(DEFAULT_SLEEP_MS);
  const plannedCalls = fixtures.scenarios.length * candidates.length * 2;
  let completedCalls = 0;
  let judgeCallsCompleted = 0;
  let judgeSpend = 0;
  let totalSpend = 0;
  let aborted: string | null = null;
  let gate: GateDecision | null = null;
  const records: ScoredReply[] = [];
  const dispatch = options.live
    ? liveDispatcher(apiKey, pacing)
    : hermeticDispatcher();

  if (options.live) {
    // R5 structural rule, same as the W3 runner: refuse same-family judge.
    const families = new Set(candidates.map(modelFamily));
    if (families.has(modelFamily(judge))) {
      const message =
        `track-a: judge ${judge} shares a family with a candidate (${[...families].join(", ")}) — ` +
        `refusing self-family judging (R5). Pass --judge <id> from a family outside ` +
        `${[...families].join("/")}.`;
      console.error(message);
      return {
        exitCode: 1,
        raw: { error: message },
        records: [],
      };
    }
    await verifyModelIds(apiKey, BASE_URL, [...candidates, judge]);
  }

  // Scenario-major order: after SMOKE_SCENARIOS scenarios every candidate has
  // smoke measures, so the full-run gate sees the whole grid before any
  // candidate runs past the smoke (plan §5: gate BEFORE the full run).
  const smokeScenarioIds = new Set(fixtures.scenarios.slice(0, SMOKE_SCENARIOS).map((s) => s.id));
  outer: for (const scenario of fixtures.scenarios) {
    for (const model of candidates) {
      if (options.live && !projectedWithinCeiling({ spendUsd: totalSpend, completedCalls, plannedCalls, ceilingUsd: TRACK_A_CEILING_USD })) {
        aborted = `in-run projection over the $${TRACK_A_CEILING_USD.toFixed(2)} ceiling after ${completedCalls} calls ($${totalSpend.toFixed(4)} actual)`;
        break outer;
      }
      const prompt = buildScenarioPrompt(fixtures.principalName, model, scenario);
      const replyCall = await dispatch(model, prompt, ANSWER_MAX_TOKENS);
      completedCalls += 1;
      if (!replyCall.ok) {
        records.push({ scenarioId: scenario.id, group: scenario.group, model, reply: "", scores: null, latencyMs: null, costUsd: null, promptTokens: null, completionTokens: null, error: `candidate: ${replyCall.error}` });
        console.error(`  ERROR ${model} ${scenario.id}: ${replyCall.error}`);
        continue;
      }
      totalSpend += replyCall.outcome.costUsd ?? 0;
      const judgeCall = await dispatch(judge, buildJudgePrompt(scenario, replyCall.outcome.text), JUDGE_MAX_TOKENS);
      completedCalls += 1;
      judgeCallsCompleted += 1;
      judgeSpend += judgeCall.ok ? (judgeCall.outcome.costUsd ?? 0) : 0;
      if (!judgeCall.ok) {
        records.push({ scenarioId: scenario.id, group: scenario.group, model, reply: replyCall.outcome.text, scores: null, latencyMs: replyCall.outcome.latencyMs, costUsd: replyCall.outcome.costUsd, promptTokens: replyCall.outcome.promptTokens, completionTokens: replyCall.outcome.completionTokens, error: `judge: ${judgeCall.error}` });
        console.error(`  JUDGE ERROR ${scenario.id} (${model}): ${judgeCall.error}`);
        continue;
      }
      totalSpend += judgeCall.outcome.costUsd ?? 0;
      records.push({
        scenarioId: scenario.id,
        group: scenario.group,
        model,
        reply: replyCall.outcome.text,
        scores: parseJudgeScores(judgeCall.outcome.text),
        latencyMs: replyCall.outcome.latencyMs,
        costUsd: replyCall.outcome.costUsd,
        promptTokens: replyCall.outcome.promptTokens,
        completionTokens: replyCall.outcome.completionTokens,
      });
      process.stdout.write(".");
    }
    // Full-run gate after the smoke scenarios complete (live only).
    if (options.live && scenario.id === fixtures.scenarios[SMOKE_SCENARIOS - 1]?.id) {
      const measures = smokeMeasuresOf(
        records.filter((r) => smokeScenarioIds.has(r.scenarioId)),
        candidates,
        judgeSpend,
        judgeCallsCompleted,
      );
      const projected = projectFullRun({
        measures,
        totalScenarios: fixtures.scenarios.length,
        smokeScenarios: SMOKE_SCENARIOS,
      });
      gate = gateFullRun(projected, TRACK_A_CEILING_USD);
      console.log(
        `\nsmoke gate: projected full run $${projected.toFixed(4)} vs $${TRACK_A_CEILING_USD.toFixed(2)} split — ${gate.ok ? "OPEN" : `REFUSED (${gate.reason})`}`,
      );
      if (options.smokeOnly) {
        aborted = "smoke-only mode — full grid skipped by --smoke";
        break outer;
      }
      if (!gate.ok) {
        aborted = gate.reason;
        break outer;
      }
    }
  }

  const candidateSummaries = candidates.map((model) => summarizeCandidate(model, records.filter((r) => r.model === model)));
  const raw = {
    ranAt: new Date().toISOString(),
    track: "A",
    mode: options.smokeOnly ? "smoke" : "full",
    fixturesVersion: fixtures.version,
    promptVersion: "imessage-converse-v2 (buildAnswerPrompt)",
    judge,
    blind: true,
    live: options.live,
    dryRunReason: options.dryRunReason,
    smoke:
      gate === null
        ? null
        : {
            scenarios: SMOKE_SCENARIOS,
            projectedFullRunUsd: gate.projectedUsd,
            ceilingUsd: gate.ceilingUsd,
            gate: gate.ok ? "open" : "refused",
            reason: gate.reason,
          },
    spendCeilingUsd: TRACK_A_CEILING_USD,
    aborted,
    totalSpendUsd: totalSpend,
    candidates: candidateSummaries,
    models: Object.fromEntries(candidates.map((model) => [model, records.filter((r) => r.model === model)])),
  };
  return {
    exitCode: aborted !== null && gate !== null && !gate.ok ? 2 : 0,
    raw,
    records,
  };
}

// --------------------------------------------------------------- reports

const fmt = (x: number | null): string => (x === null ? "n/a" : x.toFixed(2));

export function trackAMarkdown(input: {
  readonly fixtures: AnswerFixtures;
  readonly raw: Record<string, unknown>;
  readonly candidates: readonly TrackACandidateSummary[];
}): string {
  const { fixtures, candidates } = input;
  const lines: string[] = [];
  lines.push("# §5 Track A — multi-candidate answer-only bake-off (2026-09)");
  lines.push("");
  lines.push(
    `${fixtures.scenarios.length} scenarios × ${candidates.length} candidates through the REAL gateway answer prompt ` +
      "(`buildAnswerPrompt`, `imessage-converse-v2`) — same system context, persona, self-brief, history, tools, source data, " +
      "and prompt version for every candidate (the W3 harness guarantees identical inputs).",
  );
  lines.push("");
  lines.push(`- Blind judge unchanged: \`${input.raw["judge"] as string}\` (independent family, scenario + reply only).`);
  lines.push(
    `- ${input.raw["live"] === true ? "LIVE" : `HERMETIC dry run (${String(input.raw["dryRunReason"] ?? "")})`} · mode \`${String(input.raw["mode"])}\` · ceiling $${TRACK_A_CEILING_USD.toFixed(2)} (smoke-gated: 2-scenario measured projection before the full run).`,
  );
  const smoke = input.raw["smoke"] as { projectedFullRunUsd: number; gate: string } | null;
  if (smoke !== null) {
    lines.push(`- Smoke gate: projected full run $${smoke.projectedFullRunUsd.toFixed(4)} → **${smoke.gate}**.`);
  }
  lines.push(`- **Total spend: $${Number(input.raw["totalSpendUsd"] ?? 0).toFixed(4)}.**`);
  const aborted = input.raw["aborted"] as string | null;
  if (aborted !== null) lines.push(`- ⚠ ${aborted}`);
  lines.push("");
  lines.push("## Per-candidate summary (1-5, blind judge)");
  lines.push("");
  lines.push(`| model | mean | ${RUBRIC_ITEMS.join(" | ")} | scored | cost | p50 ms | p95 ms |`);
  lines.push(`| --- | --- | ${RUBRIC_ITEMS.map(() => "---").join(" | ")} | --- | --- | --- | --- |`);
  for (const c of candidates) {
    lines.push(
      `| ${c.model} | ${fmt(c.mean)} | ${RUBRIC_ITEMS.map((i) => fmt(c.perRubric[i])).join(" | ")} | ${c.scored}/${fixtures.scenarios.length} | $${c.totalCostUsd.toFixed(4)} | ${c.p50LatencyMs?.toFixed(0) ?? "n/a"} | ${c.p95LatencyMs?.toFixed(0) ?? "n/a"} |`,
    );
  }
  lines.push("");
  lines.push("## Decision-ladder context (§5)");
  lines.push("");
  lines.push(
    "- D-1 score bar: strongest candidate must beat the incumbent run by ≥ **+0.3** on the 1-5 blind-judge mean (model-touched turns; Track A is the answer-only input to that judgment, Track B settles it).",
  );
  lines.push(
    "- D-3 fallback: if no candidate clears the bar, cheapest candidate within ±0.2 of the incumbent ties forward.",
  );
  lines.push(
    "- Trim order if the gate refuses: shrink scenario count (24 → 12) before dropping any candidate; then Track B's third arm; then candidates bottom-up (4o-mini → gemini-3.8-flash → gpt-4.1).",
  );
  lines.push("");
  return lines.join("\n");
}

// ------------------------------------------------------------------ CLI

export async function runTrackA(argv: readonly string[]): Promise<number> {
  loadDotEnv();
  const args = parseArgv(argv);
  const fixtures = loadAnswerFixtures(fixturesPath());
  const apiKey = resolveApiKey();
  const gate = liveGate(args, apiKey);
  const candidates = resolveCandidates(args.options.get("candidates"), TRACK_A_CANDIDATES);
  const judge = args.options.get("judge")?.trim() || process.env.EVAL_JUDGE?.trim() || DEFAULT_JUDGE;
  const smokeOnly = args.flags.has("smoke");

  console.log(
    `track-a: ${fixtures.scenarios.length} scenarios × ${candidates.length} candidates ` +
      `(${candidates.join(", ")}) · judge ${judge} · ${gate.live ? "LIVE" : `hermetic dry run (${gate.reason})`}` +
      (smokeOnly ? " · smoke-only" : ""),
  );

  const result = await runTrackAWithOptions(fixtures, apiKey, {
    candidates,
    judge,
    live: gate.live,
    dryRunReason: gate.reason,
    smokeOnly: gate.live && smokeOnly,
  });
  if (typeof result.raw["error"] === "string") return result.exitCode;

  writeArtifact("track-a-2026-09.raw.json", JSON.stringify(result.raw, null, 2));
  const md = trackAMarkdown({
    fixtures,
    raw: result.raw,
    candidates: result.raw["candidates"] as TrackACandidateSummary[],
  });
  const mdPath = path.join(outDir(), "track-a-2026-09.md");
  writeFileSync(mdPath, `${md}\n`);
  console.log(`\nReport: ${path.relative(process.cwd(), path.join(outDir(), "track-a-2026-09.md"))} (+ .raw.json)`);
  console.log(`Records: ${result.records.length} · spend ${result.raw["totalSpendUsd"]}`);
  return result.exitCode;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  runTrackA(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("track-a eval crashed:", error instanceof Error ? `${error.name}: ${error.message}` : error);
      process.exitCode = 1;
    },
  );
}
