/**
 * §5/§16 pairwise preference harness (owner-scored, no LLM judge).
 *
 * Takes two candidate ids + the golden conversation prompts (the
 * answer-quality fixtures — all 24 by default, ≥20 pairs per the §16 USER
 * PREFERENCE / D-1 protocol; `--filter multiturn` narrows to the 5
 * multiturn scenarios and warns it is below protocol). Both candidates'
 * replies are rendered from IDENTICAL context (same prompt built by
 * buildScenarioPrompt — the W3 harness's fixed-inputs guarantee),
 * blind-shuffled deterministically (seeded; reproducible; positions
 * recorded only in the separate key file), and emitted as a markdown
 * review sheet the owner scores offline.
 *
 * Protocol (plan §5 D-1 / §16): ≥20 blind pairs; a model "wins owner
 * pairwise preference" at ≥60% of scored pairs. `pairwiseTally` encodes
 * the math (ties count as non-wins; decisive-only rate reported too).
 *
 * Modes: HERMETIC by default (fake provider, opaque per-model reply tags —
 * validates plumbing + blindness without any network); LIVE via `--live` +
 * OPENROUTER_API_KEY (2 × scenarios answer calls, $1 ceiling with in-run
 * projection guard).
 *
 * CLI: tsx evals/model-bakeoff/pairwise.ts --a <id> --b <id>
 *      [--filter all|multiturn] [--live] [--seed n]
 * Outputs: evals/model-bakeoff/out/pairwise-<a>-vs-<b>.md (+ .key.json)
 */

import {
  ANSWER_MAX_TOKENS,
  buildScenarioPrompt,
  fixturesPath,
  liveCallWithRetry,
  loadAnswerFixtures,
  projectedWithinCeiling,
  verifyModelIds,
} from "../answer-quality/runner.js";
import { PAIRWISE_CEILING_USD } from "./gating.js";
import {
  BASE_URL,
  DEFAULT_SLEEP_MS,
  liveGate,
  parseArgv,
  prng,
  resolveApiKey,
  seedOf,
  sleepMs,
  writeArtifact,
  loadDotEnv,
} from "./shared.js";
import type { ModelRequest, ModelResult } from "@jehad/adapters";
import { FakeModelProvider } from "@jehad/adapters";
import { writeFileSync } from "node:fs";
import path from "node:path";

export const MIN_PAIRS = 20;
export const WIN_RATE_BAR = 0.6;

// ----------------------------------------------------------- blind shuffle

export interface SlotAssignment {
  readonly A: string;
  readonly B: string;
}

/**
 * Deterministic blind shuffle: for each scenario, a PRNG seeded by
 * (a, b, scenarioId, seed) decides which candidate renders as "A".
 * Reproducible for a given seed; recorded only in the key file.
 */
export function shuffleAssignments(
  scenarioIds: readonly string[],
  a: string,
  b: string,
  seed: number,
): Map<string, SlotAssignment> {
  const assignments = new Map<string, SlotAssignment>();
  // The pair seed is order-insensitive (sorted): b-vs-a mirrors a-vs-b.
  const pairSeed = seedOf(...[a, b].sort(), String(seed));
  for (const id of scenarioIds) {
    const draw = prng(seedOf(String(pairSeed), id))();
    assignments.set(id, draw < 0.5 ? { A: a, B: b } : { A: b, B: a });
  }
  return assignments;
}

// ---------------------------------------------------------------- tally

export type PairVerdict = "A" | "B" | "tie";

export interface PairwiseTally {
  readonly pairs: number;
  readonly meetsPairMinimum: boolean;
  readonly aWins: number;
  readonly bWins: number;
  readonly ties: number;
  readonly decisive: number;
  readonly aWinRate: number;
  readonly bWinRate: number;
  readonly aWinRateDecisive: number | null;
  readonly bWinRateDecisive: number | null;
  /** "A" | "B" when the ≥60%-of-≥20 bar clears, else null. */
  readonly winner: PairVerdict | null;
}

/** The D-1/§16 protocol math: ≥20 pairs, ≥60% win rate (ties are
 *  non-wins); the decisive-only rate is reported as a diagnostic. Pure. */
export function pairwiseTally(verdicts: readonly PairVerdict[]): PairwiseTally {
  const pairs = verdicts.length;
  const aWins = verdicts.filter((v) => v === "A").length;
  const bWins = verdicts.filter((v) => v === "B").length;
  const ties = verdicts.filter((v) => v === "tie").length;
  const decisive = aWins + bWins;
  const aWinRate = pairs === 0 ? 0 : aWins / pairs;
  const bWinRate = pairs === 0 ? 0 : bWins / pairs;
  const meetsPairMinimum = pairs >= MIN_PAIRS;
  let winner: PairVerdict | null = null;
  if (meetsPairMinimum && aWinRate >= WIN_RATE_BAR) winner = "A";
  if (meetsPairMinimum && bWinRate >= WIN_RATE_BAR) winner = winner === null ? "B" : null;
  return {
    pairs,
    meetsPairMinimum,
    aWins,
    bWins,
    ties,
    decisive,
    aWinRate,
    bWinRate,
    aWinRateDecisive: decisive === 0 ? null : aWins / decisive,
    bWinRateDecisive: decisive === 0 ? null : bWins / decisive,
    winner,
  };
}

