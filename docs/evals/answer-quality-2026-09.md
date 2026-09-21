# Answer-quality bake-off — W3 STANDARD/DEEP tiers (2026-09)

Ran 2026-09-21T18:47:25.497Z. Live.

24 scenarios (synthesis, multiturn, explainwhy, plainchat) through the REAL gateway answer prompt (`buildAnswerPrompt`, `imessage-converse-v2`) with synthetic DATA blocks shaped exactly like `executeReadTool` output. Harness: `evals/answer-quality/run.ts` (`pnpm eval:answers`), fixtures `evals/answer-quality/fixtures.json`, raw per-reply outputs + judge scores: `answer-quality-2026-09.raw.json`.

- **Blind independent-family judging (R5)**: judge `google/gemini-2.5-flash` (family `google`) sees scenario + reply only — never a candidate model name — and scores each reply 1-5 on: groundedness, prioritization, honesty, concision, referents.
- Candidates: `openai/gpt-4.1`, `anthropic/claude-sonnet-4.5`, `openai/gpt-4o-mini` (the last is the incumbent baseline).
- Temperature 0, max_tokens 800 (answers) / 400 (judge). Sequential, 150ms pacing, one retry (rate-limits back off 30s).
- Spend ceiling $3.00 (actual + linear projection — the run aborts before the call that would breach it). **Total spend: $0.1383.**

## Per-model mean scores (1-5, blind judge)

| model | overall | groundedness | prioritization | honesty | concision | referents | scored | avg ms | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openai/gpt-4.1 | 4.69 | 4.67 | 4.71 | 4.58 | 4.50 | 5.00 | 24/24 | 1687 | $0.0358 |
| anthropic/claude-sonnet-4.5 | 4.78 | 4.83 | 4.96 | 4.83 | 4.29 | 5.00 | 24/24 | 3791 | $0.0754 |
| openai/gpt-4o-mini | 4.59 | 4.67 | 4.58 | 4.58 | 4.38 | 4.75 | 24/24 | 1920 | $0.0025 |

## Per-group means

| model | synthesis | multiturn | explainwhy | plainchat |
| --- | --- | --- | --- | --- |
| openai/gpt-4.1 | 4.75 | 4.80 | 4.84 | 4.40 |
| anthropic/claude-sonnet-4.5 | 4.85 | 4.84 | 4.72 | 4.70 |
| openai/gpt-4o-mini | 4.72 | 4.12 | 4.72 | 4.70 |

## Judge discordance notes

- **Rank flip on concision**: `openai/gpt-4.1` leads (4.50) while `anthropic/claude-sonnet-4.5` leads overall — the overall winner is not uniformly best.
- **Rank flip on referents**: `openai/gpt-4.1` leads (5.00) while `anthropic/claude-sonnet-4.5` leads overall — the overall winner is not uniformly best.
- Incumbent baseline `gpt-4o-mini` still beats the winner on **concision** (4.38 vs 4.29).
- **High-spread scenarios** (≥2.0 between best and worst candidate): M02 (Δ 2.8: openai/gpt-4.1 5.0 vs openai/gpt-4o-mini 2.2), C04 (Δ 2.0: anthropic/claude-sonnet-4.5 5.0 vs openai/gpt-4.1 3.0).

### Post-run spot-check (builder annotation)

- **M02 judge noise**: all three candidates resolved "the earlier one" to the 11 AM slot;
  gpt-4.1 and sonnet scored 5/5 while gpt-4o-mini scored 1/1 for the *same resolution*
  (judge note misread the prior turn). The 2.8 spread on M02 is substantially judge
  inconsistency, not model difference — treat the baseline's multiturn mean (4.12) as
  an upper bound on the gap, and note the baseline's genuine weakness is elsewhere
  (it never caveats scheduling agency the way sonnet does). This is exactly why R5
  requires the owner spot-check before ratification and why hermetic tests, not LLM
  judges, remain the hard gate.
- Sonnet's concision loss is real but small (verbose hedges, e.g. M02's "I can't
  actually schedule anything" preface — honest, but longer than iMessage-ideal).

## Recommendation (STANDARD/DEEP mapping)

- **STANDARD: `anthropic/claude-sonnet-4.5`** — top blind-judge mean (4.78 over 24 scored scenarios); narrow over `openai/gpt-4.1` (4.69) — owner spot-check before ratifying (R5).
- **DEEP: `anthropic/claude-sonnet-4.5`** — also leads the synthesis group (4.85); DEEP stays envelope-capped (deepBudgetState, 0.5 × soft/30 per day).
- Wire via `gateway.passes` (`answer_standard` / `answer_deep`; DEEP falls back to STANDARD's resolution) — policy.yaml is the only place model ids live.
- Mandatory before ratification: owner-reviewed ≥20-turn sample (R5) + hermetic suite green.
