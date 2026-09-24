/**
 * W3 answer-quality bake-off CLI (`pnpm eval:answers`).
 *
 * Always runs the hermetic structural + pipeline smoke (fake provider, no
 * network). With an OpenRouter key (env OPENROUTER_API_KEY, falling back to
 * `launchctl getenv OPENROUTER_API_KEY`) it then runs the live bake-off:
 * 24 scenarios × candidates, blind independent-family judging, spend-capped
 * at $3.00 (actual + projected — aborts before the call that would breach).
 * Skips live gracefully (exit 0) when no key is available.
 *
 * Outputs: docs/evals/answer-quality-2026-09.md (+ .raw.json with every
 * reply, judge score, latency and cost for independent review).
 *
 * §5 Track A mode: `tsx evals/answer-quality/run.ts --track-a
 * [--candidates id,id] [--smoke] [--live] [--judge id]` — the multi-
 * candidate bake-off (6 plan candidates, $4 smoke-gated split, extended
 * candidates[] schema). See evals/model-bakeoff/track-a.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANSWER_MAX_TOKENS,
  DEFAULT_CANDIDATES,
  DEFAULT_JUDGE,
  JUDGE_MAX_TOKENS,
  RUBRIC_ITEMS,
  SPEND_CEILING_USD,
  type AnswerFixtures,
  type ScoredReply,
  buildJudgePrompt,
  buildScenarioPrompt,
  checkPromptStructure,
  fixturesPath,
  hermeticPipelineSmoke,
  liveCallWithRetry,
  loadAnswerFixtures,
  modelFamily,
  parseJudgeScores,
  projectedWithinCeiling,
  summarizeModel,
  verifyModelIds,
} from "./runner.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_SLEEP_MS = 150;
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** env wins over the repo .env file (same convention as model-routing.ts). */
function loadDotEnv(): void {
  const envFile = path.resolve(HERE, "../../.env");
  if (!existsSync(envFile)) return;
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

/** OPENROUTER_API_KEY from env, then the macOS per-user launchd context. */
function resolveApiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY ?? "";
  if (fromEnv.trim().length > 0) return fromEnv;
  try {
    const fromLaunchctl = execSync("launchctl getenv OPENROUTER_API_KEY", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (fromLaunchctl.length > 0) {
      console.log("answer-quality: OPENROUTER_API_KEY resolved via launchctl");
      return fromLaunchctl;
    }
  } catch {
    // launchctl unavailable — skip live
  }
  return "";
}

const fmt = (x: number | null): string => (x === null ? "n/a" : x.toFixed(2));

function markdownReport(input: {
  readonly ranAt: string;
  readonly fixtures: AnswerFixtures;
  readonly candidates: readonly string[];
  readonly judge: string;
  readonly live: boolean;
  readonly aborted: string | null;
  readonly totalSpendUsd: number;
  readonly records: readonly ScoredReply[];
}): string {
  const { fixtures, candidates, judge, records, totalSpendUsd } = input;
  const summaries = candidates.map((model) => summarizeModel(model, records.filter((r) => r.model === model)));
  const lines: string[] = [];
  lines.push("# Answer-quality bake-off — W3 STANDARD/DEEP tiers (2026-09)");
  lines.push("");
  lines.push(`Ran ${input.ranAt}. ${input.live ? "Live" : "SKIPPED (no OPENROUTER_API_KEY — hermetic smoke only)"}.`);
  lines.push("");
  lines.push(
    `${fixtures.scenarios.length} scenarios (${[...new Set(fixtures.scenarios.map((s) => s.group))].join(", ")}) through the REAL gateway answer prompt ` +
      "(`buildAnswerPrompt`, `imessage-converse-v2`) with synthetic DATA blocks shaped exactly like `executeReadTool` output. " +
      "Harness: `evals/answer-quality/run.ts` (`pnpm eval:answers`), fixtures `evals/answer-quality/fixtures.json`, raw per-reply outputs + judge scores: `answer-quality-2026-09.raw.json`.",
  );
  lines.push("");
  lines.push(`- **Blind independent-family judging (R5)**: judge \`${judge}\` (family \`${modelFamily(judge)}\`) sees scenario + reply only — never a candidate model name — and scores each reply 1-5 on: ${RUBRIC_ITEMS.join(", ")}.`);
  lines.push(`- Candidates: ${candidates.map((c) => `\`${c}\``).join(", ")} (the last is the incumbent baseline).`);
  lines.push(`- Temperature 0, max_tokens ${ANSWER_MAX_TOKENS} (answers) / ${JUDGE_MAX_TOKENS} (judge). Sequential, ${DEFAULT_SLEEP_MS}ms pacing, one retry (rate-limits back off 30s).`);
  lines.push(`- Spend ceiling $${SPEND_CEILING_USD.toFixed(2)} (actual + linear projection — the run aborts before the call that would breach it). **Total spend: $${totalSpendUsd.toFixed(4)}.**`);
  if (input.aborted !== null) lines.push(`- ⚠ ABORTED: ${input.aborted}`);
  lines.push("");

  // Per-model means
  lines.push("## Per-model mean scores (1-5, blind judge)");
  lines.push("");
  lines.push("| model | overall | " + RUBRIC_ITEMS.join(" | ") + " | scored | avg ms | cost |");
  lines.push("| --- | --- | " + RUBRIC_ITEMS.map(() => "---").join(" | ") + " | --- | --- | --- |");
  for (const s of summaries) {
    lines.push(
      `| ${s.model} | ${fmt(s.overallMean)} | ${RUBRIC_ITEMS.map((i) => fmt(s.perRubric[i])).join(" | ")} | ${s.scored}/${fixtures.scenarios.length} | ${s.avgLatencyMs?.toFixed(0) ?? "n/a"} | $${s.totalCostUsd.toFixed(4)} |`,
    );
  }
  lines.push("");

  // Per-group
  lines.push("## Per-group means");
  lines.push("");
  const groups = [...new Set(fixtures.scenarios.map((s) => s.group))];
  lines.push(`| model | ${groups.join(" | ")} |`);
  lines.push(`| --- | ${groups.map(() => "---").join(" | ")} |`);
  for (const s of summaries) {
    lines.push(`| ${s.model} | ${groups.map((g) => fmt(s.perGroup.find((x) => x.group === g)?.mean ?? null)).join(" | ")} |`);
  }
  lines.push("");

  // Discordance notes
  lines.push("## Judge discordance notes");
  lines.push("");
  const notes: string[] = [];
  const ranked = [...summaries].sort((a, b) => (b.overallMean ?? -1) - (a.overallMean ?? -1));
  const eligible = ranked.filter((s) => s.judgeFailures + s.errors <= 2 && s.scored > 0);
  const winner = eligible[0] ?? null;
  const runnerUp = eligible[1] ?? null;
  for (const item of RUBRIC_ITEMS) {
    const rubricRanked = [...summaries].sort((a, b) => (b.perRubric[item] ?? -1) - (a.perRubric[item] ?? -1));
    if (winner !== null && rubricRanked[0]?.model !== winner.model) {
      notes.push(`**Rank flip on ${item}**: \`${rubricRanked[0]?.model}\` leads (${fmt(rubricRanked[0]?.perRubric[item] ?? null)}) while \`${winner.model}\` leads overall — the overall winner is not uniformly best.`);
    }
  }
  const baseline = summaries.find((s) => s.model === "openai/gpt-4o-mini") ?? null;
  if (winner !== null && baseline !== null && baseline.model !== winner.model) {
    for (const item of RUBRIC_ITEMS) {
      if ((baseline.perRubric[item] ?? -1) > (winner.perRubric[item] ?? -1)) {
        notes.push(`Incumbent baseline \`gpt-4o-mini\` still beats the winner on **${item}** (${fmt(baseline.perRubric[item] ?? null)} vs ${fmt(winner.perRubric[item] ?? null)}).`);
      }
    }
  }
  const byScenario = new Map<string, ScoredReply[]>();
  for (const record of records) {
    if (record.scores === null) continue;
    const bucket = byScenario.get(record.scenarioId) ?? [];
    bucket.push(record);
    byScenario.set(record.scenarioId, bucket);
  }
  const spread: string[] = [];
  for (const [scenarioId, bucket] of byScenario) {
    if (bucket.length < 2) continue;
    const means = bucket.map((r) => RUBRIC_ITEMS.reduce((s, i) => s + r.scores![i], 0) / RUBRIC_ITEMS.length);
    const max = Math.max(...means);
    const min = Math.min(...means);
    if (max - min >= 2.0) {
      const best = bucket[means.indexOf(max)]?.model;
      const worst = bucket[means.indexOf(min)]?.model;
      spread.push(`${scenarioId} (Δ ${(max - min).toFixed(1)}: ${best} ${max.toFixed(1)} vs ${worst} ${min.toFixed(1)})`);
    }
  }
  if (spread.length > 0) notes.push(`**High-spread scenarios** (≥2.0 between best and worst candidate): ${spread.join(", ")}.`);
  const judgeFailures = records.filter((r) => r.error === undefined && r.scores === null).length;
  if (judgeFailures > 0) notes.push(`${judgeFailures} judge call(s) returned unparseable scores (recorded as failures, never rescored silently).`);
  if (notes.length === 0) notes.push("No rank flips, no ≥2.0 scenario spreads, no baseline rubric wins over the winner — the judge was consistent.");
  lines.push(...notes.map((n) => `- ${n}`));
  lines.push("");

  // Recommendation
  lines.push("## Recommendation (STANDARD/DEEP mapping)");
  lines.push("");
  if (!input.live || winner === null) {
    lines.push("- Live run unavailable — no recommendation (hermetic smoke only).");
  } else {
    const close = runnerUp !== null && (winner.overallMean ?? 0) - (runnerUp.overallMean ?? 0) < 0.15;
    const synthWinner = [...eligible].sort(
      (a, b) => (b.perGroup.find((g) => g.group === "synthesis")?.mean ?? -1) - (a.perGroup.find((g) => g.group === "synthesis")?.mean ?? -1),
    )[0];
    lines.push(
      `- **STANDARD: \`${winner.model}\`** — top blind-judge mean (${fmt(winner.overallMean)} over ${winner.scored} scored scenarios)` +
        (close ? `; narrow over \`${runnerUp.model}\` (${fmt(runnerUp.overallMean)}) — owner spot-check before ratifying (R5)` : "") +
        `.`,
    );
    if (baseline !== null && (baseline.overallMean ?? 0) >= (winner.overallMean ?? 0)) {
      lines.push(`- The incumbent baseline \`gpt-4o-mini\` matched or beat every candidate (${fmt(baseline.overallMean)}) — keep it as STANDARD and re-evaluate in W8 rather than paying for a downgrade.`);
    } else if (synthWinner !== undefined && synthWinner.model !== winner.model) {
      lines.push(`- **DEEP: \`${synthWinner.model}\`** — leads the synthesis group (${fmt(synthWinner.perGroup.find((g) => g.group === "synthesis")?.mean ?? null)}); DEEP is synthesis-class turns under the per-day derived cap (W3 deepBudgetState).`);
    } else {
      lines.push(`- **DEEP: \`${winner.model}\`** — also leads the synthesis group (${fmt(winner.perGroup.find((g) => g.group === "synthesis")?.mean ?? null)}); DEEP stays envelope-capped (deepBudgetState, 0.5 × soft/30 per day).`);
    }
    lines.push(`- Wire via \`gateway.passes\` (\`answer_standard\` / \`answer_deep\`; DEEP falls back to STANDARD's resolution) — policy.yaml is the only place model ids live.`);
    lines.push("- Mandatory before ratification: owner-reviewed ≥20-turn sample (R5) + hermetic suite green.");
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<number> {
  // §5 Track A multi-candidate mode — delegates to the model-bakeoff
  // harness (hermetic dry run by default; live needs --live + key).
  if (process.argv.includes("--track-a")) {
    const { runTrackA } = await import("../model-bakeoff/track-a.js");
    return runTrackA(process.argv.slice(2));
  }

  loadDotEnv();
  const fixtures = loadAnswerFixtures(fixturesPath());

  // (a) Hermetic smoke — always, zero network.
  const structure = checkPromptStructure(fixtures);
  const pipeline = await hermeticPipelineSmoke(fixtures);
  const hermeticFailures = [...structure, ...pipeline];
  if (hermeticFailures.length > 0) {
    console.error(`answer-quality: HERMETIC SMOKE FAILED (${hermeticFailures.length}):`);
    for (const failure of hermeticFailures) console.error(`  ${failure.scenarioId}: ${failure.problem}`);
    return 1;
  }
  console.log(`answer-quality: hermetic smoke green — ${fixtures.scenarios.length} scenario prompts + fake-provider pipeline`);

  // (b) Live bake-off — graceful skip without a key.
  const apiKey = resolveApiKey();
  if (apiKey.trim().length === 0) {
    console.log("answer-quality live bake-off skipped: OPENROUTER_API_KEY is not set (env or launchctl)");
    writeArtifacts({ ranAt: new Date().toISOString(), fixtures, candidates: [], judge: DEFAULT_JUDGE, live: false, aborted: null, totalSpendUsd: 0, records: [] });
    return 0;
  }

  const candidates = (process.env.EVAL_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  const candidateList = candidates.length > 0 ? candidates : [...DEFAULT_CANDIDATES];
  const judge = process.env.EVAL_JUDGE?.trim() || DEFAULT_JUDGE;

  // Independent-family judging is structural (R5): refuse same-family judge.
  const families = new Set(candidateList.map(modelFamily));
  if (families.has(modelFamily(judge))) {
    console.error(`answer-quality: judge ${judge} shares a family with a candidate (${[...families].join(", ")}) — refusing self-family judging (R5)`);
    return 1;
  }

  await verifyModelIds(apiKey, BASE_URL, [...candidateList, judge]);

  const sleepMs =
    process.env.EVAL_SLEEP_MS !== undefined && process.env.EVAL_SLEEP_MS.length > 0
      ? Number(process.env.EVAL_SLEEP_MS)
      : DEFAULT_SLEEP_MS;
  const plannedCalls = fixtures.scenarios.length * candidateList.length * 2; // reply + judge
  let completedCalls = 0;
  let totalSpend = 0;
  let aborted: string | null = null;
  const records: ScoredReply[] = [];

  outer: for (const model of candidateList) {
    for (const scenario of fixtures.scenarios) {
      if (!projectedWithinCeiling({ spendUsd: totalSpend, completedCalls, plannedCalls, ceilingUsd: SPEND_CEILING_USD })) {
        aborted = `projected spend over the $${SPEND_CEILING_USD.toFixed(2)} ceiling after ${completedCalls} calls ($${totalSpend.toFixed(4)} actual)`;
        console.error(`spend ceiling projection hit — aborting remaining calls`);
        break outer;
      }
      if (completedCalls > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
      const prompt = buildScenarioPrompt(fixtures.principalName, model, scenario);
      const replyCall = await liveCallWithRetry(apiKey, BASE_URL, model, prompt, ANSWER_MAX_TOKENS);
      completedCalls += 1;
      if (!replyCall.ok) {
        records.push({ scenarioId: scenario.id, group: scenario.group, model, reply: "", scores: null, latencyMs: null, costUsd: null, promptTokens: null, completionTokens: null, error: `candidate: ${replyCall.error}` });
        console.error(`  ERROR ${model} ${scenario.id}: ${replyCall.error}`);
        continue;
      }
      totalSpend += replyCall.outcome.costUsd ?? 0;
      // Blind judge call (independent family, scenario + reply only).
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      const judgeCall = await liveCallWithRetry(apiKey, BASE_URL, judge, buildJudgePrompt(scenario, replyCall.outcome.text), JUDGE_MAX_TOKENS);
      completedCalls += 1;
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
      if (records.at(-1)?.scores === null) {
        console.error(`  JUDGE PARSE FAIL ${scenario.id} (${model})`);
      }
      process.stdout.write(".");
    }
    const summary = summarizeModel(model, records.filter((r) => r.model === model));
    console.log(
      `\n${model}: ${summary.scored}/${fixtures.scenarios.length} scored · overall ${summary.overallMean?.toFixed(2) ?? "n/a"} · avg ${summary.avgLatencyMs?.toFixed(0) ?? "?"}ms · $${summary.totalCostUsd.toFixed(4)}`,
    );
  }

  writeArtifacts({ ranAt: new Date().toISOString(), fixtures, candidates: candidateList, judge, live: true, aborted, totalSpendUsd: totalSpend, records });
  console.log(`\nTotal spend: $${totalSpend.toFixed(4)} (ceiling $${SPEND_CEILING_USD.toFixed(2)}) · ${completedCalls} live calls`);
  return 0;
}

function writeArtifacts(input: {
  readonly ranAt: string;
  readonly fixtures: AnswerFixtures;
  readonly candidates: readonly string[];
  readonly judge: string;
  readonly live: boolean;
  readonly aborted: string | null;
  readonly totalSpendUsd: number;
  readonly records: readonly ScoredReply[];
}): void {
  const rawDir = path.resolve(HERE, "../../docs/evals");
  mkdirSync(rawDir, { recursive: true });
  const raw = {
    ranAt: input.ranAt,
    fixturesVersion: input.fixtures.version,
    promptVersion: "imessage-converse-v2 (buildAnswerPrompt)",
    judge: input.judge,
    blind: true,
    spendCeilingUsd: SPEND_CEILING_USD,
    aborted: input.aborted,
    totalSpendUsd: input.totalSpendUsd,
    models: Object.fromEntries(
      input.candidates.map((model) => [model, input.records.filter((r) => r.model === model)]),
    ),
  };
  writeFileSync(path.join(rawDir, "answer-quality-2026-09.raw.json"), `${JSON.stringify(raw, null, 2)}\n`);
  writeFileSync(
    path.join(rawDir, "answer-quality-2026-09.md"),
    markdownReport({ ...input, candidates: input.candidates.length > 0 ? input.candidates : [] }),
  );
  console.log(`Report: docs/evals/answer-quality-2026-09.md (+ .raw.json)`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("answer-quality eval crashed:", error instanceof Error ? `${error.name}: ${error.message}` : error);
      process.exitCode = 1;
    },
  );
}
