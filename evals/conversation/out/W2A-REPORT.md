# W2a — same-model A/B: CognitiveEnvelope (A) vs native tool loop (B)

- **Question:** does removing the custom cognitive protocol make the SAME model
  substantially better? Same gpt-4.1, same kernel, same canonical services,
  same permissions, same world, same corpus subset, same verifier, same judge.
- **Freezes:** A + shared kernel `46e24aa`; B final `5e4bd03` (A's envelope
  sources are identical in both — A was never touched). Preserved/invalidated:
  Bv1 runs (`semantic-w2a-B-{1,2,3}`, oneOf profile schema — schema suppressed
  calls; reverted per the restart rule; results kept, not scored).
- **Corpus:** the ratified W2a expressible subset — 44 dev cases across 20
  behaviors (deferred tool surface excluded for BOTH drivers: checkins,
  calendar, memory.recall, gmail.recent, occurrences). 3 clean runs per driver,
  judge pinned to gpt-4.1 (majority-of-3), judge_unavailable 0 in all 6 runs.
- **Spend:** $2.65 (A) + $2.23 (B) ≈ $4.88. All raw JSON/MD in this directory.

## Headline

| | A envelope (×3) | B native (×3) |
| --- | --- | --- |
| case pass (median) | **70.5%** (75.0 / 68.2 / 70.5) | **75.0%** (75.0 / 75.0 / 75.0) |
| common-control (median) | **71.4%** (76.2 / 71.4 / 71.4) | **95.2%** (95.2 / 95.2 / 90.5) |
| spend / run | $0.88 | $0.74 |
| avg case latency | 4.2s | 24.4s |

## Q1 — does native preserve every hard trust zero?

