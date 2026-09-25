# Intelligence Reset — "Make Jin Not Stupid"

Status: **ratified 2026-09-24** (owner review applied five amendments — C8
two-stage grounded design, dogfood bailout rule, zero-touch OWN SOMETHING bar,
bounded gmail search/read retrieval, multi-proposal salience rule — plus the
C10 delete-by-default disposition; O-13 freeze ratified). The 10-day freeze is
in force: W0, D4, CR1, new sensors, Memory V2, BrowserWorker/CodingWorker,
self-engineering do not resume during the reset window.

Evidence base (all read at HEAD `c9ee20a`, tree clean; tests re-run this
session: 2328 passed / 6 skipped with `TEST_DATABASE_URL` set — without it
the `describe.skipIf(!TEST_DATABASE_URL)` integration suites skip and
`pnpm test` reports 1540 passed / 794 skipped):

- `packages/core/src/imessage/conversation.ts` (the 2,663-line turn orchestrator)
- `packages/core/src/imessage/{model-selection,calibration-verbs,turn-interpretation,
  profiles,read-tools,capture,review-commands,calendar-actions,claim-audit,truthful-ux}.ts`
- `packages/core/src/queries/system-self-brief.ts`, `packages/core/src/context/assembler.ts`,
  `packages/core/src/imessage/threads.ts`
- `policy.yaml` (gateway passes, budgets, interpret/capture/actions/context flags)
- `docs/evals/model-routing-2026-09.md`, `docs/evals/answer-quality-2026-09.md`
- `evals/` (golden-set v2 61 items; `evals/conversation/` 15 scenarios incl. the
  2026-09-21 golden-transcript replay)
- `docs/plans/jarvis-v1.md`, `docs/plans/feedback-and-self-verification.md`,
  ADR-0004/0008/0011/0012/0013/0014/0015/0016/0017, git log D0–D3
- Failure transcripts as encoded in golden scenarios, ADR-0015 §33-36 autopsy
  quotes, and the owner directive's five incident classes (A–F)

Evidence labels used throughout (per directive §20):

```
[PROVEN]   demonstrated in code at HEAD; mechanism fully traced
[LIKELY]   mechanism traced, live-DB confirmation scheduled (Phase 0)
[HYPOTH]   plausible, must be settled by bake-off/golden suite
[TASTE]    preference, owner decides
[GAP]      future capability gap — not an intelligence failure
```

---

## 1. Executive diagnosis

Jehad OS is not stupid because it lacks machinery. It is stupid at the
conversation surface because **the machinery, not a model, interprets most
turns**, and where a model does interpret, it is frequently the cheapest tier
running with no conversation context. The repo already diagnosed this once —
jarvis-v1 §1: *"Jehad OS feels like 'a secure workflow engine with an LLM
attached' because, at the conversation surface, that is literally what it is"* —
and the D/W waves since then (correctly) built the durable-work side while the
conversational-cognition side accumulated more lanes, more canned replies, and
more machinery vocabulary.

Five findings carry most of the weight:

