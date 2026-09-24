# §5 model bake-off tooling (docs/plans/intelligence-reset.md §5)

Track A multi-candidate runner, route/interpret capability probe (D-2), and
the owner-scored pairwise preference harness (D-1 / §16 USER PREFERENCE).
All three are HERMETIC by default (fake provider, zero network — validates
plumbing: prompt building, dispatch, strict parsing, aggregation, schema
writers, blind shuffling). Live calls require BOTH `--live` and
`OPENROUTER_API_KEY` (env or `launchctl getenv`, repo `.env` honored).

Artifacts land in `evals/model-bakeoff/out/` (gitignored). Nothing here
touches `policy.yaml` or any workspace package — model ids are eval-harness
inputs only.

## Track A — multi-candidate answer-only

```bash
tsx evals/answer-quality/run.ts --track-a [--candidates id,id] [--smoke] [--live] [--judge id]
```

- Candidates default to the plan §5 six (gpt-4o-mini, gpt-4.1-mini,
  claude-sonnet-4.5, gpt-4.1, claude-opus-4.6, gemini-3.8-flash);
  `--candidates` / `EVAL_MODELS` overrides.
- Same fixed inputs per candidate via the W3 harness (REAL
  `buildAnswerPrompt`, `imessage-converse-v2`); blind judge unchanged
  (`google/gemini-2.5-flash`, scenario + reply only).
- $4 hard split, smoke-gated: a 2-scenario × all-candidate smoke measures
  per-answer means; the full run refuses to start if the projection
  (scenario count × measured means × candidates + judge share) exceeds $4.
  An in-run linear guard aborts before any breaching call. `--smoke` runs
  ONLY the smoke and reports the projection + gate decision (exit 0).
- Raw schema EXTENDS `docs/evals/answer-quality-2026-09.raw.json`'s shape
  (`ranAt / fixturesVersion / promptVersion / judge / blind /
  spendCeilingUsd / aborted / totalSpendUsd / models{}`) with `track`,
  `mode`, `live`, `dryRunReason`, `smoke`, and `candidates[]` — per
  candidate: per-scenario five-dim scores, mean, per-rubric means, total
  cost, p50/p95 latency.
- ⚠ **Judge-family conflict is live-blocked by design**: candidate #6
  (`google/gemini-3.8-flash`) shares a family with the unchanged judge
  (`google/gemini-2.5-flash`). The live run refuses (R5 independent-family
  rule, same as the W3 runner) until `--judge` names a model from a family
  outside every candidate family (openai/anthropic/google). Hermetic runs
  are unaffected. This is a plan-level conflict to resolve before Track A
  goes live — see "Blockers" in the handoff.

## Capability probe — D-2 (route + interpret strict-parser validity)

```bash
tsx evals/model-bakeoff/probe.ts [--candidates id,id] [--smoke] [--live]
```

- 36 labeled turns (`probe-fixtures.json`) derived from
  `evals/conversation` scenarios, the golden transcript, the
  `model-routing` adversarial X-cases, and the §6 incident classes
  (chitchat / lookups / read-sets / actions / referents / task lists /
  preferences / delegations / feedback / memory / adversarial).
- REAL prompts: `buildRoutingPrompt(text, { extendedTools: true, contextHeader })`
  (the gateway.context-enabled production shape) and
  `buildInterpretationPrompt(text, { recentExchanges })` (C9 target wiring).
- Metrics per candidate: route parse-validity (the exact four-way check
  `conversation.ts` applies: `parseRouteJson` / `parseRouteReadSet` /
  `parseActionRouteJson` / `isRouteNoneJson`), interpret parse-validity
  (`parseInterpretationJson`), **combinedValidPct** (both outputs parse on
  the same turn — the D-2 ≥96% bar), agreement with the authored reference
  labeling (tool/read-set/action shape + proposal type set), latency, cost.
- $1 hard split with the same 2-turn smoke projection gate.
- Hermetic mode scripts model outputs FROM the reference labels — which
  also proves every reference serializes + parses under the REAL strict
  parsers (pinned in tests).

## Pairwise preference — owner-scored, blind, no LLM judge

```bash
tsx evals/model-bakeoff/pairwise.ts --a <id> --b <id> [--filter all|multiturn] [--live] [--seed n]
```

- Renders both candidates' replies from IDENTICAL context over the
  answer-quality fixtures (all 24 scenarios by default — ≥20 pairs per the
  §16/D-1 protocol; `--filter multiturn` narrows to 5 and warns it is
  below protocol).
- Deterministic seeded blind shuffle; positions recorded only in the
  separate `.key.json`. Score the sheet FIRST, then open the key.
- `pairwiseTally(verdicts)` encodes the protocol math: ≥20 pairs, ≥60% win
  rate (ties are non-wins; decisive-only rate reported as diagnostic).
- Hermetic replies carry opaque per-model tags so tests can verify slot
  placement without breaking sheet blindness.
- Live render is 2 × scenarios answer calls under a $1 ceiling (the $1
  reserve split). Note: an opus-involving pair at the $0.10/answer planning
  rate projects ≈$2.4 and will abort under the $1 ceiling — the intended
  live use is the Track-B D-1 pairwise (whole-turn replies already paid for
  by Track B); raise the ceiling deliberately if rendering an opus pair
  from these fixtures is wanted.

## Tests

`pnpm vitest run evals/answer-quality evals/model-bakeoff` — hermetic
(gating math, schema writers, reference round-trips, X03-class scoring
semantics, shuffle determinism + blindness, protocol math, full fake-
provider runs).