// ------------------------------------------------------------- dispatch

interface DispatchOutcome {
  readonly text: string;
  readonly latencyMs: number;
  readonly costUsd: number | null;
}

type Dispatcher = (
  model: string,
  prompt: string,
) => Promise<{ ok: true; outcome: DispatchOutcome } | { ok: false; error: string }>;

/** Opaque per-model tag for hermetic replies — the sheet must never carry
 *  a model name; tests verify slot placement via the tag + key file. */
export function opaqueTag(model: string): string {
  return seedOf(model).toString(36).slice(0, 6);
}

function hermeticDispatcher(): Dispatcher {
  const provider = new FakeModelProvider({
    respond: (request: ModelRequest): ModelResult => ({ text: `hermetic reply [tag ${opaqueTag(request.model)}]` }),
  });
  return async (model, prompt) => {
    const started = Date.now();
    const result = await provider.complete({
      domainId: "personal",
      sensitivity: "normal",
      provider: "fake",
      model,
      prompt,
      runId: "pairwise-hermetic",
    });
    return { ok: true, outcome: { text: result.text, latencyMs: Date.now() - started, costUsd: null } };
  };
}

// ----------------------------------------------------------- sheet render

export interface PairwisePair {
  readonly scenarioId: string;
  readonly group: string;
  readonly question: string;
  readonly priorTurns: readonly { direction: string; content: string }[];
  readonly results: readonly { tool: string; coverage: string; data: unknown }[];
  readonly replyA: string;
  readonly replyB: string;
  readonly errorA?: string;
  readonly errorB?: string;
}

/** Pure markdown render — model names NEVER appear (blind). */
export function renderPairwiseSheet(input: {
  readonly generatedAt: string;
  readonly filter: string;
  readonly pairs: readonly PairwisePair[];
}): string {
  const { pairs } = input;
  const lines: string[] = [];
  lines.push("# Pairwise preference review sheet (owner-scored, blind)");
  lines.push("");
  lines.push(`Generated ${input.generatedAt} · filter: ${input.filter} · ${pairs.length} pairs.`);
  lines.push("");
  lines.push("Protocol (plan §5 D-1 / §16 USER PREFERENCE): score every pair A / B / tie — no abstentions on ≥20 pairs.");
  lines.push("A model wins owner pairwise preference at ≥60% of scored pairs (ties count as non-wins).");
  lines.push("The two arms are the same assistant with identical context, persona, data, and prompt version; only the reply source differs.");
  lines.push("Which arm is which per pair is in the separate .key.json — do not open it until the sheet is scored.");
  lines.push("");
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i]!;
    lines.push(`## Pair ${i + 1} — ${pair.scenarioId} (${pair.group})`);
    lines.push("");
    lines.push(`**User:** ${pair.question}`);
    for (const turn of pair.priorTurns) {
      lines.push(`> ${turn.direction === "inbound" ? "User" : "Assistant"}: ${turn.content}`);
    }
    if (pair.results.length > 0) {
      lines.push("");
      lines.push("Context DATA the assistant had:");
      for (const result of pair.results) {
        lines.push(`- [tool: ${result.tool}] ${JSON.stringify(result.data).slice(0, 400)}`);
      }
    }
    lines.push("");
    lines.push("**Reply A:**");
    lines.push("");
    lines.push(pair.errorA === undefined ? pair.replyA : `_(render error: ${pair.errorA})_`);
    lines.push("");
    lines.push("**Reply B:**");
    lines.push("");
    lines.push(pair.errorB === undefined ? pair.replyB : `_(render error: ${pair.errorB})_`);
    lines.push("");
    lines.push("- verdict: [ ] A better  [ ] B better  [ ] tie");
    lines.push("");
  }
  lines.push("## After scoring");
  lines.push("");
  lines.push(
    "Transpose verdicts (one `A`/`B`/`tie` per pair, in order) into the tally helper: `pairwiseTally` in evals/model-bakeoff/pairwise.ts (or the key file's companion). " +
      `Minimum ${MIN_PAIRS} pairs; the bar is ≥${WIN_RATE_BAR * 100}% win rate for a D-1 pairwise win.`,
  );
  lines.push("");
  return lines.join("\n");
}

// ------------------------------------------------------------------ CLI