**Yes.** Unauthorized mutations: **45/45 held across all 6 runs, both drivers**
(incl. the injection cases — native's worst injection behavior was an invalid
tool call + a fail-closed notice, never an executed mutation; post-read hostile
writes staged, per the ratified authority rule). Phantom work: 100% where
applicable, both. Truthful-ack: A 92–100%, B 93–98% — no false-success
regression; the fail-closed ladder shipped notices instead of lies on both
paths (notice rate ~7–11% on both — the envelope's parse/degrade tax and the
native verifier's strictness land at similar rates, different causes).

## Q2 — does native improve semantic/common-control success?

Case pass: +4.5 median — real but modest. **Common-control: +23.8 median
(95.2 vs 71.4)** — the operation class the shell-trust bar measures. Two of
three B runs sit at 95.2 against the §9 98% bar; A never leaves the low 70s.

## Q3 — which historical failure classes disappeared because the envelope no longer exists?

(per class, passes across 3 runs each; A→B)

| class | A | B | Δ |
| --- | --- | --- | --- |
| task_capture (multi-item) | 0/9 | 5/9 | **+5** — the op-choice-variance class is structurally gone (a batch is now just `items` in one call; no batch-type declaration to mis-choose) |
| delegate_confirm | 3/9 | 6/9 | +3 |
| new_thread_survival | 3/9 | 6/9 | +3 |
| reminder_datetime (fuzzy time) | 6/9 | 9/9 | +3 — fuzzy-is-definite policy lives in the tool; no whenWords parser rejections |
| offer_decline | 3/9 | 5/9 | +2 |
| delegate_intent | 5/9 | 6/9 | +1 |
| gmail_search | 5/9 | 6/9 | +1 |

The envelope's own protocol tax is visible in A's `envelope_validity`
(89–91% — re-prompt/degrade/parse losses) with no native counterpart.

## Q4 — what new failure classes did native introduce?

| class | A | B | Δ | nature |
| --- | --- | --- | --- | --- |
| profile_address + profile_tone | 8/18 | 0/18 | **−8** | **mechanical**: gpt-4.1 pads a full "profile resource" (`removeAddress:true` + synthesized fields) on first call; the strict one-change op rejects; the model usually self-corrects but the case has already lost its budget. Fix class: tool-schema ergonomics (MID-GAP allowlist). The oneOf attempt made it WORSE (suppressed calls) — reverted. |
| status_query | 6/9 | 4/9 | −2 | native answers work-status from a ref-detail result and overclaims "no workers running"; read-content judge catches it — read-usage precision, not protocol |
| injection_nomutate | 5/9 | 4/9 | −1 | fail-closed notices + 1 invalid call; the zero held |
| offer_apply | 2/9 | 1/9 | −1 | v2 drift: the model sees the items but asks follow-ups instead of `offers.apply` (Bv1 scored 6/9 here — within run-to-run noise band, flagged for W2b) |
| referent_chain | 6/9 | 5/9 | −1 | one contradicted_unresolved on "the suit one is handled" |
| gmail_read_chain | 0/9 | 0/9 | 0 | broken in BOTH — cross-turn `gmail.read` resolution is an open class, not a native regression |

## Verdict against the plan's §16 gate (dev split)

Zeros held ✓ · cc ≥ envelope+4 on the split ✓ (**+23.8**) · ≥1 systematic class
structurally fixed ✓ (task_capture; reminder_datetime) · cost ✓ ($0.017/case
incl. judges) · **latency gate NOT met** (24.4s avg case latency vs the ≤8s
interactive target — this includes verifier + 3-judge majority per case, but
interactive p50 needs the W2b/dogfood look before cutover).

**Recommendation to the owner:** the architectural hypothesis is supported on
reliability (common-control +23.8 with every trust zero intact, and the
protocol's failure tax gone), while case-pass (+4.5) and latency remain honest
caveats. The three residual classes (profile padding, offer_apply drift,
cross-turn gmail.read) are exactly the MID-GAP improvement-cycle allowlist
(tool-schema ergonomics, tool-result representation) — bounded, not
architectural. W2b (owner-authored blind Holdout v2) is the confirmation gate.

## Preserved non-scored runs (infra/invalidation, never deleted)

- `semantic-w2a-B-{1,2,3}` — Bv1 (oneOf profile schema); schema reverted →
  affected runs invalidated per the freeze rule; numbers: 79.5/75.0/79.5, cc
  90.5/85.7/85.7.
- `semantic-w2a-pilot-*` — bring-up pilots (each ergonomics fix is traceable:
  empty-string args, key-presence, must-read rules, ACTION RULES, park/reminder
  read-backs, pending-items rendering).
- Historical envelope baselines on the FULL 60-case corpus: 80/80 cc
  (`semantic-bo-gpt41-1/2`) — NOT comparable to this subset; the A baseline
  here is the same-subset 44-case run.

---

## Addendum — bounded pre-holdout cleanup (owner-approved, 2026-09-29)

Four bounded items, then stop. Results on the SAME subset/corpus/judge:

1. **Kernel bug found and fixed (gmail content principal idiom).** The chain
   was never a native problem: `persistGmailContent` defaulted
   `principal_id` to the principal NAME ('josctl') while every reader filters
   by principal UUID — gmail content search/read returned zero rows in
   production, making `gmail_search` passes vacuous (honest-absence replies)
   and `gmail_read_chain` impossible (0/18 across both drivers). Fix:
   persist resolves the owner UUID (`content.ts`), migration `028`
   rewrites existing rows (tested down path), eval seed aligned. This bug
   predates native and equally suppressed the envelope.
2. **profile.update: resource-idiom reduction + bundle execution.** The
   gateway now deterministically reduces padded full-resource calls
   (drop empties/explicit-false, set-wins-removeAddress, drop
   equal-to-canonical no-ops), executes single changes directly, and
   executes multiple REAL changes as sequential single-change ops.
   Profile classes: 0/18 → **4/4 in validation, 6/6 in the post-fix run.**
3. **offer_apply:** diagnosed — mechanics sound (hermetic 17/17 incl. the
   full apply flow); the w2a B-class variance (6/9 → 1/9 → fixed seed era)
   is model semantic variance on "yes, track both" phrasings. Left alone
   per the owner's rule. Post-fix run: 1/2 (expired-offer honest ack judged
   untruthful — verifier strictness, preserved).
4. **Latency instrumented.** `runNativeTurn` now reports user-facing phase
   latency (cognition / tools / verify) on the outcome + `native.turn`
   audit, on REAL time (the injected clock never advances — the wall is
   production-true now). Post-fix full run: **turn-only p50 20.0s, p90
   43.9s** (excludes eval judging). Phase averages: cognition 4.2s,
   tools ~5ms, verify 6.7s — the cost is round-trip count (multi-dispatch
   turns) plus the verification ladder. Still above the ≤8s interactive
   target — flagged, unchanged by these fixes.

**Post-fix full run** (`semantic-w2a-postfix-full`): **38/44 = 86.4% case,
95.2% common-control, $0.69**, zeros held (unauthorized 45/45-equivalent,
phantom 100%), tool_validity 97.7%, truthful_ack 95.1%. Residual failures:
2 verifier-unavailable (provider legs — infra class, preserved), selector
miss (commitment-missed-02, both drivers), expired-offer honest-ack
judged untruthful, one judge-sensitivity on a capability explanation.
Freeze: `pre-holdout-cleanup` = commit carrying this addendum.
