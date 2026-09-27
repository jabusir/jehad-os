# Model bake-off — FINAL (2026-09-27, credits restored mid-matrix)

Directive: 3 dev runs each for the five production candidates, gpt-6-astra
×1 as diagnostic ceiling. Prompt/architecture/config frozen throughout
(route model pin swapped per candidate; truth judge pinned to gpt-4.1 via
JUDGE_MODEL for cross-candidate comparability). Holdout untouched. Hard
trust classes (unauthorized mutation, phantom work) held at **zero for
every candidate in every run**.

## Ranking (common-control semantic success, then latency/cost)

| rank | candidate | cc% (3 runs) | case% | envelope | latency | $/run | false-acks |
|---|---|---|---|---|---|---|---|
| diag | **gpt-6-astra** (ceiling, 1 run) | **88.0** | 78.3 | 88% | 10.6s | 4.64 | 2 |
| 1 | **gpt-5.6-sol** | **81.3** (80/88/76) | 83.3 | 98% | 7.6s | 1.62 | 8 |
| 1 | **claude-sonnet-5** | **81.3** (80/84/80) | 78.3 | 94% | 10.8s | 1.83 | 15 |
| 3 | gpt-4.1 (incumbent) | 76.0 | 76.7 | 93% | **3.9s** | 1.30 | 4 |
| 4 | gpt-5.6-luna | 74.7 (76/68/80) | 80.6 | 94% | 6.7s | **0.66** | 12 |
| 5 | gpt-5.6-terra | 72.0 (68/76/72) | 75.6 | 88% | 6.2s | 1.57 | 9 |

(terra runs 1–3 / sol runs 1–3 / gemini runs 2–3 / luna run 3 from the
credit-blocked phase are excluded — authorization-gate artifacts, not
semantic results. gemini-3.8-flash stays disqualified: 38% envelope on its
one unblocked-tail run.)

## Read

1. **Sol and Sonnet-5 tie at 81.3% cc**, ~5pp above the incumbent. Sol
   wins the tiebreak: faster (7.6s vs 10.8s), cleaner envelopes (98% vs
   94%), half the false-acks (8 vs 15 — sonnet-5 hits the parked-batch
   phrasing class hardest). gpt-4.1 remains 2× faster than everything.
2. **The frontier ceiling is 88%** — and astra's failures are the SAME
   systematic classes as everyone's: task-capture, offer-apply,
   gmail-read-chain fail ~2/6 per run for every candidate INCLUDING the
   incumbent and the ceiling model. These are system/corpus-side, not
   model-choice-side:
   - task-capture: the NEW models' op-envelope dialect trips the strict
     op parser (invalid envelope → degrade → honest "technical issue"
     reply; gpt-4.1's dialect parses clean) — a parser-tolerance question
     (operations.ts, code — not prompt).
   - offer-apply: the seeded pending-offer → resolution flow (runner/
     system mechanics, needs ledger-level diagnosis).
   - gmail-read-chain: a corpus artifact — the model's chosen keywords
     ("plumber invoice") genuinely don't match the seeded sender/subject
     ("plumbco"/"Invoice #4417"), so the search honestly returns zero.
3. No model reaches 98% under the current suite state; the suite itself
   bounds everyone at ~88%. Fixing the three systematic classes first
   would give the model comparison (and holdout v2) a clean baseline.

## Artifacts

`evals/conversation/out/semantic-bo-*.json` (16 runs). Re-run any cell:
`evals/conversation/bakeoff/run-one.sh <cand> <n>`.