1. **[PROVEN] A deterministic lane hijacks ordinary conversation every
   evening.** Any prose message ≥15 chars that the route model tags `none`
   is swallowed as a calibration "miss" and answered with the identical canned
   string — for two hours after the 20:30 nightly prompt, every day
   (`conversation.ts:1897-1931`, `calibration-verbs.ts:169-171`). This is
   incident A ("you see my point, right?" / "why are you repeating the same
   response?" → "Logged as a miss…"), mechanically guaranteed, and it repeats
   because the deterministic path never reads the thread, so it cannot know it
   already said the same thing.

2. **[PROVEN] Persona preference and semantic memory are a split-brain, and the
   persona layer actively fights the user.** The seeded profile hard-codes
    `Address: call the principal "Chief"` (`profiles.ts:233`) into every answer
    prompt. Deterministic change exists only via two exact grammars that
    survive name-shape validation — `call me <Term>` (set; `always …`
    persists) and `stop calling me <Term>` (remove; `always stop calling me X`
    persists the removal — `profiles.ts:602-603,627-636`) — and "call me Sir,
    not Chief" matches neither. The working sibling path ("stop calling me
    Chief" → "call me Sir") is undiscoverable from the product surface.
    Everything else falls to the answer model (which is instructed to say
    "Chief") or to the interpreter,
   which proposes a **memory_candidate** — the wrong store; approving it can
   never change the address line. Incident B ("call me Sir, not Chief" →
   kept saying Chief → "captured for review [ref]" → approval failed) is this
   architecture working exactly as coded, plus a
   [LIKELY] proposal-lifecycle defect (source-event provenance, Phase 0 will
   pin the exact row).

3. **[PROVEN] The system's most expensive recent sensor feeds nothing.** Gmail
   content (ADR-0016/GC0: sanitized subjects+bodies, 445 real messages, 7-day
   retention, `content_enabled: true` in policy) has **zero production
   consumers**. `gmail.recent` reads only a 24h sender-domain histogram from
   events (`read-tools.ts:454-499`); the worker context builder is
   metadata-only (`assignments/context.ts:9`); briefs show counts. "Any
   pertinent emails?" is answered from `coinbase.com ×2` — while the actual
   messages sit in `gmail_messages`, unread by anyone. The self-brief honestly
   says metadata-only, so the system truthfully refuses a capability it has.
   This is category C (capability exists, routing doesn't expose it), not a
   model problem.

4. **[PROVEN] The cognitive layer is thin, context-blind, and mini-class.**
   Per grounded turn, up to four model calls fire sequentially: route
   (gpt-4.1-mini, strict JSON), interpret (gpt-4.1-mini — and
   `buildInterpretationPrompt(input.text)` is called **without thread history**
   at `conversation.ts:1936`, so the one component meant to understand intent
   sees exactly one message), answer (tiered: FAST=gpt-4o-mini for sub-80-char
   non-question turns — which is precisely where nuance lives; STANDARD/DEEP
   =sonnet-4.5), plus at most one claim-audit revise. The deterministic depth
   classifier (`model-selection.ts:129-142`) sends "call me Sir, not Chief"
   (23 chars, no question marker) to gpt-4o-mini.

5. **[PROVEN] 14+ deterministic pre-pass lanes run before any cognition, most
   terminating the turn.** Regexes over natural language decide whether a
   message is a capture, a correction, a skip, a directive, a commitment verb,
   a probe reply — each with its own canned reply, its own state store, its own
   edge cases. Incidents A/B/C/D are all this layer misclassifying ordinary
   speech (or classifying it into the wrong store). jarvis-v1 built useful
   lanes; the failure mode is that **deterministic interpretation precedes and
   preempts cognition**, rather than validating it.

The owner's hypothesis — *thick deterministic orchestration, thin cognitive
layer* — is **confirmed in shape but needs one refinement**: the deterministic
layer is thick in the wrong place. It is appropriately thick for **authority**
(policy, budgets, egress, confirm gates, canonical writes, audit — this is good
infrastructure and survives the reset intact). It is inappropriately thick for
**interpretation** (regexes deciding what the user *means*). The reset moves
interpretation to a strong model emitting typed, validated proposals, keeps
authority deterministic, and stops deterministic lanes from terminating
ordinary conversation.

Model quality is a **material co-contributor** [HYPOTH, high prior]: the
existing bake-offs already show sonnet-4.5 ≫ 4o-mini (4.78 vs 4.59 blind-judge)
on the real answer prompt, and the FAST tier + both mini passes are legacy
penny-optimizations on a system whose owner has explicitly deprioritized cost.
The bake-off in §5 settles how much is model vs architecture before the big
refactor is committed.

---

## 2. Actual current conversation architecture

Traced end-to-end at HEAD. Inbound iMessage path:

```
imessage-sensor (Mac, imsg:ingest grant)
  → apps/api POST /harness/imessage (Keychain bearer, grant check)
  → packages/core imessage/service.ts (identity, pairing, dedupe)
  → conversation.ts handleInbound()
      → grant check (imessage:converse)            [AUTHORITY, fail-closed]
      → principal policy check (gateway.principals)[AUTHORITY, fail-closed]
      → pg_advisory_lock per principal             [SERIALIZATION]
      → converseTurn() — the ordered cascade ↓
  → notifications kind=reply (conjunction-approved)
  → edge claims + sends; interaction_messages records both sides
```

`converseTurn` cascade, in exact order, with the directive's classification.
TERMINAL = replies deterministically; no conversational model ever runs.

| # | Lane (file) | Trigger | Class | Notes |
|---|---|---|---|---|
| 1 | attachment-only (`conversation.ts:828`) | U+FFFC-only text | TERMINAL | correct |
| 2 | review commands (`review-commands.ts`) | `approve/reject/snooze [REF]`, `queue` | TERMINAL | explicit control verbs — correct; bare `approve` defers to lane 4 when a proposal is pending (collision fix, D0) |
| 3 | `guests` | exact word | TERMINAL | correct |
| 4 | proposal confirm (`turn-interpretation.ts`) | exact verbs + broad affirmation grammar | TERMINAL when pendingProposal | authority gate for proposals — correct class, but the affirmation regex (`AFFIRM_LEAD_RE`) is interpretation-by-regex and will eventually eat a "yes" that meant something else |
| 5 | calendar confirm/cancel (`calendar-actions.ts`) | `confirm/cancel [CODE]` | TERMINAL | authority gate — correct |
| 6 | calibration rating | bare `1`-`5`, `rate N` | TERMINAL if sole open item | correct-ish (strict grammar) |
| 7 | retract | `changed my mind/never mind/scratch that` regex | TERMINAL if lastStance | interpretation-by-regex |
| 8 | profile directives (`profiles.ts:595-`) | `^be brief$`, `^call me (.+)$` + `always/from now on` prefixes | TERMINAL | interpretation-by-regex over a narrow phrasing space; silent no-match is incident B's front door |
| 9 | `yes, keep it` | exact string | TERMINAL if stance | correct |
| 10 | occurrence verbs | `it (didn't) happen(ed)` | TERMINAL if 0/1 candidate | interpretation-by-regex, calendar-gated |
| 11 | skip correction | `I skipped / didn't attend` + time-ref | TERMINAL if match | interpretation-by-regex |
| 12 | calibration correction (`calibration-verbs.ts:120-131`) | 7 regexes incl. `not connected`, `you don't know`, `left out` | TERMINAL if sole open item, **no time window** | over-broad; second hijack surface after #14 |
| 13 | reminder probe replies | exact grammar, pendingProbe only | TERMINAL if live probe | correct (system opened that conversation) |
| 14 | `remind me to X` | prefix regex | TERMINAL (capture-enabled principals) | explicit imperative — acceptable class, brittle grammar |
| 15 | commitment verbs | `done/missed/renegotiated [ref]` | TERMINAL | correct |
| 16 | `/new`, `/reset` | exact | TERMINAL | correct |
| 17 | capture (`capture.ts`) | `remember that / note: / don't forget` prefix | TERMINAL | explicit imperative — acceptable class |
| — | typing presence | best-effort notification | side effect | |
| — | budget checks (rolling hour / UTC day, model_calls ledger) | pre-dispatch | AUTHORITY | fail-closed, honest notice |
| 18 | **route pass** (gpt-4.1-mini; fallback gemini-3.8-flash on parse failure) | every grounded turn | CONTEXT (read set, ≤3 tools) / TERMINAL for action-clarify + calendar proposals | mini model decides data needs from a 7-tool menu |
| 19 | **calibration miss** | route=`none` AND open item AND <2h since prompt AND ≥15 chars | **TERMINAL** | **incident A — deletes the answer model from every chatty evening turn** |
| 20 | **interpret pass** (gpt-4.1-mini) | every grounded turn (`interpret.enabled`) | SIDE EFFECT (≤4 typed proposals parked, 1 pending) | no thread history passed |
| 21 | read tools (parallel, policy-gated, 1500-char blocks) | from route | CONTEXT ENRICHMENT | 7 fixed tools; gmail = domain histogram only |
| 22 | **answer pass** | tiered fast/standard/deep | COGNITION | the only "conversation" in most turns |
| 23 | claim audit + machinery strip (+≤1 revise) | every model reply | AUTHORITY (truth) | good idea, adds latency + can mute voice |
| 24 | offer append (interpreter proposals) | post-answer | SIDE EFFECT | only if it fits the 1500-char cap |
| — | notification + thread append + audit | always | — | |

Wiring asymmetries noticed while tracing [PROVEN, minor]: when reads fire
(blocks path, `conversation.ts:2051-2053`), the answer prompt gets persona +
self-brief + caveats but **not** pendingState or lessons; the no-reads path
gets pendingState + lessons. The claim audit then checks pending-state claims
against facts the answer model may never have seen. `collectSelfBrief` is
always called with `activeProfileVersion: null` (`conversation.ts:1759`), so
the self-brief permanently claims "(no active profile)" even when one is
active.

Per-turn cost today: route ≈ $0.0004 + interpret ≈ $0.0004 + answer
($0.0001 FAST 4o-mini / ≈$0.003 STANDARD sonnet — per-answer means
computed from `answer-quality-2026-09.raw.json`; caution: the eval doc's
"cost" column is per-model **totals** across 24 answers, not per-answer —
$0.0358 + $0.0754 + $0.0025 + judge ≈ its $0.1383 total spend) +
occasional revise. Real-thread prompts carry more history than the
~600-token bake-off fixtures, so ~$0.005-0.015 is the planning band for a
sonnet conversational turn [HYPOTH — Phase 0 volume + Day-10 ledger pin
it]. Latency: ~0.7s (route) + ~0.7s (interpret) + 0.9-3.8s (answer),
sequential — 2-5s before a typing bubble becomes a reply.

---

## 3. Root-cause hypotheses, ranked by evidence

Applying the directive's §12 taxonomy (A capability absent / B model doesn't
know / C routing doesn't expose / D deterministic lane blocked cognition /
E bad model judgment / F missing context / G stale canonical state /
H internals exposed):

| # | Cause | Class | Evidence | Incidents explained |
|---|---|---|---|---|
| R1 | Calibration miss/correction lanes terminate ordinary conversation | D | [PROVEN] code path `conversation.ts:1897-1931`, canned ack, no thread awareness | A, C |
| R2 | Persona-vs-memory split brain + grammar-only directive lane + seeded counter-instruction | D+B+G | [PROVEN] `profiles.ts:233,595-634`; interpreter proposes memory_candidate for preferences | B |
| R3 | Interpretation delegated to mini-class models without thread context (route + interpret passes) | E+F | [PROVEN] `policy.yaml` passes; `conversation.ts:1936` no history into interpreter | D, E, F |
| R4 | FAST tier = gpt-4o-mini for exactly the nuanced short turns | E | [PROVEN] `model-selection.ts:140`; bake-off 4.59 vs 4.78 | B, D, F |
| R5 | Gmail content ingested but exposed to no reader | C | [PROVEN] zero consumers of `gmail_messages` (grep; `read-tools.ts:454`, `assignments/context.ts:27`) | "any pertinent emails?" feeling dumb |
| R6 | 14+ pre-pass regex lanes with independent canned UX | D+H | [PROVEN] §2 table | C, D |
| R7 | Machinery vocabulary in canned replies (`[REF]`, "captured for review", "Logged as a miss", confirm codes) | H | [PROVEN] copy throughout lanes | C |
| R8 | Proposal lifecycle defects (source-event provenance; single-slot pendingProposal; no TTL) | G | [LIKELY] gate-1 `source_event_not_found` reachable on some path (Phase 0 pins the row); single-slot at `conversation.ts:2281-2298` [PROVEN] | B ("approval failed") |
| R9 | Stale self-model remnants | B+G | [PROVEN] `activeProfileVersion: null`; gmail self-brief says metadata-only while content sits in DB (that one is honest-but-wasteful, ties to R5) | E |
| R10 | No local/web search capability | A | [GAP] out of scope for the reset; upholstery-cleaner class | — |

Ranked confidence: R1, R2, R5 are individually sufficient to make daily use
feel stupid and are all fixable without new infrastructure. R3/R4 are settled
by measurement (§5). R6-R9 are compounding UX tax, addressed by the §11
changes.

---

## 4. Deterministic-lane inventory

Full table in §2; per-lane detail (trigger, precedence, termination, storage,
UX, known bugs) with file references:

- **Capture lane** (`capture.ts`): prefix regex; `memory_candidates`
  in_review + force-review gate; 24h dedupe, 5/hour cap; reply "Noted —
  captured for review… [REF] — reply approve [REF] or reject [REF]".
  Correct class (explicit imperative) but machinery-heavy copy.
- **Review commands** (`review-commands.ts`): exact-match; 3-char Crockford
  refs, 168h TTL, bad-ref lockout; hard gates re-check on approve — approve
  can honestly fail with "stopped by a hard gate (source_event_not_found)"
  [incident B's tail; mechanism pinned in Phase 0].
- **Turn interpreter proposals** (`turn-interpretation.ts`): 5 proposal types,
  ≤4/turn, ≤1 per type; strict JSON parse failing the whole payload on any
  forbidden term; pendingProposal parked in thread metadata (single slot, no
  TTL); confirm verbs exact + affirmation grammar; bridges write through
  canonical services. Sound contract; the model behind it is too small and
  context-blind (R3).
- **Calibration** (`calibration/service.ts`, `calibration-verbs.ts`): nightly
  20:30 item; rating grammar strict; **miss intake = any routed-none prose in
  a 2h window** (R1); **correction grammar = 7 regexes, no window, matches
  "not connected" etc.**; misses/corrections never become memory (correct).
- **Persona lane** (`profiles.ts`): thread overrides apply immediately;
  persistent changes via "yes, keep it"; append-only versioned
  `interaction_profiles`; forbidden-vocabulary door on fragments. The lane is
  fine; the **trigger grammar is the defect** (R2).
- **Occurrence/skip verbs, commitment verbs, probe replies, reminder phrase,
  calendar confirm codes**: all sole-item-or-clarify, CAS-guarded canonical
  writes. Correct authority shapes; brittle interpretation grammars; several
  should become model-proposed + deterministic-validated after the reset.
- **Dormant M5B batch-extraction lane** (`extraction/service.ts`
  `extractFromEvent`): no production trigger; `proposed` candidates have no
  sweep; dead complexity — delete by default (C10) [PROVEN].

**Termination rule to adopt (refined from the directive's draft):**

```
A deterministic lane may TERMINATE a turn only when:
  T1. the message is an explicit control verb aimed at pending system state
      (approve/reject/confirm/cancel/snooze/track them/log it/queue/reset), or
  T2. it is a security/budget/egress denial, or
  T3. the message is an exact-match imperative whose executor the system
      opened ("remind me to X", replies to a check-in probe), or
  T4. it is an attachment/edge capability the channel cannot render.
Everything else — observations, feedback, corrections, preferences,
captures-of-fact, task mentions, emotional reactions, questions about the
system itself — is recorded as a SIDE EFFECT (or proposal) and the
conversational model still answers, informed that the side effect happened.
```

**[SUPERSEDED 2026-09-24 by §22.10's complete terminal-lane list — T1's
affirmation grammar and every phrasing-based lane below die with it; §22
governs wherever conflicting.]**

Under T1-T4, lanes 6, 12, 19 (miss), and arguably 7/10/11 lose termination
rights; lane 8 (profile directive) keeps them only for exact-grammar matches
and gains a model-proposed fallback for everything else.

---

## 5. Model bake-off design

Question: **are we compensating for an underpowered model with architecture?**
Existing evidence says partially — sonnet-4.5 beat 4o-mini 4.78 vs 4.59 on the
real answer prompt (24 scenarios, blind gemini-2.5-flash judge,
`docs/evals/answer-quality-2026-09.md`), and the repo's own jarvis-v1
diagnosis was "answer model was the cheapest tier by fallthrough." What's
missing: whole-conversation, multi-turn, same-context comparison including the
route/interpret passes.

Design (extends `evals/answer-quality/` infrastructure; $10 hard cap,
spend-reported, split derived up front from **measured** per-answer means
(`answer-quality-2026-09.raw.json`: sonnet $0.0031, gpt-4.1 $0.0015,
4o-mini $0.0001; the frontier candidate is the only unpriced term —
budget it at ≤$0.10/answer until merge-time pricing says otherwise
[HYPOTH]): Track A ~$3 — all 6 candidates, 24 scenarios, answer-only;
144 answers ≈ $0.20 without the frontier, ≈$2.6 at the planning rate.
Track B ~$4 — 3 runs: the incumbent baseline plus the two best Track-A
candidates, × 20 live conversations × ~2 turns; measured non-frontier
whole turns are cents (sonnet-all ≈ $0.005-0.015/turn at §2's band), so
Track B lands ≈$1.5-9 with the frontier-all run the entire swing
(≈$0.03-0.20/turn, unpriced) — expect to trim, by rule, not by
accident. Capability probe ~$1 — first turns of the 20 golden
conversations, all candidates. Blind judging ~$1 (the existing bake-off
judged 72 replies for $0.025). Unspent Track-A split reverts to Track B,
the swing track. If a track would still breach its split, trim in an
order that protects the decision before the grid: (1) shrink scenario
count (20 → 12) before dropping any candidate — every comparison on
fewer conversations beats fewer comparisons; (2) drop Track B's third
arm — never the incumbent run (D-1's baseline) or the Track-A leader
(D-1's challenger); (3) only then drop candidates bottom-up, Track A's
fallback order being the existing bake-off ranking (4o-mini first, then
gemini-3.8-flash, then gpt-4.1), since "Track-A rank" is circular before
Track A runs. Every trim recorded in the bake-off report — a Day-5
decision on partial data must at least know it's partial:

- **Fixed inputs** — same system context, persona fragment, self-brief,
  thread history, permitted tools + DATA blocks, source data, prompt version
  (`imessage-converse-v2`). Candidates never see different information.
- **Candidates:**
  1. `openai/gpt-4o-mini` (incumbent FAST)
  2. `openai/gpt-4.1-mini` (incumbent route/interpret)
  3. `anthropic/claude-sonnet-4.5` (incumbent STANDARD)
  4. `openai/gpt-4.1`
  5. strongest practical candidate we'd realistically pay for
     (`anthropic/claude-opus-4.6` or frontier-equivalent at merge time)
  6. `google/gemini-3.8-flash` (fallback reference)
- **Two tracks:**
  - **Track A (answer-only, like today's bake-off):** 24+ scenarios through
    `buildAnswerPrompt`, blind-judge on the existing 5 dimensions.
  - **Track B (whole-turn, live):** the golden suite (§6) replayed through
    the real `handleInbound` with live models for route/interpret/answer —
    measures the *system*, not the prompt: hijack rate, offer quality,
    referent resolution, machinery leakage, end-to-end latency and cost.
    Isolation rule: Track B runs on a checkout pinned at the reset's start
    commit (`c9ee20a`) — architecture is the FIXED variable, candidate model
    ids the only variable (per-run provider override in the eval harness,
    never mid-run `policy.yaml` edits), so Phase 1's parallel lane changes
    cannot move the baseline. The post-C1/C2 stack is measured separately in
    Phase 4 dogfood; the two configurations are never mixed in one
    comparison.
- **Route/interpret capability probe:** the same 20 golden conversations with
  route+interpret executed by each candidate — can a single stronger model
  emit valid read-sets and valid typed proposals in one call? (Parse-rate
  against the existing strict parsers is the metric; adversarial X03-style
  fixtures included.)
- **Dimensions (bake-off scorecard for Track-B whole-turn runs and the
  capability probe; Track A keeps the existing bake-off's five —
  groundedness, prioritization, honesty, concision, referents — so its
  4.59-4.78 history stays comparable; the golden suite's own acceptance
  dimensions are §6's nine):** intent understanding, referent resolution,
  natural continuation, judgment, useful next action, tool choice,
  uncertainty handling, self-model correctness, chief-of-staff behavior,
  verbosity/style. Record quality, p50/p95 latency, cost/turn, failure
  modes.
- **Decision ladder (settles C7/C8; evaluated Day 5, in order):**
  - **D-1 → C7:** if, on *model-touched turns only*, the strongest candidate
    run (candidate substituted into route+interpret+answer) beats the
    incumbent run by ≥ +0.3 on the 1-5 blind-judge mean, **or** wins owner
    pairwise preference — ≥60% of ≥20 blind pairs, incumbent-run vs
    candidate-run replies on the same model-touched Track-B turns, same
    protocol as §16 USER PREFERENCE (if trimming leaves fewer than 20
    model-touched pairs, the pairwise disjunct is unscored and D-1 rests
    on the score disjunct — recorded) — at ≤ ~$0.10/turn marginal cost
    (sanity bound, not selector: measured marginals are cents), C7 lands
    Day 5 with that model in all conversational passes. Scale note: the
    repo's only judge scores 1-5 and the incumbent's own tiers already
    sit at 4.59-4.78 (`docs/evals/answer-quality-2026-09.md`), so a +1.0
    bar is unreachable — max headroom to the 5.0 ceiling is +0.41 — and
    +0.3 ≈ 1.6× the 0.19 best-vs-incumbent spread already observed.
    Track-B scenarios that terminate before any model runs (the
    calibration-hijack class at the pinned commit) are
    architecture-constant — identical for every candidate — and are
    reported separately, never inside the model delta. (A pass bar is a
    rate; judge points are a score; only a score can take a points
    delta.)
  - **D-2 → C8 go/no-go, decided by the capability probe, not Track B:**
    C8 proceeds only if the single-pass probe shows ≥96% parse-validity on
    golden fixtures (incl. adversarial X03) AND either (a) C7's win is
    marginal — below the D-1 bar on the useful-next-action and
    referent-resolution dimensions of the Track-B scorecard above — or
    (b) the merged pass cuts measured per-turn latency or cost ≥25% vs
    two-pass. Otherwise two-pass stands with upgraded models; C8 defers per
    O-15.
  - **D-3 → no winner:** if no candidate clears D-1 on model-touched turns,
    model quality is not the binding constraint; C7 takes the cheapest
    candidate whose blind-judge mean ties the incumbent's within ±0.2 and
    which, if an owner pairwise was scored for it, did not lose it (none
    qualifies → keep incumbent models, change nothing, spend $0), and the
    reset's weight falls on C1/C2/C4 plus the §20 product-shape question.

  No pennies optimization: this is a private household system.

---

## 6. Golden conversation eval suite

~20 whole conversations; real failures wherever possible. Extends
`evals/conversation/` (runner already replays through the real `handleInbound`
against isolated Postgres with scripted providers; hermetic = hard gate, live
= evidence). Every scenario carries `reply_not_contains` pins for machinery
vocabulary ("logged as a miss", "captured for review", "[A-Z0-9]{3}]",
"source_event", "calibration", "proposal") on ordinary-conversation turns, and
`db_pins` for canonical effects.

1. **todo-list** (have: golden-todo-proposal-01/-confirm-01) — 8-item list →
   proposal → "track them" → 8 commitments, 3 dated.
2. **calibration-hijack** (new; incident A verbatim) — 20:45 PT: unusual-day
   explanation → follow-up "got it, but you see my point, right?" → "why are
   you repeating yourself?" — must answer conversationally, may log the miss
   silently, must never repeat an ack.
3. **address-me** (new; incident B) — "call me Sir, not Chief" → immediate
   profile change offer/apply → next turn's reply must not say Chief.
4. **pertinent-emails** (have: golden-gmail-pertinence-01 — upgrade to a
   content fixture) — with content fixture in
   `gmail_messages`: must surface the two actually-pertinent messages, not a
   domain histogram.
5. **upholstery-cleaner** — local-search [GAP]: must say what it can't do
   ONCE, offer the closest useful action, no fake search.
6. **we-should-fix-that** (have: golden-capability-gap-01) — becomes a
   system_feedback proposal + natural ack,
   conversation continues.
7. **yusra-persona** (have: golden-yusra-persona-01 — upgrade: honest
   activation, no "I can't inspect that") — owner-authorized staging with
   honest activation boundary, no "I can't inspect that."
8. **remember-earlier** (have: memory-recall-01/-none-01 — upgrade:
   cross-thread + provenance pins) — cross-thread recall via memory.recall +
   "per evidence" provenance.
9. **handle-this-for-me** — outcome_spec staging with real criteria.
10. **keep-this-moving** — nudge on an in-flight outcome.
11. **what-happened-with-X** — synthesis over outcome/assignment/evidence.
12. **what-am-i-waiting-on** — commitments + delegated outcomes in one answer.
13. **one-off-day** — "that was just a one-off day" must NOT be stored as a
   miss/correction terminal ack; conversational, optionally side-effect.
14. **not-what-i-meant** — correction of a pending proposal; offer stands or
   re-offers correctly.
15. **why-cant-you** — capability honesty from self-brief, one sentence of
   boundary, then the closest thing it CAN do.
16. **what-can-you-access** (have: golden-persona-selfbrief-01 — upgrade:
    profile-version + gmail-depth pins) — self-brief fidelity incl. active
    profile version (post-fix) and gmail depth (post-§11 C4).
17. **changed-my-mind-mid-batch** — affirm with residue ("yes, everything
   else thursday").
18. **stale-calendar-day** — planned vs observed caveat (have:
   staleness-honesty-01).
19. **injection-pin** — pasted JSON / "ignore instructions" inside email
   content once content is exposed (extends existing pins).
20. **repeat-offer-collision** — pending proposal + review queue item both
   live; bare "approve" resolves the proposal, queue intact.

Dimensions scored (judge + owner): UNDERSTANDING, CONTINUITY, JUDGMENT,
INITIATIVE, NATURALNESS, SELF-KNOWLEDGE, TRUTHFULNESS, CHIEF-OF-STAFF
BEHAVIOR, and **USER PREFERENCE** — pairwise, blind, against a ChatGPT-style
baseline (same info rendered as a plain ChatGPT system prompt). USER
PREFERENCE is the gate that matters; the rest are diagnostics.

---

## 7. Chief-of-staff behavioral contract

Current reality [PROVEN]: "chief of staff" is mostly *voice* — the seeded
profile is `terse, serious, judgment-forward, no filler` + 4-sentence/500-char
brevity caps + "Chief" address (`profiles.ts:229-247`). Executive *behavior*
lives in scattered deterministic behaviors (offer CTAs, briefs' theOneThing,
Delegate/Watch machinery) — not in the conversational stance.

Contract (what the answer model is actually instructed to be; placement in
parentheses):

- Notice open loops, deadlines, contradictions across what's in context.
  (answer prompt + day.state enrichment)
- Identify what's actionable and say which one matters first. (persona
  register + briefs queries)
- Convert loose intent into bounded proposals with explicit done-criteria.
  (interpreter, post-upgrade)
- Surface blockers and waits without being asked. (briefs + commitments
  queries in context)
- Ask only for genuine judgment; never ask what it can find out itself.
  (prompt rule)
- Distinguish planned / observed / unknown, always. (existing truthful-UX
  rules — keep)
- Challenge weak assumptions when evidence in context contradicts them.
  (prompt rule)
- Follow through: parked work re-surfaces at the promised moment (reminders,
  outcomes — already built).
- Never shrug passively; "I can't X" is always followed by the nearest thing
  it can do. (prompt rule + self-brief)
- No implementation jargon, no internals, no protocol vocabulary in replies.
  (truthful-ux, extended by §11 C6)

Placement rule: behaviors that are *judgment about this turn* go in the
persona/prompt layer; behaviors that are *stateful noticing* go in
deterministic queries feeding context (briefs, waiting-on, day.state);
behaviors that are *timing* stay in workflows (reminders, scanners). **No new
regex lanes.**

---

## 8. Self-model assessment

Good news: the runtime-derived self-brief exists and is well-designed
(`system-self-brief.ts`: derived from live sync state + policy + code
constants; reuses W7's versioned limitations; no vendors/names leak). The
stale-claims era (E) is mostly over. Remaining defects:

- [PROVEN] `activeProfileVersion: null` always — brief claims "(no active
  profile)" forever. One-line fix + wire the real version.
- [PROVEN→C4] Gmail self-brief says metadata-only — true of the *read tools*,
  false of the *system* once content lands; after §11 C4 the brief must state
  content depth honestly (including 7-day retention).
- [LIKELY] Self-brief doesn't enumerate outcome/assignment/delegation state
  ("what are you currently doing?" answers exist only via system.state tool —
  add an armed-work line: active outcomes, running assignments).
- The answer prompt line "Never claim you scheduled, created, sent, or
  changed anything — you cannot" is now false in spirit (proposals + confirm
  flows exist and the same reply often appends an offer inviting exactly
  that). Reword to: mutations happen only through explicit confirmations.

Verification: golden scenario 16 asserts self-brief fidelity against a
runtime-derived fixture, so the brief can never drift again.

---

## 9. Context/memory assessment

What the answer model receives today [PROVEN]: persona fragment, self-brief,
truthful-UX rules, pendingState OR data blocks (not both — wiring asymmetry,
§2), lessons (no-reads path only), ≤20-message/72h working history rendered
as untrusted transcript, ≤3 read blocks at 1500 chars each, caveats/freshness
lines.

Findings:

- **Missing critical context:** gmail content (R5); active outcomes/assignment
  state; the calibration-miss side effect (after C1, the model must be told
  "you logged a miss for today" so it can weave it in naturally).
- **Redundant/stale:** the blocks-vs-no-blocks pendingState/lessons split;
  self-brief "no active profile."
- **On-demand is right:** calendar/commitments/memory.recall as pulled reads
  is correct — do not pre-load. No evidence retrieval is the bottleneck
  (recall exists, is used, is principal-scoped).
- **Memory V2 is NOT gated on this reset.** Write-only memory was a jarvis-v1
  problem; recall exists now. Revisit only if golden suite shows recall
  misses (it currently shows routing/termination misses).
- Working-context bounds (20 msgs / 72h / 7d raw, ADR-0014) are fine; no
  change recommended.

---

## 10. Proposal/capture architecture assessment

Inventory of proposal-ish stores: `memory_candidates` (Lane B/C), task batches
(pendingProposal in thread metadata), `feedback` rows (system_feedback),
profile deltas (stance + "yes, keep it"), `outcome_spec` (pendingProposal),
review items (`memory_candidates` in_review + `escalations`), calibration
misses/corrections (`feedback`), `action_intents` (calendar confirm codes).

Assessment: the **typed-proposal + deterministic-validator + confirm-verb**
core (interpreter contract, `turn-interpretation.ts`) is the right primitive
and should *absorb* lanes rather than be replaced by a generic abstraction.
Specific convergences:

- Persona directives and memory-candidate preferences are the same user
  intent ("how you treat me" vs "facts about the world") — route by target,
  not by phrasing (fixes R2 structurally).
- Calibration corrections/misses become a `feedback`-typed proposal the model
  can acknowledge naturally (fixes R1's UX half).
- Single-slot pendingProposal → per-type slots (at most one of each type is
  already enforced) so a task batch and a system feedback can be pending
  simultaneously; add TTL (e.g. 24h) and stale-offer honesty.
- **Multi-proposal confirmation salience rule** (owner amendment): when a bare
  "yes"/"approve"/"do it" arrives with pending proposals, if exactly one
  conversational proposal is salient (offered last turn, or the only one
  alive), resolve it; if more than one is plausibly the referent, ask a human
  question ("The task list or the persona change?") — never surface internal
  refs or machinery to disambiguate an ambiguity we created ourselves.
- Known lifecycle sharp edges to fix while in here [PROVEN from tests/docs]:
  bare-`approve` collision (already fixed, pin exists), ref CHECK constraint
  blocking commitment refs (needs the small migration), no sweep for
  `proposed` candidates (retire the dormant lane instead), outcome-spec
  refusal keeping offers pending forever (TTL fixes).
- Do NOT build a generic Proposal table. Converge triggers, keep typed
  writers.

---

## 11. Specific changes recommended

Ordered by leverage; C-numbered for the execution plan. Sizes are S (≤half
day) / M (1-2 days) / L (3+ days).

**C1. Kill the calibration conversation hijack.** (S; fixes R1/incident A)
- Miss intake: store the miss as a side effect, then RUN the answer pass with
  "you just logged a calibration miss for today" in context; the model
  replies naturally. Terminal canned ack deleted.
- Correction grammar: fire only when the message is a reply to the open
  calibration notification (thread/probe linkage like reminder probes), not
  ambient open-item + regex. Non-linked corrections ride C2.
- Add repeat-detection: no identical deterministic ack twice in a thread
  (cheap: last-outbound check in `deterministicReply`).

**C2. Preference routing: profile lane, any phrasing, model-proposed.** (M;
fixes R2/incident B)
- The interpreter's `configuration_directive` gains address/tone keys and
  becomes the default path for preference statements; deterministic grammar
  stays as a fast path for exact matches.
- `memory_candidate` proposals for address/tone/preferences are re-typed at
  parse (validator rejects preference-shaped memory summaries when the
  profile lane can hold them).
- Owner decision O-12 seeds the starting address term (see §19).

**C3. Approval-failure fix.** (S; incident B tail) Phase 0 live-DB query for
`gate_result->'reason' = 'source_event_not_found'` on recent candidates +
the audit trail of the failing approve; fix the provenance seam (sensor
sourceEventId idempotency mismatch is the prime suspect) and add a
regression fixture.

**C4. Expose gmail content to cognition via bounded retrieval.** (M; fixes R5)
- Two new read tools over the existing normalized `gmail_messages` records:
  `gmail.search(query, timeRange, limit)` → bounded result list (from, subject,
  date, messageId) and `gmail.read(messageId)` → the sanitized normalized body
  of one message. Snippets alone are not enough — "What did Plaid say?" and
  "which emails actually need something from me?" require bodies. Never bulk-
  dump the corpus into context; retrieve specific bounded content on demand,
  same per-block char budgets as every other read.
- The 7-day retention window is stated as coverage on every result; injection
  boundary unchanged (content enters only as untrusted DATA blocks, claim
  audit applies, injection pins extended to content-bearing turns).
- Update self-brief + coverage lines ("content: last 7 days, on-demand");
  golden scenario 4 exercises search→read chains.
- Privacy: content stays within egress policy `personal/normal`; no new
  egress.

**C5. Self-model fixes.** (S) `activeProfileVersion` wiring; "never claim you
scheduled" rewording; armed-work line (active outcomes/assignments) in the
self-brief.

**C6. Machinery disappears from ordinary turns.** (S-M; R7)
- Extend `stripMachineryLines` + reply-copy rules: no `[REF]` codes in
  conversational acks (refs only when the user asks for the queue), no
  "captured for review"/"logged as a miss" phrasing, offers phrased as
  English ("Want me to track these 8?" not "Reply 'track them'…").
- Confirm verbs stay permissive (T1 keeps "yes/sure/do it" working — consent
  is never a vocabulary quiz, but the *offer* is human).

**C7. Model upgrades from bake-off.** (M; R3/R4; gated on §5 ladder)
- Default expectation: retire the FAST tier's 4o-mini for conversational
  turns (deterministic acks don't use models anyway); sonnet-4.5-class (or
  bake-off winner) becomes the conversational default; route/interpret are
  upgraded to the same winner per D-1, or merged per D-2.
- Policy-only change (`gateway.passes`), instantly reversible.

**[SUPERSEDED by §22 — C8 is now the full single-author inversion, no longer
optional or D-2-gated; the two-stage shape below is the `legacy` rollback
path per §22.14.]**

**C8. Merge route+interpret into one cognitive pass (two-stage on grounded
turns)** (L; gated on the §5 decision ladder, D-2 — capability probe + golden
suite, not Track B). One strong-model **cognitive pass** per turn emits
`{reads:[...], proposals:[...], interpretation}` against the existing strict
parsers as validators — it never writes the final reply when it has requested
data it hasn't seen (no hallucination pressure recreated in the name of fewer
calls). Shape:

```
strong cognitive pass
→ reads + proposals + interpretation
→ deterministic policy validates reads (allowlist, ≤3)
→ execute reads
→ reads exist: grounded answer pass (same strong model) over the DATA
→ no reads:   the cognitive pass's own reply may ship directly
```

This kills the redundant route+interpret split (two mini calls become one
strong call); grounded turns deliberately remain two-stage because the model
must receive tool results before answering. A true model tool-call loop is the
same logic with more rounds — not needed while reads are cheap and bounded.
Deterministic policy still gates reads and still owns confirms;
budgets/egress unchanged. Route prompt's 7-tool menu dies; the model asks for
what it needs. Proceeds only per D-2 — C7's win is marginal, or the merged
pass buys ≥25% latency/cost — this is the biggest change and the one the
bake-off must justify.

**C9. Context wiring fixes.** (S) pendingState+lessons on both answer paths;
interpreter gets recent exchanges (the parameter exists; wire it).

**C10. Delete the dormant M5B extraction lane** (S) — default is deletion
(`extractFromEvent` has no production trigger; dead proposal state dies with
it). Wire-its-sweep instead only if Phase 0 finds an actual production
consumer; "leave it dormant" is not an option — this reset removes machinery.

**C11. Golden suite + hijack regression pins as hard gates in `pnpm test`.**
(M; lands with C1/C2.)

Explicitly **not** doing: Memory V2, new sensors, orchestrator decomposition
beyond C8, BrowserWorker/CodingWorker, CR1, persona engines, agent
frameworks, fine-tuning, LLM-judge-in-the-loop per reply.

---

## 12. Things explicitly NOT to change

- Postgres as the sole system of record; event log + provenance everywhere.
- Principal isolation, capability grants, egress policy, budgets/ceilings,
  ActionIntent semantics, builder≠verifier, canonical DB ownership,
  prompt-injection boundary (untrusted DATA/HISTORY blocks), retention rules,
  always-confirm for consequential actions (ADR-0007/0011/0012/0013 core).
- The typed-proposal/confirm-verb mutation contract (invariant 16).
- Claim audit (SV1/SV2) — deterministic truth verification of protocol/state
  claims stays; only its copy is softened where it mutes voice.
- Threads model (ADR-0014), memory promotion review gate (ADR-0004),
  calibration as a *practice* (the nightly prompt survives; only its
  conversational takeover dies), outcomes/assignments/verifier machinery
  (D0-D3 — untouched), briefs, reminders.
- Tests-as-hard-gates discipline: every change lands with golden + adversarial
  pins; hermetic > LLM judges for correctness, judges only for quality.

---

## 13. Security invariants (all preserved, several load-bearing for C4/C8)

- Principal isolation on every read/recall/context path (C4's content reads
  are principal-scoped + domain-scoped like all others).
- Egress: models only via callModel gate; no new providers; content stays
  `personal/normal`; secrets never in prompts/events/logs.
- C8's merged pass may *request* reads; **policy + allowlist still decide**;
  model output is validated data, never authority (same invariant as today's
  interpreter: forbidden-term fail-closed, exact-key parsers).
- Confirm gates for external side effects unchanged (calendar actions,
  outcomes, cross-principal staging).
- Injection boundary: gmail content enters as untrusted DATA with the
  existing BEGIN/END discipline + claim-audit; golden injection pins extended
  to content-bearing turns.
- Budgets: per-principal rolling-hour/UTC-day caps unchanged; C7 raises cost,
  owner re-ratifies envelope (O-10) — caps enforce it either way.

---

## 14. Phased execution plan (10 days, feature freeze in force)

**Freeze (ratify as O-13):** paused — W0, D4, CR1, new sensors, Memory V2,
BrowserWorker, CodingWorker, self-engineering. Allowed — bug fixes,
instrumentation/eval tooling, bake-off, conversation-path changes C1-C11,
self-model fixes, critical security/reliability fixes (F-wave-class), D0-D3
operations (outcomes keep running; dogfood them).

- **Phase 0 — Evidence lock (Day 1).** Live-DB queries: calibration-miss
  audit rows + hour-of-day distribution; `source_event_not_found` gate
  results; reply-marker distribution (`deterministic:` markers) over the last
  14 days; per-tier model-call distribution (how many turns actually hit
  FAST vs STANDARD). Converts every [LIKELY] above to [PROVEN] or dead.
  Freeze ratified. C3 fix lands if Phase 0 pins it.
- **Phase 1 — Stop the bleeding (Days 1-3).** C1 (hijack kill + repeat-ack
  guard), C2 (preference routing), C5 (self-model), C6 (machinery copy),
  C9 (context wiring), C10. All S/M, all pinned by C11 golden scenarios
  2, 3, 13, 14.
- **Phase 2 — Bake-off + golden suite (Days 2-5, parallel with Phase 1).**
  §5 bake-off ($10 cap), §6 suite live-mode. Track B pinned to the
  reset-start commit (`c9ee20a`) so Phase 1's lane changes cannot move the
  baseline mid-run. Output: model decision (C7 config per the §5 decision
  ladder) + C8 go/no-go (D-2). Also built here: the ChatGPT-baseline arm for
  the §16 USER PREFERENCE gate (same context rendered as a plain ChatGPT
  system prompt) — the ≥60% gate cannot be scored without it and it is in
  no other phase. Authoring load: ~13 net-new scenarios (7 of §6's 20
  already have fixtures) — the Phase-2 long pole.
- **Phase 3 — Cognitive path (Days 5-8).** C7 policy change Day 5 (immediate
  quality lift, instantly reversible). C4 (gmail content) Day 5-6. C8 only if
  bake-off says so, Days 6-8 behind the `gateway.routing` flag (§22.14 — the
  amendment later made C8 mandatory; §22 governs).
- **Phase 4 — Dogfood + acceptance (Days 8-10).** §15 protocol; TALK/KNOW/OWN
  measured; rollback or ratify.

Timebox discipline: Phase 3 C8 is the only L-sized item and is *optional by
evidence*; everything else is reversible config/copy/lane-class changes. If
Day 5 arrives without Phase 1 green, C8 is automatically descoped to a
follow-up — the reset does not slip past 10 days.

---

## 15. Dogfood protocol

Days 8-10 (owner + optionally Yusra for the unread-principal lane):

- Daily traffic starts with Jin; **bailing to ChatGPT is explicitly allowed
  whenever Jin frustrates you** — every bailout is a high-value failure
  datapoint (log what you reached for and why; each becomes a golden-scenario
  candidate). Voluntary preference cannot be measured while the alternative is
  prohibited; the blind pairwise eval (§6) is the controlled measure, and the
  bailout log is the honest one.
- Every evening: owner tags the day's thread — each reply ✓/✗ on
  understood / natural / useful; ✗ replies become golden scenarios.
- Two delegated outcomes live by Day 8 morning (the "OWN SOMETHING" tests):
  - **Gold standard (zero-touch):** an outcome whose criteria are
    machine-verifiable — Jehad states it, approves once, then stops touching
    it; research executes → verifier verifies → the outcome completes → the
    result surfaces naturally in briefs. Exactly one owner touch total (the
    initial confirm).
  - **Owner-judgment case:** an outcome whose criteria legitimately need
    Jehad's judgment (per D3's owner-verified path) — completes with exactly
    the initial confirm + the final judgment, nothing in between.
  Progress appearing in briefs along the way is expected but incidental to
  timing; useful completion is what's measured.
- Nightly calibration prompt still arrives; replying to it conversationally
  must work (scenario 2 live).
- Budget/latency/cost ledger reviewed Day 10 (model_calls surface) to
  confirm or trim the provisional O-10 envelope.

## 16. Metrics / acceptance criteria

Gate: `pnpm test` green (with new pins), hermetic golden suite 100%, live
golden suite ≥ 90% (was: not run live at all).

**TALK TO ME** — zero terminal canned acks on non-control turns (audit query:
no `calibration-missed`/`calibration-corrected` markers on turns that also
lack a control verb); no repeated identical outbound in a thread; owner tags
≥80% of conversational replies ✓natural over 3 dogfood days; USER PREFERENCE
≥60% vs ChatGPT baseline on the blind pairwise sample (owner-scored, ≥20
pairs).

**KNOW MY WORLD** — pertinent-emails golden passes live (content surfaced,
coverage-honest, injection-clean); planned/observed/unknown distinction held
(existing pins); "what can you access" answers match runtime-derived fixture
exactly; gmail content freshness stated in replies.

**OWN SOMETHING** — gold standard: one machine-verifiable outcome completes
delegate→execute→verify→complete with **exactly one owner touch (the initial
confirm)** and the result surfacing naturally afterward; plus one
owner-judgment outcome completing with exactly confirm + final judgment.
Brief appearances are incidental; completion-without-supervision is the
metric.

Cost/latency guardrails: p50 turn ≤6s, p95 ≤12s (superseded for the
`single` path by §22.13's tiered targets — conversational <3s / one-read
<5s / multi-step <10s p50); day-cost at sonnet-default
measured and inside re-ratified envelope (O-10); no regression in
model_routing parse compliance (route stays ≥96% until C8, then merged-pass
parse ≥96% on golden fixtures).

**The bar (§18 of the directive):** "Would Jehad voluntarily use Jin for this
instead of opening ChatGPT?" — asked daily during dogfood, answered by
behavior (the bailout log: where he actually reached for ChatGPT and why) +
the pairwise sample. Unit tests passing does not substitute.

## 17. Rollback strategy

- C7 (models): revert `gateway.passes` — one policy edit, 60s cache TTL, no
  migration.
- C1/C2/C6 (lane classes/copy): each lands behind its existing policy flag
  where one exists (`gateway.interpret`, `gateway.capture`,
  `calibration.daily`); terminal-lane removal ships with a policy
  `gateway.legacy_calibration_lanes` switch defaulting off, deletable at
  +2 weeks green.
- C8/§22: behind `gateway.routing: "single" | "legacy"` (per §22.14;
  two-pass path kept intact through the dogfood window).
- C4: `sensors.gmail.content_enabled` already exists as the kill switch; read
  tool add is additive.
- Migrations in this reset: only the small `review_refs` CHECK widening (if
  taken) — forward-only with tested down path per repo rule.

## 18. Architecture drift implications

- The reset *completes* jarvis-v1's original intent (cognition-forward
  assistant) rather than replacing D0-D3: Delegate/Watch/Verifier benefit
  directly from a conversation surface that can stage outcomes reliably.
- If C8 lands, the "route model" concept disappears; TaskProfile-style depth
  classification also dies (single cognitive model + policy tiers for cost
  only). The ig-phase-E contract docs get a superseding note, not a rewrite.
- The turn interpreter's typed-proposal contract becomes THE boundary between
  cognition and authority — the thing future harnesses (Hermes) plug into.
- Deterministic lanes converge on: authority verbs (T1-T4) + validators +
  queries. Interpretation-by-regex becomes a recognized anti-pattern; new
  lanes require a golden-scenario justification.

## 19. Open owner decisions

- **O-10 (provisional decision due Day 5 — it gates C7's Day-5 landing; the
  Day-10 dogfood ledger confirms or trims):** re-ratify the cost envelope
  for a sonnet-class conversational default (current: $5/day principal
  cap; measured sonnet is ≈$0.003/answer on bake-off fixtures and
  ~$0.005-0.015/turn is the real-thread planning band — at that band even
  a few hundred conversational turns/day sit inside $5/day, so O-10 is
  likely a confirm rather than a raise, and O-4's $40/90 stands or breaks
  on Phase-0 measured turn volume, not per-turn price; the Day-5 number
  is bake-off $/turn × Phase-0 volume — derive it, don't assume; the
  directive says quality may justify it either way).
- **O-11:** FAST tier fate — retire for conversation (recommended; at
  measured rates it saves ~$0.003/turn — sonnet $0.0031 vs 4o-mini
  $0.0001 per answer — still rounding error on a private household
  system) vs keep for lookup-only turns.
- **O-12:** the seeded address term — keep "Chief" (then "Sir" must stick via
  C2 when asked) vs re-seed to the owner's current preference.
- **O-13: RATIFIED 2026-09-24** — freeze list + 10-day timebox in force;
  W0/D4 do not resume during the reset window.
- **O-14: RATIFIED 2026-09-24 (amendment 4)** — gmail content (including
  bodies) is exposed to cognition via bounded on-demand search/read over the
  normalized records, 7-day coverage stated, untrusted-DATA boundary and
  egress policy unchanged.
- **O-15: [SUPERSEDED 2026-09-24 by §22 — triggered by the §20 first kill
  criterion firing at 100% (5 of 5 dogfood replies garbled by multi-author
  piping; model comprehension correct in all five): C8 is mandatory and is
  now the full single-author inversion, not the route+interpret merge;
  §21's recorded deferral is overtaken.]** C8 appetite — merge passes now if
  bake-off justifies, or defer to a post-dogfood window (recommended
  default: decide on Day 5 evidence).
- Carried: O-1 (hosting) unchanged; O-2/O-3 stay paused with D4 under the
  freeze.

## 20. Kill/rethink criteria

- If, after Phase 1+C7+C4 (i.e., without C8), the dogfood still fails TALK TO
  ME on naturalness/understanding ≥40% of tagged replies → the two-pass
  architecture itself (split cognition, not model class — C7 already
  replaced the minis in this branch) is the binding constraint; C8 stops
  being optional — it becomes the first mandatory work item *after* the
  reset window (§14's Day-5 descope and the 10-day box still govern
  inside it).
- If C8's merged cognitive pass cannot hit ≥96% parse validity on golden
  fixtures after 2 days of prompt iteration → revert to two-pass with
  upgraded models; the typed-proposal boundary stays either way.
- If USER PREFERENCE vs ChatGPT baseline stays <40% after the full reset on
  whichever cognitive path the ladder chose (C8 if it landed, else
  two-pass with upgraded models) → the revisited assumption is *product
  shape*, not architecture: Jin's value must come from KNOW MY WORLD + OWN
  SOMETHING (state, delegation, verification ChatGPT cannot have), and
  TALK TO ME gets relabeled "good enough, not better" rather than chasing
  general-assistant conversational supremacy.
- If owner dogfood traffic declines week-over-week post-reset despite green
  gates, the metric was wrong; re-run the pairwise preference sample with
  fresh scenarios before any further building.
- Hard stop: any security invariant (§13) weakened to make conversation feel
  better — that's not on the table, ever.

---

## 21. Execution record — 2026-09-24 (build day 1)

**Phase 0 (live DB, read-only):** 4 `calibration-missed` terminal hijacks confirmed in
the audit trail; exactly 1 `source_event_not_found` rejection — the incident-B
candidate ("when i told you to call me sir and not chief"), mechanism pinned:
`routeRow` passes an `imessage_transport_events` row id as provenance while iMessage
ingest never writes canonical `events` rows (zero exist). Tier mix measured: sonnet
already live as STANDARD (24 calls, ≈$0.0067/turn real-thread avg); FAST rare.

**Phase 1 + C4 landed (all tests green — 2314 passed / 6 skipped with
`TEST_DATABASE_URL`; eslint clean):**
- **C1** — miss + correction intakes are windowed (2h) side effects; the answer
  model always runs with a SYSTEM NOTE; duplicate-store guard; repeat-ack guard
  ("Still: " prefix, audited) in `deterministicReply`.
- **C2** — `preferenceRoutingRetype` re-types preference-shaped memory proposals
  to `configuration_directive`; interpreter knows `ownerName`/`tone` keys;
  `applyConfigurationDirective` applies real profile deltas (address term, not
  extra-directive lines).
- **C3** — capture always mints its canonical `capture.recorded` event for
  provenance (approvals can no longer hit gate-1); transport id kept for
  idempotency in `payload.metadata.transportSourceEventId`; mismatch audited.
- **C4** — `gmail.search(query, max_age_days)` + `gmail.read(message_id)` live in
  the read-tool registry (8-row/4k-char bounds, 7-day coverage, principal-scoped,
  `found:false` honesty); routing lines + self-brief coverage updated.
- **C5** — self-brief carries the real active profile version + armed-work line;
  "never claim you scheduled…" reworded to the confirm-offer reality.
- **C6** — capture ack stands alone (no `[REF]` in conversational acks); offer
  CTAs are questions ("Want me to track these 8?"); affirmation grammar
  unchanged (consent stays easy).
- **C9** — pendingState + lessons ride both answer paths; the interpreter
  receives the last 6 exchanges.
- **C10** — dormant M5B extraction lane deleted (`extractFromEvent` family,
  golden-extraction evals retired; promotion/review path untouched, verified).
- **Amendment 5** — per-type pending slots (`pendingProposals` + legacy single
  kept coherent); bare affirmatives resolve the most recent; same-turn
  multiples ask a human question ("Which one — the task list or the profile
  change?"); sibling offers survive a partial confirm.
- **C11** — 7 golden scenarios live in `evals/conversation` incl. the incident-A
  hijack replay, incident-B address flow, salience pair, pertinent-emails
  content scenario (runner gained clock/seed/audit-marker/prompt assertions).

**Phase 2 (live bake-off, spend $1.35 total against the $10 cap):**
- Track A (24×5, blind gemini judge, $0.41): opus-4.6 4.81 / sonnet-4.5 4.79 /
  gpt-4.1-mini 4.75 / gpt-4.1 4.71 / 4o-mini 4.67 — spread 0.14, **no candidate
  clears the +0.3 D-1 bar**: the answer layer was never the binding constraint.
- Capability probe (36×6, $0.93): **gpt-4.1 is the only candidate ≥96% D-2
  validity (97.2%)**, fastest (~980ms/pass), best agreement; the incumbent
  gpt-4.1-mini route/interpret measured **88.9%** (≈1 in 9 turns route-parse
  failing — a live defect now fixed); sonnet-4.5 is poor at strict route JSON
  (55.6% valid).
- **C7 applied (policy-only):** route + interpret + answer_fast →
  `openai/gpt-4.1`; sonnet-4.5 stays STANDARD/DEEP; fallbacks unchanged.
- **C8: justified but deferred (O-15 default)** — gpt-4.1 clears the D-2 bar
  and a merged pass would cut cost/latency ≥25%, but two gpt-4.1 passes are
  already ≈$0.0025/~2s; revisit after dogfood with Track B on the post-reset
  stack.

**Owner next steps:** restart api + worker (built artifacts changed); dogfood
per §15 (bailouts logged, blind pairwise sheet via `pnpm eval:bakeoff:pairwise`
when ready); Day-10 ledger check for O-10. Nothing committed — tree ready for
review.

---

## 22. Architecture amendment — the single-author conversational path

Status: amended 2026-09-24 (owner disposition: architecture/deletion-strategy/
one-author-invariant APPROVED; five surgical corrections integrated before
build — (1) round-0-only mutation window as the structural injection
invariant, (2) whole-envelope vocabulary scan deleted, (3) truth verification
covers rejected/failed ledger entries incl. forced-final attempts, (4)
provider-failure silent-drop replaced by the ledger-conditional availability
notice, (5) `interpretation` ephemeral + structured `intent` enum in audit —
plus the same-cognitive-loop terminology fix and tiered latency targets).
Originally proposed 2026-09-24 (owner directive: "no more deterministic
lanes, no more regex"), triggered by the §20 first kill criterion firing at
100% (5 of 5 dogfood replies garbled by multiple authors — model
comprehension was correct in all five; the pipeline mangled it). This
amendment supersedes the C8 description in §11 and the T1–T4 termination
rule in §4 wherever they conflict: **C8 is no longer optional and no longer
a mere route+interpret merge — it is the full inversion below.** Sections
1–20 otherwise stand (diagnosis, evidence, bake-off results, invariants,
dogfood bar).

### 22.0 Core invariant (verbatim, binding on every component)

> Cognition owns interpretation, planning, and language.
> Deterministic systems own identity, authorization, validation, canonical
> state, execution, budgets, and observed truth.
> Deterministic systems return structured facts/results and never append,
> rewrite, or substitute conversational prose.

### 22.1 Target architecture

```
user message
→ ONE cognitive pass (strong model) with context:
    thread history (untrusted) · active persona/profile fragment ·
    runtime self-brief · pending proposals (structured, with ids) ·
    open system-initiated items (calibration/probes, structured) ·
    read/tool catalog (as data: name, args, coverage) ·
    prior-round results + operation results (untrusted DATA)
→ typed envelope (§22.2)
→ deterministic control plane:
    schema validation · principal/resource authorization · grants ·
    budgets · egress · read execution · canonical writes ·
    confirmation requirements · operation/result recording
→ if reads or operations executed: actual results return to the SAME
  cognitive loop (round 0 = gpt-4.1, continuations/final = sonnet — "one
  author" means one cognitive layer owns the final prose, not one model
  binary) → next round → … → final user-facing reply
→ exactly ONE component authors ordinary conversational prose
```

Non-goals: no new framework, no generic proposal abstraction, no agent runtime.
This reuses the existing writers, validators, and read tools; it deletes the
orchestration layers above them (§22.11).

### 22.2 Envelope schema and validation semantics

The cognitive pass responds with EXACTLY one JSON object (single line, no
prose outside it):

```json
{
  "reads_requested": [
    {"tool": "commitments.waiting"}
  , {"tool": "gmail.search", "query": "plaid", "max_age_days": 7}
  ],
  "operations_requested": [
    {"type": "profile_update", "addressOwnerName": "Sir"}
  , {"type": "task_batch", "items": [{"title": "pick up suit"}]}
  ],
  "proposal_resolutions": [
    {"id": "task_batch:a1b2", "action": "apply"}
  ],
  "interpretation": "one-line reading of the user's turn",
  "reply": "final reply text — present ONLY under §22.3's finality rule"
}
```

Validation (all fail-closed; any violation → the envelope is rejected and the
model is re-prompted once with the validation error, then the turn degrades per
§22.12):

- Exact key set; unknown keys reject. Arrays bounded: ≤3 reads per round,
  ≤4 operations per turn, ≤2 resolutions per turn.
- `reads_requested[].tool` must be in the catalog; per-tool arg validators
  reuse the existing strict parsers (e.g. gmail.search query 1–120 chars).
  The catalog itself is data injected into the prompt — the model cannot
  invent tools; unknown names reject.
- `operations_requested[].type` must be in the typed registry (§22.4). Each
  op carries its own validator, ported from the existing `coerceProposal`
  family (title/due bounds, redaction at parse — unchanged data hygiene).
  Validation is STRUCTURAL: type registry membership, arg shapes, bounds.
  There is NO vocabulary scan of envelope text — `reply`,
  `interpretation`, task titles, and ordinary payload text are never
  pattern-censored (owner correction 2, 2026-09-24: "what model are you
  using?" and a task titled "compare OpenAI and Anthropic" must pass;
  the whole-envelope forbidden-word scan is deleted as scar tissue —
  authority is prevented by schema absence and structural validation,
  not by word policing).
- **Mutation window (owner correction 1, 2026-09-24 — the oldest injection
  invariant, made structural):** `operations_requested` and
  `proposal_resolutions` are legal ONLY on envelopes emitted while the
  context contains NO executed external read result. Practically: round 0
  (and its validation re-prompt, if any) may propose mutations and resolve
  proposals — authenticated user intent is authority. Once ANY read result
  has entered context, continuation envelopes are read-and-final only; an
  op or resolution presented there is a validation error, recorded as
  rejected data, never executed. If retrieved data suggests an action, Jin
  recommends it in prose and the user authorizes it on the NEXT user turn;
  pre-authorized autonomous work over retrieved data is Delegate/Outcome
  machinery, not the conversational loop. (Thread history keeps its
  untrusted-rendering discipline — flattening, boundary markers, ADR-0014 —
  exactly as today; the window gates external READ results, not history.)
- `proposal_resolutions[].action` ∈ {`apply`, `decline`} (exact strings;
  `decline` removes the pending proposal without applying — the cleanup
  path for stale offers; anything else rejects). `.id` must be a live
  pending id (format `<type>:<4-hex>`), owned by the authenticated
  principal, unexpired (24h TTL), of an allowed type for this principal.
  Code resolves by identity — it never infers which proposal the user
  meant. The ≤2-resolutions/turn bound vs §10's multi-proposal rule:
  deliberate same-message resolutions beyond two (rare) complete over
  subsequent turns; ambiguity between live referents is the model's
  clarification to ask (§22.6), not a reason to raise the bound.
- `interpretation` ≤200 chars — EPHEMERAL: consumed within the turn's own
  rounds, NEVER persisted anywhere (owner correction 5, 2026-09-24 — no
  free-text diary of private messages in `audit_log`). The durable audit
  row carries `intent` instead: a structured enum
  {question|directive|preference|correction|feedback|delegation|capability|
  chat} plus ids/counts/statuses per the repo's data-minimization
  convention. Audit rows never store free-form interpretations of user
  content.
- `reply` ≤1500 chars (the edge render cap).
- The envelope never carries authority: no model ids, no budget changes, no
  read-source grants — those keys don't exist in the schema, so the model
  cannot request them (schema absence is the guarantee; unknown tool names
  and op types reject structurally, as unknowns — not as forbidden
  vocabulary).

### 22.3 Reply-finality rule (mechanical, not advisory)

The deterministic loop ships `reply` to the user ONLY when the envelope has:

1. `reads_requested` empty, AND
2. no `operations_requested` whose execution result is not yet in the
   round's context (every op class in §22.4 is `results_needed: true`), AND
3. no `proposal_resolutions` whose execution result is not yet in the
   round's context.

Otherwise `reply` is ignored entirely (not shown, not stored as the outbound)
and the loop continues: execute reads/ops → results into context → next round.
This makes "I need to pull the full list" structurally impossible to ship —
such a sentence may only ever exist in a round whose envelope ALSO requested
the read, in which case the reply is discarded by rule.

**Terminal guarantee:** the forced-final round (round-cap or wall-clock,
§22.5) ships its `reply` unconditionally — any reads/ops/resolutions that
envelope still requests are over-budget by construction and are recorded as
rejected data, never executed — so a non-compliant final envelope cannot
withhold the turn's only reply or spin the loop. Every cognitive turn
therefore ends in exactly one user-visible output: a final-round `reply`,
or a §22.10 notice (the §22.10.6 turn-completion availability notice when
even the degrade round yields nothing shippable, and the mid-loop
provider-failure notice per §22.12 — owner correction 4, 2026-09-24:
there is no zero-output path; a provider failure mid-loop now ships the
same ledger-conditional availability notice class instead of a silent
drop).

**"Executed" is defined once, mechanically:** an operation is executed when
its deterministic writer has run to a recorded terminal outcome — `applied`,
`parked` (with id), `queued`, or `failed` (with reason). **Parking IS
execution**: a task_batch that parks returns `{status:"parked",
id:"task_batch:a1b2"}` to cognition, and the next round's envelope — no
reads, no ops, no resolutions — ships the offer in the model's own words
("Want me to track these 8?"). A parked-but-unconfirmed op therefore never
holds the turn open and is never "unexecuted"; the loop cannot spin on a
park. The `results_needed` column is uniformly `true` and stays so by
contract — it exists so any FUTURE op type must explicitly justify
fire-and-forget (`false`), the only shape ever allowed to ship a reply in
the same envelope as an unresulted op.

### 22.4 Operation classes and confirmation policy

| class | types | execution | results_needed | confirmation |
|---|---|---|---|---|
| read-only | the read catalog | immediate, policy-gated | true | never |
| low-risk self-preference | `profile_update` (address term, tone/register note, brevity, emoji pref, extra directive) | immediate via `nextProfileVersion(via:'self')`; **round-0 envelopes only** (§22.2 mutation window) | true | never — no refs, no staging, no second approval |
| reversible ordinary | `task_batch` (parks as offer), `reminder_create`, `reminder_reply`, `commitment_transition`, `occurrence_update`, `calibration_feedback`, `system_feedback`, `memory_candidate` (→ review queue) | per-type below; **all round-0 only** (§22.2 mutation window) | true | per-type below |
| consequential | `calendar_action`, `outcome_spec`, `cross_principal_profile` | park (system-issued token, returned to cognition as data); **round-0 only** | true | ALWAYS — token issuance/expiry and the §22.10.3/4 verify lanes unchanged; the MODEL authors the confirmation ask (quoting the token verbatim) as a continuation round with the parked intent + token in context — no canned ask string survives the cutover |

The mutation window (§22.2) is the injection invariant made structural:
ops and resolutions derive ONLY from the authenticated user turn (round 0);
anything the loop reads afterward is data. Continuation rounds that want an
action recommend it in prose; the user's next turn is the authority.

Per-type execution policy for reversible-ordinary:

- `calibration_feedback`, `system_feedback`, `occurrence_update` (user-declared
  observation), `reminder_reply` (resolving a check-in the system opened),
  `commitment_transition` (done/missed/renegotiated on a commitment the model
  named from visible data): **apply immediately** — the user's message IS the
  instruction; worst case is an easily-corrected state write.
- `reminder_create`: apply immediately (explicit imperative).
- `task_batch` (multi-item): **parks as a pending proposal** with a
  deterministic id; cognition asks for the yes in its own words; a later
  `proposal_resolutions` applies it. Parking is execution (§22.3): the park
  result returns and the SAME turn ships the model's offer — the loop does
  not wait for (or spin on) the user's yes. Single-item explicit asks should
  use `reminder_create`/`commitment` ops instead — the model is told this.
- `memory_candidate`: writes to the review queue immediately (existing
  force-review semantics) — capture is a record, not a mutation of behavior.

Self-profile semantics (the incident-B fix, final form): address is
single-valued — a set replaces (setting "Sir" retires "Chief" atomically;
`removeAddress` is a separate op the model emits only when the user asked to
stop being called something without replacement; set+remove combos reject).
All values pass the existing profile validators (name-shape door, forbidden
vocabulary). One profile version per turn (ops coalesce). The applied result
("profile v9: address=Sir") returns to cognition, which says so in its own
words. Cross-principal profile ops (`cross_principal_profile`) keep the
owner-gate + policy-allowlist activation honesty exactly as today.

### 22.5 Bounded multi-step read loop

Hard budgets per turn (deterministic, audited when hit):

- ≤3 cognitive rounds total (round 0 + 2 continuation rounds);
- ≤4 read-tool executions total across rounds;
- ≤1 envelope-validation re-prompt; truth path bounded per §22.9 (one
  verification + one regeneration + one forced-final);
- wall-clock guard: if elapsed >20s at a round boundary, the next round is
  forced final ("answer now with what you have; state coverage honestly").
  Boundary-only by construction [labeled residual, accepted]: a single slow
  round (round 0 included — no prior boundary exists to check) can overshoot
  20s; the overshoot is bounded by the per-call provider timeout and the 90s
  typing-bubble TTL, and is NOT covered by §22.13's targets. Worst-case turn
  = 7 model calls (3 rounds + 1 validation re-prompt + verification +
  regeneration + forced-final), ≈$0.02 at sonnet-class rates; the loop is
  bounded in dollars by the unchanged per-principal rolling-hour/UTC-day
  caps — the existing callModel budget math enforces the ceiling mid-turn,
  fail-closed (§22.10.6). Sonnet rounds ≤2 by the round cap itself (round 0
  is gpt-4.1; only continuation/final rounds escalate). Chitchat stays one
  gpt-4.1 call.

Round k context = base context + every prior round's executed results (DATA
blocks, untrusted) + operation results + remaining budgets stated as data
("reads remaining: 1"). Escalation by round index (deterministic, not
language-based): round 0 runs on the fast/standard pass model (gpt-4.1);
any continuation round and the final round run on the answer-standard model
(sonnet-4.5). This replaces `classifyAnswerDepth`'s synthesis-marker regexes —
depth is chosen by observed round count, which is a number.

Deterministic instruction strings ("answer now with what you have…",
validation errors, verification findings) enter prompts and context ONLY —
they are never shipped prose. The complete set of deterministic text a user
can ever receive is §22.10's lane list; everything else is the final
cognitive round's `reply`, byte-for-byte.

### 22.6 Proposal-resolution semantics

Pending proposals live in thread metadata (per-type `pendingProposals` slots
as at HEAD [PROVEN: threads.ts]; this amendment ADDS the id, a 24h expiry,
and the parked-at turn sequence — none of the three exists today, so "as
today" applies to the slot shape only). Each entry carries a deterministic
id (`<type>:<4-hex>`), `expiresAt`, and the inbound-sequence number of the
turn it was parked in (refreshed if re-offered) — so "age in turns" is a
number computed from recorded sequence, not timestamp heuristics. The
cognitive context lists them (id, type, one-line summary, age in turns).
The MODEL decides relevance and referent ("yes, do that" → it emits the
id). Deterministic code validates exactly: identity (live id), ownership
(authenticated principal), expiry (24h TTL), type permission, and **consent
class** — `apply` is legal only on non-consequential types; a resolution
naming a consequential park (`outcome_spec` — a `ThreadPendingProposalType`
at HEAD, `threads.ts:340-345` — calendar, cross-principal) rejects with the
failure returned as data, because consequential types resolve exclusively
through their §22.10.3/4 token lanes — and rejects otherwise (the model is
told the resolution failed and why, as data, and re-rounds). The consent-class
bar is structural (a type-set check, not a heuristic): without it, the four
identity checks would let an envelope `apply` a consequential park without
its ALWAYS-confirm token — an authority hole, closed here and pinned in G7. Salience is DATA, not a gate: the owner's §10
multi-proposal rule (exactly one salient → resolve; several plausibly
live → ask a human question) is enforced by cognition seeing ages and
offering its own clarification — a hard "offered within the last 3 turns"
cutoff in code would falsely reject a legitimate "yes, that task list from
this morning" inside the 24h TTL and reintroduce interpretation-by-rule.
If cognition judges the referent genuinely ambiguous, it asks a natural
clarification and emits no resolution. Pending state is NEVER auto-appended
to any reply; relevance is cognition's call. A proposal resolved, declined,
or expired is removed; siblings persist.

### 22.7 Pending-state contamination guard

Context carries pending proposals as structured data with ages. The prompt
states: "mentions of prior offers are your own words from history; nothing is
auto-appended." Golden test (§22.15-G4) pins that a turn two topics away from
a pending offer produces a reply with zero offer/protocol vocabulary.

### 22.8 Context given to cognition (exactly)

persona fragment · self-brief · read catalog (names, args, coverage
sentences) · thread history (existing renderer, untrusted) · pending
proposals (structured) · open system-initiated items as structured state
(tonight's calibration item + whether its reply window is live; any live
check-in probe — §22.10's "4"-rating case and §22.4's `reminder_reply`
both depend on this being present) · per-round results (untrusted DATA with
provenance + coverage) · operation results (typed) · side-effect notes
(e.g. "calibration miss recorded for today") · budget state as data.
Nothing else. No
`pendingStateLine` prose injection, no lessons block duplication (lessons
ride the persona fragment's directive lines as today, or drop — builder's
call, but only one copy).

### 22.9 Truth verification replaces claim-audit prose policing

ADR-0015's lying-defense survives with its mechanism replaced:

- The final reply is checked against the typed execution ledger by ONE
  verification call (the answer-class model, cheap bounded prompt: reply +
  operations/results ledger JSON — including REJECTED and FAILED entries —
  → verdict `consistent | contradicts: <finding>`). Runs whenever the turn
  has ANY operation/resolution ledger activity — executed, failed, or
  rejected (owner correction 3, 2026-09-24: a forced-final round whose
  `reminder_create` was rejected as over-budget must not be able to ship
  "Done, I set the reminder" — the verifier sees the rejected ledger entry);
  and ALWAYS on a forced-final turn that attempted any op or resolution.
  Pure-chat turns with an empty ledger stay unverified (cost + latency).
- `consistent` → ship. `contradicts` → ONE regeneration, prompt = original
  context + results + the finding ("your draft claimed X; results show Y;
  produce the truthful reply"). Ship the regeneration (still one author).
  A second contradiction → ONE forced-final round carrying both findings;
  if that reply STILL contradicts, ship it with ledger verdict
  `contradicted_unresolved` (it flows to the owner's ✗-review harvest) —
  the system never substitutes deterministic prose to paper over a lie.
  Bounded per turn: one verification + one regeneration + one forced-final.
- Scope [labeled limitation, accepted]: verification fires only on turns
  with ledger activity (above). A zero-ledger turn where the model
  fabricates a mutation out of thin air ("I deleted your old tasks") is not
  mechanically checked — that is the price of deleting regex output
  policing. Backstops: the confirm-offer honesty rule in the prompt +
  self-brief ("mutations happen only through explicit confirmations");
  prior ops appear in history only as shipped-and-verified text; golden
  pins sample the class. Residual risk accepted; revisit only if dogfood
  ✗-tags show it live.
- All regex claim patterns, `truthfulReplacement`, `safeFallbackRendering`
  prose, and `stripMachineryLines` are DELETED. No deterministic string ever
  edits user-facing prose again.
- Findings ledger on `converse.claim_audit` continues (verdict + finding),
  preserving SV3/lesson-harvest raw material.

### 22.10 Terminal deterministic lanes that remain (complete list)

1. Attachment-only inbound (channel cannot render).
2. `/new`, `/reset` (exact match).
3. Review control verbs with refs: `approve|reject|snooze <REF>`, `queue`
   (exact grammar + token lookup — the system answering its own issued
   tokens).
4. Calendar `confirm|cancel <CODE>` (system-issued token, security gate).
5. `guests` (exact).
6. Budget/egress/grant denials with the existing honest notice; plus
   turn-completion failure (envelope invalid twice AND the degrade round
   yields no shippable `reply`) and mid-loop provider failure (§22.12):
   fixed availability notice — ledger-conditional ("nothing was changed"
   only when the turn's executed-op/resolution ledger is empty; otherwise
   "actions already completed stand as recorded"). Audit row always
   (security/availability).
7. Bad-ref lockout; rate-limit notice (existing).

Nothing else terminates. No lane interprets natural language. If a message
doesn't match 1–7 exactly, it reaches cognition — including one-word replies,
ratings ("4" becomes a `calibration_feedback` op if the model judges the
nightly prompt open — it can see the open-item state, §22.8), and
corrections.

Boundary with §22.0: lanes 1–7 are **authority and security notices**, not
conversational prose — the system's own voice answering tokens it issued or
denying resources it owns (a budget/egress denial fires precisely when
model calls are unavailable, so no other author exists; the turn-completion
notice fires precisely when the author has demonstrably failed — two
invalid envelopes plus a degrade round with no shippable reply — so no
other author exists there either). They replace the turn entirely and
never mix with model output. This list is the COMPLETE
exception to "deterministic systems never author user-facing text"; every
other outbound string in the system is the final cognitive round's `reply`.

### 22.11 Deletable after cutover (the deletion list)

From `conversation.ts`: the route pass + `buildRoutingPrompt` +
`parseRouteJson`/`parseRouteReadSet`/`isRouteNoneJson` wiring; the interpret
pass wiring; `parseProposalConfirm` + `parseProposalAffirmation` + the confirm
pre-pass; `parseCalibrationRating`/`Correction`/miss routing; the profile
fast-path (`parseProfileDirective` lane) and with it the `yes, keep it`
stance-persist lane (`conversation.ts:1280-1327`, §2 lane 9) — `profile_update`
applies immediately with no staging (§22.4), so the thread-local-vs-persistent
distinction, its "reply: yes, keep it" CTA, and the stance it consumes die
together (no new stances are minted once nothing stages; existing `lastStance`
metadata stays parseable as inert legacy data); the retract lane (`RETRACT_RE`
at `conversation.ts:666`, fired at 1215-1238 with its canned "Changed — I've
dropped that (…) What instead?" reply; §2 lane 7) — changing one's mind is
cognition's behavior over history + pending proposals as data (a pending offer
dies via `proposal_resolutions{action:"decline"}`; a plain conversational
retraction is just a reply — no op, no regex); occurrence/skip verb lanes;
`parseProbeReply` lane; `parseReminderPhrase` lane; commitment-verb lane;
capture lane wiring (`matchCaptureIntent` detection — the op replaces it);
`pendingStateLine`; `augmentReadSetForAsk`; the repeat-ack guard (moot — one
author with history doesn't parrot; delete, keep the audit).

Both newly listed lanes are deletions, not §22.10 entries: neither is a
security/authority notice answering a system-issued token — both are
interpretation-by-regex over user text ending in canned conversational prose,
the exact §22.0 violation class, with their semantics fully absorbed
(keep-it → `profile_update`; retract → decline-resolution or plain reply).
From `calibration-verbs.ts`: rating/correction grammars (constants may remain
for the op validator's enum). From `capture.ts`: detection regexes
(`considerCapture` shrinks to the op-side writer). From
`turn-interpretation.ts`: the interpreter prompt + `parseInterpretationJson`
+ `renderProposalOffer` + `preferenceRoutingRetype` (op vocabulary replaces
it); the `coerce*` validators and `apply*` bridges SURVIVE as the operation
executors. From `claim-audit.ts`/`truthful-ux.ts`: everything regex-based.
From `model-selection.ts`: `classifyAnswerDepth` + `hasSynthesisMarkers`
(round-index escalation replaces them; `answerModelForTier` survives for the
round policy). Terminal classes in `deterministicReply` shrink to §22.10. Every name above
exists at HEAD f75d1e2 [PROVEN — grep-verified this review]. Net effect
[LIKELY — verified by target count, not measurement]: conversation.ts loses
roughly half its mass; the only new modules are `cognitive-turn.ts`
(envelope schema + validators + loop) and one verifier module — validators
are the ported `coerce*` family and executors are the surviving `apply*`
bridges, so the additions are orchestration + schema, not re-written
cognition. If the landed diff needs a third module, that is a review flag,
not a fait accompli.

### 22.12 Failure semantics

| failure | behavior |
|---|---|
| read unavailable/errored | result `{"tool":…,"error":…}` returned as data; model told to answer with the coverage gap honestly or spend a remaining read on an alternative tool |
| partial result | existing per-tool coverage/truncation flags ride along; model narrates coverage |
| mutation failed (writer error/policy) | op result `{failed, reason}` recorded + returned; model narrates honestly ("that didn't land — nothing changed") |
| ambiguous referent | model asks a natural clarification; emits no resolution/op |
| envelope invalid | one re-prompt with the validation error; second failure → degrade: no ops execute, single final round forced ("you could not produce a valid plan; answer conversationally and honestly"); if the degrade round itself yields no shippable `reply`, the turn ends with §22.10's turn-completion availability notice (fixed string, ledger-conditional clause per §22.10.6) + audit row — no deterministic CONVERSATIONAL fallback exists for this path (a canned reply would be the system authoring conversational prose, §22.0's exact violation; an availability notice is not conversation — it is the budget-denial class, replacing the turn, never mixing with model output; the inbound is thread-recorded, the audit row is the owner's ✗-harvest signal) |
| truth contradiction after regeneration | forced-final round with both findings; still contradicting → ship flagged `contradicted_unresolved` (§22.9 ladder — never deterministic prose) |
| budget exhaustion (requests/day, cost) | existing terminal denial + honest notice (§22.10.6) |
| iteration/wall-clock limit | forced final round; coverage honesty required |
| provider failure mid-loop | §22.10.6 availability notice (ledger-conditional variant) + audit row; the inbound is thread-recorded; consequential parks remain durable (owner correction 4, 2026-09-24 — no silent drops: every cognitive turn ends in exactly one user-visible output; the notice is the availability class, not conversational prose) |

### 22.13 Latency targets and round caps

Tiered targets (owner correction, 2026-09-24 — intelligence over a forced
flat bound, but bar and metric must agree; supersedes §16's p50 ≤6s/p95
≤12s line for the `single` path):

- conversational (single round, gpt-4.1): p50 < 3s;
- ordinary one-read turn (round 0 + reads + one sonnet round): p50 < 5s;
- multi-step (2–3 rounds): p50 < 10s, p95 < 15s.

Typing-bubble presence TTL already 90s. Caps: §22.5. Measured at dogfood;
multi-step p95 breach two days running → trim continuation rounds to 1 or
pre-warm common read sets (owner call, not silent).

### 22.14 Feature flag / rollback

`policy.yaml` `gateway.routing: "single" | "legacy"` (default `legacy` until
§22.15 passes hermetically; flip to `single` for dogfood; delete `legacy` +
the flag + §22.11's list after 2 weeks green). Rollback = one policy edit
(60s TTL), no migration. Both paths share: handleInbound shell (grants,
budgets, locks, notifications, thread writes), read tools, writers, bridges —
the flag selects only the turn-orchestration core.

Two rollback hazards found in code [PROVEN, `threads.ts:643-672`]:
`parsePendingProposal` is a strict fail-closed parser that (a) rejects any
entry key outside `{type, at, payload, offered}` and (b) RECONSTRUCTS a fresh
4-key object on success (return at `threads.ts:666-671`). Hazard 1: if the
`single` path writes `id`/`expiresAt`/parked-at-sequence entries, the SHARED
metadata parse dies on every thread `single` has touched — breaking the
dual-path window itself, not just rollback. Hazard 2: widening the allowed
key set alone is insufficient — allow-without-carry silently STRIPS the new
fields on any legacy write-back (sibling clear, offer refresh, amendment-5
merge; every legacy read-modify-write serializes the reconstructed object —
e.g. `retractLastStance` at `threads.ts:521-537` copies the parsed entries
through), killing `single` resolutions after any legacy turn mid-window.
Required ordering and shape: widen the shared parser AND extend the returned
`ThreadPendingProposal` so legacy round-trips PRESERVE (not merely tolerate)
`id`/`expiresAt`/parked-at-sequence, BEFORE the first `single`-path write
(legacy-shaped entries still parse; thread metadata is JSON, no migration).
Dual-window provenance gap: entries parked by `legacy` carry no id — `single`
derives one deterministically at read time (hash of type + `at`; unique
because slots are per-type, at most one live entry per type) and treats age
as unknown-but-unexpired, so legacy-parked offers stay resolvable after a
flag flip; a missing id never fails the turn. Pins: a threads integration
test round-trips both legacy-shaped and id-bearing entries through BOTH
paths, and one pin drives a legacy WRITE-BACK on an id-bearing entry (sibling
clear or offer refresh) then resolves it under `single`.

### 22.15 Golden + adversarial acceptance (hermetic, scripted envelopes)

- **G1 to-do loop (the critical case):** after `/new`, "what's on my to do
  list" → round 0 requests `commitments.waiting` — which IS the detail read
  at HEAD (the kept dogfood fix returns `open: [items]` with an
  `openTruncated` flag; no `commitments.list` tool is added — the earlier
  hedge is resolved by spec). Scripted REAL shape: 7 open items with titles
  → the loop completes in one continuation round → final reply contains the
  titles; with `openTruncated: true` scripted, the reply states the
  truncation. Robustness sub-pin (sparse-data recovery): scripted OLD shape
  returning ONLY `{otherOpenCount: 7}` → round 1 MUST request a detail read
  (re-request `commitments.waiting`, which the catalog documents as
  list-bearing) → scripted 7 records → titles in the final reply. Pins:
  ≥2 rounds occurred on the sparse variant; final contains ≥5 titles;
  `reply_not_contains` "pull the full list", "tell me to go ahead", any
  proposal-id/`<type>:<hex>` pattern, "pending", "confirm code".
- **G2 preference (the second critical case):** "don't call me Chief, call me
  Sir if anything" → envelope op `profile_update{addressOwnerName:"Sir"}`
  (no `removeAddress` combo) → applied through `nextProfileVersion` → result
  returns → final reply is natural ("Done — Sir it is." class); db_pin:
  profile v+1 with address.ownerName='Sir'; `reply_not_contains` "staged",
  "ref", "approve", "ownerName". Next turn uses Sir.
- **G3 hijack replay** (incident A): evening window, open calibration item;
  conversational turns answer naturally; `calibration_feedback` op recorded
  as side effect; no canned ack; no identical outbound twice.
- **G4 salience/contamination:** pending task_batch offered turn 1; turns
  2–3 on another topic → zero offer vocabulary; turn 4 "yes do that" →
  resolution id applies the batch; db_pins exact. Decline leg (retraction
  absorption — §22.11's retract deletion rides on this path): turn 5 stages
  a fresh task_batch park (scripted op result); turn 6 "actually no, drop
  that" → `proposal_resolutions{action:"decline"}` removes the entry;
  db_pin: no pending task_batch remains; reply natural, zero protocol
  vocabulary. Park-flow amendment: turn 1
  also pins §22.3's park-is-execution rule directly — the task_batch op
  result `{status:"parked", id}` is present in the continuation round's
  context, the SAME turn's outbound is the model's own offer with no rendered
  CTA (asserted against the deleted `renderProposalOffer` constants via G5's
  eval-time blacklist), and the db_pin carries the parked id.
- **G5 one-author pin:** across all scenarios, outbound content matches the
  final round's `reply` byte-for-byte; a canned-string blacklist (the deleted
  constants) never appears — asserted by the TEST suite at eval time only,
  never by runtime string-scanning of outbound prose (that would resurrect
  the claim-audit this amendment deletes).
- **G6 injection (restructured per owner corrections 1–2):** (a) unknown
  tool name rejects structurally (as an unknown, not forbidden vocabulary);
  (b) model/provider mentions in `reply`, `interpretation`, and task titles
  are LEGAL — golden: "what model are you running?" answers honestly and a
  task titled "Compare OpenAI and Anthropic pricing" round-trips through
  ops unchanged; (c) ops derived from external read data cannot mint
  mutations of ANY class — the §22.2 mutation window is the structural
  guarantee (a scripted continuation-round envelope carrying
  `profile_update`/`reminder_create`/`commitment_transition` after gmail
  content entered context rejects as data, nothing executes, golden reply
  recommends-and-waits); (d) pending-proposal payloads re-validate
  identically at apply (existing pins port).
- **G7 authority:** no envelope field can alter budgets/models/grants (schema
  absence pin); `cross_principal_profile` from non-owner refuses honestly;
  `proposal_resolutions{action:"apply"}` naming a consequential park
  (`outcome_spec`/calendar/cross-principal id) rejects as data (§22.6's
  consent-class bar) — the park survives untouched, the §22.10.3/4 token lane
  remains its only applier.
- **G8 loop bounds:** scripted model always requesting more reads → exactly 3
  rounds / 4 reads, then forced-final reply exists (its own late requests
  recorded as rejected data, never executed — §22.3's terminal guarantee);
  wall-clock guard pinned via injected clock.
- **G9 failure honesty:** op-writer failure → model narrates the failure;
  read error → coverage-honest answer; envelope-garbage → degrade path
  (incl. the degrade-round failure: §22.10's availability notice ships
  verbatim + audit row, §22.12; both notice variants pinned — empty-ledger
  asserts nothing-changed, prior-round-ops variant asserts the recorded
  actions stand); provider-failure mid-loop → the same notice class ships
  (both ledger variants pinned; no zero-output turn exists anywhere).
- **G10 truth ladder (§22.9 pinned end-to-end):** scripted verifier verdicts
  `contradicts` → regeneration `contradicts` → forced-final still
  `contradicts` → the THIRD model draft ships byte-for-byte with ledger
  verdict `contradicted_unresolved` — no deterministic substitution anywhere
  in the chain (every scenario outbound equals the final round's `reply`, G5).
  Rejected-ledger leg (owner correction 3): a scripted forced-final envelope
  requesting `reminder_create` (rejected as over-budget) whose reply claims
  the reminder was set → verifier flags against the REJECTED ledger entry →
  regeneration ships truthful ("that didn't land — nothing was set" class).
- **Runner extension (build item owed by this section — G1/G8 and the G10
  scripting are unimplementable without it):** (a) `scriptedDispatch`'s pass
  classifier (`evals/conversation/runner.ts:68-111`) keys on the
  route/interpret prompt markers — both prompts die per §22.11 — so the
  runner gains new pass kinds for cognitive rounds and the §22.9 verification
  call, with per-round script entries (round-indexed, not marker-indexed);
  (b) a read-result override injected at the tool boundary, because G1's
  sparse variant (old shape returning only `otherOpenCount`) is not
  producible by DB seeding — the tool at HEAD always emits `open:` alongside
  (`read-tools.ts:546-560`); (c) the already-anchored clock must thread the
  loop's wall guard (G8's injected-clock pin depends on it).
- Existing C11 scenarios port to envelope-scripting; the suite runs against
  BOTH paths while `legacy` exists.

### 22.16 Live dogfood acceptance

Unscripted, owner-judged, ≥3 days: (1) the to-do question after `/new`
returns titles in one exchange; (2) a preference phrasing of the owner's
choosing applies in one turn; (3) the 20:30–22:30 window holds real
conversation; (4) zero machinery vocabulary in any reply unless a
consequential action genuinely requires authorization; (5) the owner's
✗-transcripts become new G-scenarios. Bar: "would I rather open ChatGPT"
bailout rate vs the §15 baseline.

### 22.17 Critical acceptance cases (normative, restated)

The §22.15-G1 and §22.15-G2 transcripts are the acceptance bar in exactly
the form the owner specified: the loop must recognize an unsatisfied goal
and complete it invisibly; the preference must be understood generically,
applied canonically, and confirmed naturally — with no staging, no refs, no
`ownerName=Sir` semantic noise, and no user-visible protocol of any kind
unless real authorization is required.

### 22.18 What this amendment does NOT change

§12/§13 invariants entire (grants, egress, budgets, confirm-for-consequential,
builder≠verifier, canonical DB, provenance, injection boundary — now enforced
structurally by the §22.2 mutation window — retention); D0–D3 machinery;
briefs; reminders' semantics; the review queue's role for memory promotion;
the notification conjunction; thread storage (ADR-0014). Owner disposition
2026-09-24: BUILD APPROVED behind `gateway.routing = legacy|single` once the
reviewer verifies the five corrections are integrated correctly.

---

## 23. Execution record — single-author cutover (2026-09-24, build day 2)

**Built (owner directive: "no more deterministic lanes, no more regex"; §22 as
amended by the five owner corrections):**
- `cognitive-turn.ts` — the loop: round-index escalation (gpt-4.1 round 0 →
  sonnet continuations/final), §22.3 mechanical finality (parking IS
  execution), §22.2 mutation window (ops/resolutions legal only before
  external read results enter context — later attempts become rejected
  ledger data), §22.5 caps (3 rounds / 4 reads / 1 re-prompt / 20s wall —
  wall reads the injected clock fresh per boundary), degrade + terminal
  guarantee, §22.10.6-class availability notices (ledger-conditional; no
  zero-output path), budget lanes shared with the legacy shell.
- `operations.ts` — the 12-type operation registry (strict validators, no
  vocabulary scans: model-identity conversation and "compare OpenAI and
  Anthropic" titles parse legally), envelope parser (explicit `reply: null`
  accepted), consent-class bar, executors delegating to the existing
  canonical bridges (park semantics for task_batch/outcome_spec/calendar).
- `truth-verifier.ts` — §22.9 ladder: ledger-based verification including
  rejected/failed entries (owner correction 3), one regeneration,
  forced-final with findings, `contradicted_unresolved` ship flag; fail-open
  parse (a broken verifier never blocks shipping).
- `threads.ts` widened FIRST (the §22.14 rollback hazard): pending entries
  carry `id`/`expiresAt`/`parkedAtSeq`, legacy round-trips preserve them,
  `pendingWithDerivedIds` derives ids for legacy-parked offers.
- `conversation.ts`: `gateway.routing` dispatch after the shared §22.10
  lanes; all legacy-only lanes guarded `routing !== "single"` (not yet
  deleted — the §22.11 deletion lands after the 2-week green window).
- Eval runner: envelope-scripting (`path: single`, round-indexed cognitive/
  verify kinds), read-result overrides at the tool boundary,
  ledger/rounds/intent observations, `cognitive_turn` capability probe.
- **Golden G-suite green against the REAL loop (9/9)**: G1 full + sparse
  (the to-do loop recognizes an unsatisfied goal and fetches titles
  invisibly), G2 ("don't call me Chief, call me Sir" — profile_update
  applies canonically in one turn, result returned, natural reply, zero
  staging/refs), G4 park + decline-by-id, G6b model-identity legality, G6c
  mutation-window injection pin (email-derived profile_update rejected,
  nothing mutates), G8 loop bounds with forced-final.

**Cut over:** `policy.yaml` `gateway.routing: single` (LIVE for dogfood).
Legacy suites pinned to `legacy-routing.fixture.yaml` via the established
`POLICY_YAML_PATH` seam (they pin the ROLLBACK path, which stays intact and
green). Full suite: **2421 passed / 6 skipped**; eslint clean. Rollback =
one policy line (60s TTL, no restart, no migration).

**Deferred to the post-green deletion pass (§22.11):** physically deleting
the legacy lanes/regexes/post-processors. Until then both paths ship in the
tree behind the flag.


---

*The shortest path from today's system to an assistant Jehad wants to talk to
every day is: stop the lanes from interrupting him (C1/C2/C6), show him what the
system already knows (C4/C5/C9), and put a strong model behind the one
cognitive pass that talks back (C7, C8 if earned). Everything else — the
safety, durability, delegation, and verification machinery D0-D3 built — is
already worth keeping.*


## Resolution record (turn 5, drafter — all six proposals integrated; section retired)

Proposal 1 (availability notice) integrated with one honesty correction found
on verification: "nothing was changed" is NOT guaranteed turn-wide on the
degrade path — §22.2 permits reads+ops in one envelope and §22.4 applies
reversible-ordinary ops immediately, so a later round can enter degrade after
prior-round ops executed. The notice's nothing-changed clause is therefore
ledger-conditional (§22.10.6, §22.12 row, G9 pins both variants) — the same
honesty constraint the proposer itself applied to keep provider-failure
silent-drop. Proposals 2–6 integrated as spec'd (decline pin G4; §22.7→G4
ref; O-15 superseded with the 2026-09-24 §20 trigger; §22.3 terminal
guarantee incl. rejected-data recording, echoed in G8; both editorial fixes).
§22.0 verbatim invariant untouched.
