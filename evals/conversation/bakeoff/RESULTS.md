# Model bake-off — 2026-09-27 (partial: blocked on account credits)

Directive: 3 dev runs each for gpt-5.6-luna / gpt-5.6-terra / gpt-5.6-sol /
gemini-3.8-flash / claude-sonnet-5; gpt-6-astra ×1 diagnostic ceiling.
Prompt/architecture/config frozen (only the route model pin swapped per
candidate; the truth judge pinned to gpt-4.1 across all runs via
JUDGE_MODEL for comparability). Holdout untouched.

## Results

| candidate | runs | common-control | case pass | envelope | avg latency | $/run | trust zeros |
|---|---|---|---|---|---|---|---|
| gpt-4.1 (incumbent, dev16 baseline) | 1 | 76.0% | 76.7% | 93% | 3.9s | 1.30 | held |
| gpt-5.6-luna | 2 credible + 1 credit-degraded | **76.0% / 68.0%** | 81.7% / 76.7% | 98% / 90% | 6.6–6.9s | 0.54–0.68 | held (unauth=0, phantom=0) |
| gpt-5.6-terra | 3 | **INFEASIBLE** — provider rejects every request: default max_tokens 65536 exceeds the account's per-request credit authorization ("can only afford 52725") | | | ~20s (all fail-closed notices) | ~0.01 | n/a |
| gpt-5.6-sol | 3 | **INFEASIBLE** — same credits gate (65536 vs 30996 affordable) | | | ~20s | ~0.01 | n/a |
| gemini-3.8-flash | 1 partial + 2 blocked | 52.0% (partial; 38% envelope, 20s latency — provider-throttled) then hard credits block | | | 20s | 0.45 | n/a |
| claude-sonnet-5 | 0 | **NOT RUN** — credits exhausted first | | | | | |
| gpt-6-astra | 0 | **NOT RUN** — credits exhausted first | | | | | |

Account at stop: **$0.24 of $25 remaining** (openrouter /api/v1/credits).

## Findings

1. **The matrix is blocked on OpenRouter credits, not on models.** Terra
   and Sol cannot be AUTHORIZED under the frozen architecture: the adapter
   sends no max_tokens, these models default to 65536 output tokens, and
   OpenRouter's pre-flight affordability check rejects the request against
   the remaining balance. Working around it needs either a credit top-up
   or an adapter max_tokens cap (architecture change — frozen).
2. **Luna is credible but not a step change.** Over its two clean runs:
   common-control 76%/68% vs the incumbent's 76% — within noise, no better
   on the tail classes (its false-acks are the same parked-batch/offer
   phrasing family), ~1.7× slower, ~2× cheaper per run, envelope validity
   90–98%. Trust zeros hold.
3. **Gemini-3.8-flash is disqualified for the envelope role** even on its
   partial run: 38% envelope validity, 20s turns (provider throttling).
4. Luna run 3's collapse (13 notices) is credit contamination — the
   verifier leg (gpt-4.1 via the same balance) started failing; flagged,
   excluded from the candidate's numbers.
5. **Production exposure**: at $0.24 the live shell has at most dozens of
   turns left before every turn fails closed to availability notices
   (safe, but Jin goes deaf).

## To finish the matrix

Top up OpenRouter (~$20 covers: sonnet-5 ×3, astra ×1, and credible
terra/sol ×3 each — the gate authorizes per-request max cost, so a healthy
balance clears the 65536 default), then re-run:
`evals/conversation/bakeoff/run-one.sh <cand> <n>` for the remaining cells.