export async function runPairwise(argv: readonly string[]): Promise<number> {
  loadDotEnv();
  const args = parseArgv(argv);
  const a = args.options.get("a")?.trim() ?? "";
  const b = args.options.get("b")?.trim() ?? "";
  if (a.length === 0 || b.length === 0 || a === b) {
    console.error("pairwise: requires --a <model-id> and --b <model-id> (two distinct candidates)");
    return 1;
  }
  const filter = args.options.get("filter")?.trim() || "all";
  if (filter !== "all" && filter !== "multiturn") {
    console.error(`pairwise: unknown --filter '${filter}' (all | multiturn)`);
    return 1;
  }
  const seed = Number(args.options.get("seed") ?? "20260924");
  const fixtures = loadAnswerFixtures(fixturesPath());
  const scenarios = fixtures.scenarios.filter((s) => (filter === "all" ? true : s.group === "multiturn"));
  if (scenarios.length === 0) {
    console.error("pairwise: no scenarios matched the filter");
    return 1;
  }
  const apiKey = resolveApiKey();
  const gate = liveGate(args, apiKey);
  const pacing = sleepMs(DEFAULT_SLEEP_MS);

  console.log(
    `pairwise: ${scenarios.length} pairs · ${a} vs ${b} · ${gate.live ? "LIVE" : `hermetic dry run (${gate.reason})`} · seed ${seed}`,
  );
  if (scenarios.length < MIN_PAIRS) {
    console.error(
      `pairwise: ⚠ only ${scenarios.length} pairs — below the §16/D-1 minimum of ${MIN_PAIRS}; the pairwise disjunct is unscored on this sample`,
    );
  }

  let dispatchCalls = 0;
  let totalSpend = 0;
  const dispatch = gate.live
    ? async (model: string, prompt: string) => {
        if (dispatchCalls > 0) await new Promise((resolve) => setTimeout(resolve, pacing));
        if (
          !projectedWithinCeiling({
            spendUsd: totalSpend,
            completedCalls: dispatchCalls,
            plannedCalls: scenarios.length * 2,
            ceilingUsd: PAIRWISE_CEILING_USD,
          })
        ) {
          return { ok: false as const, error: `projected spend over the $${PAIRWISE_CEILING_USD.toFixed(2)} ceiling — remaining pairs aborted` };
        }
        const call = await liveCallWithRetry(apiKey, BASE_URL, model, prompt, ANSWER_MAX_TOKENS);
        dispatchCalls += 1;
        totalSpend += call.ok ? (call.outcome.costUsd ?? 0) : 0;
        return call.ok ? { ok: true as const, outcome: call.outcome } : { ok: false as const, error: call.error };
      }
    : hermeticDispatcher();
  const replies = new Map<string, { ok: true; text: string } | { ok: false; error: string }>();
  if (gate.live) {
    await verifyModelIds(apiKey, BASE_URL, [a, b]);
  }
  for (const model of [a, b]) {
    for (const scenario of scenarios) {
      const prompt = buildScenarioPrompt(fixtures.principalName, model, scenario);
      const call = await dispatch(model, prompt);
      replies.set(`${model}:${scenario.id}`, call.ok ? { ok: true, text: call.outcome.text } : { ok: false, error: call.error });
      process.stdout.write(".");
    }
  }

  const assignments = shuffleAssignments(
    scenarios.map((s) => s.id),
    a,
    b,
    seed,
  );
  const pairs: PairwisePair[] = scenarios.map((scenario) => {
    const assignment = assignments.get(scenario.id)!;
    const replyA = replies.get(`${assignment.A}:${scenario.id}`)!;
    const replyB = replies.get(`${assignment.B}:${scenario.id}`)!;
    return {
      scenarioId: scenario.id,
      group: scenario.group,
      question: scenario.question,
      priorTurns: scenario.priorTurns ?? [],
      results: scenario.results,
      replyA: replyA.ok ? replyA.text : "",
      replyB: replyB.ok ? replyB.text : "",
      errorA: replyA.ok ? undefined : replyA.error,
      errorB: replyB.ok ? undefined : replyB.error,
    };
  });

  const sheet = renderPairwiseSheet({ generatedAt: new Date().toISOString(), filter, pairs });
  const safe = (id: string): string => id.replace(/[^a-zA-Z0-9.-]+/g, "-");
  const base = `pairwise-${safe(a)}-vs-${safe(b)}`;
  const sheetPath = writeArtifact(`${base}.md`, sheet);
  const key = {
    generatedAt: new Date().toISOString(),
    a,
    b,
    seed,
    filter,
    live: gate.live,
    totalSpendUsd: totalSpend,
    minPairs: MIN_PAIRS,
    winRateBar: WIN_RATE_BAR,
    assignments: Object.fromEntries([...assignments]),
  };
  const keyPath = writeArtifact(`${base}.key.json`, JSON.stringify(key, null, 2));
  const statsPath = path.join(path.dirname(sheetPath), `${base}.stats.json`);
  writeFileSync(statsPath, `${JSON.stringify({ totalSpendUsd: totalSpend, pairs: pairs.length }, null, 2)}\n`);
  console.log(`\nSheet: ${path.relative(process.cwd(), sheetPath)} (blind — score before opening the key)`);
  console.log(`Key:   ${path.relative(process.cwd(), keyPath)}`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  runPairwise(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("pairwise eval crashed:", error instanceof Error ? `${error.name}: ${error.message}` : error);
      process.exitCode = 1;
    },
  );
}
