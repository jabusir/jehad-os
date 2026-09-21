# Jarvis V1 — Intelligence Plan

Status: proposed (awaiting owner verdict)
Date: 2026-09-21
Grounding: audits of HEAD `c65ec8a` (post-calibration wave), 1,511 tests green, migrations 000–016
Scope: **planning only.** No implementation before owner acceptance.

---

## 1. Executive Summary

Jehad OS feels like "a secure workflow engine with an LLM attached" because, at the conversation surface, **that is literally what it is**. The audits found four concrete root causes:

1. **The router is blind and the answer pass is amnesiac-by-design.** The route pass prompt contains *only the user's message and a tool list* — no history, no thread state (`conversation.ts:205-221`). "What about the second one?" routes with zero referent context. The answer pass gets raw message history and *at most one* read-tool result. Nothing assembles a picture.
2. **Memory is write-only.** Capture → review → canonical writes work, but no code path ever reads evidence, decisions, procedures, or semantic memory back into a conversation. The system remembers by filing and never recalling.
3. **The answer model is the cheapest tier.** `gateway.passes` defines `route` and `route_fallback` only; the answer pass falls through to the principal default (gpt-4o-mini). The model-routing wave optimized the *router*; nothing ever upgraded the *reasoner*. There is no DEEP path.
4. **Intelligence machinery exists but is disconnected from the chat.** `packages/core/src/queries/` already implements waiting-on, blocked/stalled, transitive-leverage ("best unlock"), and what-changed — the exact ingredients of "what's going on?" — but conversation exposes only four narrow read tools (`calendar.day`, `calendar.next`, `commitments.waiting`, `gmail.recent`). Briefs use the query layer; chat cannot.

Secondary causes: no persona (one hardcoded utilitarian prompt for every principal), no prioritization ("the one thing" is answerable by the leverage query and never asked), no planned-vs-observed distinction in renders, calibration evidence written but never consumed, no capability introspection, no behavioral evals, actions terminal after completion (no follow-through).

**The minimum changes that materially change the experience** are therefore not new subsystems but *connections*: give the passes assembled context, wire the existing query layer into conversation as an assembled-state read, build a bounded retrieval path so durable memory can influence answers, upgrade the answer tier under policy control, and put a chief-of-staff voice on top. Then add the two genuinely new organs — a minimal priority model and follow-through/initiative loops — on existing primitives (commitments, escalations, calibration).

**Jarvis V1 in practical terms:** Jehad asks "what's going on?" and gets a coherent, prioritized, provenance-honest picture assembled from live state; follows up "what's the one thing?" / "why?" and gets grounded reasoning; refers back to earlier turns and it resolves; mentions something from last week and it recalls it with attribution; the system states what it cannot see, proactively surfaces a small number of meaningful things (including follow-ups on its own actions), and nightly calibration measures whether any of this actually helped.

---

## 2. Current-State Assessment

### Built (load-bearing, do not rebuild)
- **Kernel**: Postgres-only world model (migrations 000–016), principals/capability grants (ADR-0007), audit + provenance everywhere, durable workflows behind WorkflowRuntime port (ADR-0008), event model idempotent/replay-safe (ADR-0006).
- **Conversation**: iMessage in/out with paired identities (ADR-0013), multi-principal (josctl, yusra), bounded threads — 72h working context, 7-day raw retention, ≤20 msgs / ≤6,000 est-tokens, anti-injection flattening (ADR-0014; `threads.ts:206-265`). Turn pipeline with advisory-lock serialization, deterministic verbs (confirm/cancel/review/calibration), per-principal budgets.
- **Grounded reads**: 4 read tools with policy-gated `reads`, coverage-honesty sentences, server-side time rendering (`read-tools.ts:23-63`).
- **Query layer** (`packages/core/src/queries/`): `whatAmIWaitingFor`/`whatWaitsOnMe` (date-trust gates), `whatIsBlocked` + derived stalled, `highestLeverageDecision` (BFS over `blocked_by`), `whatChanged`, polymorphic `resolveItems`. **This is the unexploited core asset.**
- **Briefs**: deterministic, no-LLM morning/evening assembly over the full query layer + calendar projection + escalations + review queue; meaningfulness suppression; artifact-persisted.
- **Capture→memory**: imperative capture, LLM extraction lane, 5-gate promotion with assertion-kind truth (ADR-0004), review queue with iMessage refs.
- **Actions**: ActionIntent/Attempt/outcome with transition guards, reconcile-by-read-back for unknowns, confirm tokens, daily caps (ADR-0011).
- **Sensors**: calendar (15min sync + change notifications ≤48h), gmail (5min poll, health model, quota-hardened). Model egress pre-dispatch (ADR-0012), `model_calls` ledger with tokens/cost/latency, monthly $20/$50 caps + per-principal hour/day budgets.
- **Calibration**: nightly 20:00 PT rating prompt (deterministic verbs), miss capture (prose→`feedback` verdict=missed), weekly rollup, memory-boundary and health≠quality pins.
- **Policy**: strict fail-closed `policy.yaml` parser, re-read per use (hot reload), drives passes/capture/review/actions/reads/calibration/sensors (`ceiling.ts:561`).
- **Evals**: extraction goldens (F1/action-precision gates), model-routing eval with live results (`docs/evals/model-routing-2026-09.md`).

### Partial
- Working memory: raw messages persist, but `interaction_threads.metadata` / `interaction_messages.metadata` jsonb are **never written** — no topic state, no summaries, no referent registry.
- Model routing: route + route_fallback only; no answer tier, no depth classes, no answer fallback.
- Open loops: commitments carry `status open/met/missed/renegotiated/void` + `direction` + `may_follow_up`, and relationships carry `blocked_by` — but **no code ever updates commitments.status** (grep: zero `UPDATE commitments`); the state machine is dead weight.
- Source health: gmail 5-dim health + calendar `last_synced_at` recorded; consumed only by calibration "connected" checks — **no staleness rendering** anywhere.
- Introspection: one harness endpoint returning counts-only state summary.

### Missing
- Context assembly (any form), memory retrieval, persona, depth-tiered models, priority/"one thing" surface, planned-vs-observed rendering, divergence detection, follow-through on action outcomes, initiative beyond fixed crons, capability/system introspection, behavioral evals, cost/latency dashboards.

### Technical debt / hazards to clear in passing
- Dead code: `escalationAuditFields` (model-selection.ts:44-49), unused `routeOutputText` param, unused `WorkingContextProvider` seam (threads.ts:269-288 — **revive, don't delete**: it is the natural ContextAssembler port).
- `docs/plans/finance-sensors-contracts.md` cites ADR-0015 which does not exist.
- Gmail contracts ESCALATE-1…7 still await owner verdict (non-blocking here).
- Prompts hardcoded in .ts (conversation.ts:153-272) — blocks persona versioning.

### Important constraints
- Edge iMessage delivery is a **temporary stopgap** on this Mac (real edge lives in `/Users/Shared/tito`, separate repo).
- No harness/vendor SDK imports in packages/core (ADR-0002).
- `imessage:ingest` grant expires 2026-09-26 (renewal runbook).
- Answer-model upgrades are **policy + budget decisions**, not code defaults.

---

## 3. Jarvis V1 Product Contract

The canonical experience (deterministic surfaces bolded where applicable):

```text
Jehad: What's going on?

OS: You have one thing that actually needs your attention.
    The 9am Henna sync — she's asked twice, and your last two
    reschedules were same-day. Your other open loops are either
    waiting on someone else (2) or can wait (4).
    Yesterday also diverged from plan: 3 of 5 calendared blocks
    got moved or skipped.

Jehad: What's the one thing?

OS: Replying to Henna. It's the only commitment past due where
    you owe the reply and something downstream (venue deposit)
    is blocked on it. Want me to draft it?

Jehad: Why?

OS: You committed Sep 12 ("confirm venue by Friday"), it's 3 days
    overdue, may_follow_up is on, and the venue deposit commitment
    is blocked_by this one. [sources: your message Sep 12; calendar]

Jehad: What happened with that thing from yesterday?

OS: (resolves "that thing" from thread state: the proposal it made
    yesterday) The dinner reservation — confirmed, 7:30pm, on your
    calendar. No reply from Marco yet about dessert options.
```

Contract lines:
1. **"What's going on?"** yields an assembled, prioritized picture from live state — never a tool dump, never fabricated, with provenance on request ("why?").
2. **Referent continuity**: "the second one", "actually I changed my mind", "that thing from yesterday" resolve from thread state; ambiguity → one clarifying question, never a guess.
3. **Recall**: durable knowledge (decisions, commitments, preferences, episodes via review) surfaces with attribution ("you told me on…", "per your decision on…") when relevant.
4. **Epistemic honesty**: planned ≠ observed always labeled; stale sources caveated ("calendar last synced 6h ago"); "I can't see work email" stated, not papered over.
5. **Priority**: "what do I need to deal with?" returns a ranked short answer with reasons, from the deterministic priority model.
6. **Initiative with restraint**: a small number of proactive touches per day (see §11); follow-through on its own actions ("did the reservation hold?").
7. **Self-knowledge**: "what can you see/do?" answered from runtime grants/sources/health/policy, not a static prompt.
8. **Persona**: serious chief-of-staff register for Jehad (terse, judgment-forward, no filler); different persona possible for yusra; persona never changes authority.
9. Every intelligence claim stays inside the trust architecture: all invariants (§5) hold, verified by adversarial tests.

---

## 4. Intelligence Architecture

Target shape (new parts in **bold**, all inside existing packages/boundaries):

```text
iMessage inbound
  ↓ (existing turn pipeline, conversation.ts)
deterministic verbs (unchanged) ── calibration/review/confirm
  ↓
ROUTE pass  ← **context header: thread topic state + last exchanges + live referents**
  ↓ (tool selection now includes day.state, memory.recall, system.state)
READ LAYER  ← existing 4 tools + **day.state** (assembled state via queries/ + briefs collectors)
             + **memory.recall** (bounded retrieval over canonical memory)
             + **system.state** (runtime introspection)
  ↓
**CONTEXT ASSEMBLER** (packages/core/src/context/, implements the existing
  WorkingContextProvider seam): packs per-pass context = persona fragment
  + working context + DATA blocks with per-block provenance + uncertainty
  caveats (staleness, coverage) + budget-bounded token allocation
  ↓
ANSWER pass ← tier chosen by **deterministic depth classifier** (FAST/STANDARD/DEEP),
              policy.yaml maps tier→model; models never name models
  ↓
reply + thread state update (**interaction_threads.metadata**: topic,
  referent registry, pending follow-ups) + audit (unchanged)
```

- **Context assembly** is deterministic TS in-core for V1. The `WorkingContextProvider` port (threads.ts:269-288, currently dead) becomes the seam; **Hermes, when it exists, is a remote implementation of that port** — never canonical state (see §9).
- **Memory layers** stay distinct and flow only forward: current-turn → working (72h thread) → episodic (7d raw) → semantic (reviewed canonical) → world state. Retrieval reads backward (semantic→working) only through `memory.recall`, bounded and provenance-labeled.
- **World model**: queries/ extended with `priority.ts` (the-one-thing scorer) and observed-state writers (calendar occurrence sweep, commitment status transitions). Brief collectors (`briefs/data.ts`) reused by `day.state` so chat and briefs render from **one** assembly layer.
- **Initiative**: attention workflows on existing notification/escalation machinery with a policy.yaml interruption budget (§11).
- **Self-awareness**: `system.state` renders from policy + grants + sensor health + `model_calls` + deploy metadata; read-only.

---

## 5. Architectural Invariants

Non-negotiable (each gains or keeps an adversarial test pin):

1. Policy chooses models; models never choose models (depth classifier is deterministic code over route output; no model-emitted string can name a provider/model).
2. Persona is presentation only — cannot alter reads, tools, budgets, egress, or authorization (pin: identical capability resolution under every persona).
3. Tool output may influence reasoning, never authorization.
4. Retrieved memory is data, not instructions (same flattening/escaping as thread history; recall blocks carry trust labels; injection test corpus).
5. Harnesses own no canonical state (Hermes/edge implement ports; caches at most).
6. Conversation history is not automatically semantic memory (unchanged promotion gates; recall never writes).
7. Planned ≠ observed ≠ inferred ≠ corrected — distinct labels end-to-end (calendar status is Google's belief; occurrence is a separate fact).
8. Action intent ≠ outcome (unchanged; follow-through only *asks* or *reports*).
9. Principal isolation stays structural (recall and day.state are principal-scoped SQL; cross-principal tests extended).
10. Work data stays outside the personal core; only the `WorkSignals` *interface* is defined (§15).
11. Unknown > fabricated certainty (coverage sentences, staleness caveats, uncertainty language rules in prompts).
12. Bounded context always (per-pass token budgets enforced in code, not by hope).

---

## 6. Gap Analysis

| Dimension | Current | Required for V1 | Delta |
|---|---|---|---|
| A. Model quality | route=4.1-mini, answer=principal default (gpt-4o-mini), parse-failure fallback only | FAST/STANDARD/DEEP tiers, policy-mapped; STANDARD default for answers; DEEP for synthesis; answer_fallback | **W3** |
| B. Continuity | 72h/20-msg/6k-token raw history; referents = one prompt line; router sees nothing | Router context header; thread topic state + referent registry in `metadata`; "changed my mind" → structured undo of last proposal/answer stance | **W1** |
| C. Hermes | Zero code; one ADR name-drop | Port defined (WorkingContextProvider revived), in-core deterministic implementation | seam in **W1**, build deferred |
| D. Long-term memory | Write-only canonicalization; no retrieval | `memory.recall` bounded retrieval (evidence/decisions/procedures/commitments + reviewed episodes), provenance-rendered | **W2** |
| E. Persona | One hardcoded utilitarian prompt | Per-principal/per-surface/versioned persona packs in policy.yaml, assembled by context layer; chief-of-staff for josctl | **W4** |
| F. World awareness | Coverage sentences per tool; no staleness, no planned/observed | Staleness caveats; occurrence state; epistemic labels in all renders | **W1** (staleness) + **W5** (occurrence) |
| G. Proactivity | Fixed crons: briefs 6am/9pm, calibration 8pm, calendar-change pushes | Follow-through loops (action outcomes), commitment nudges, interruption budget, midday urgent-only window | **W6** |
| H. Prioritization | Query ingredients exist (waiting/blocked/leverage); no "one thing" | `queries/priority.ts`: deterministic scorer; surfaced via day.state + direct question | **W5** |
| I. Planning/follow-through | Actions terminal; unknown-outcome reconcile on-demand only | Scheduled reconcile workflow; outcome→follow-up question; bounded nudge suggestions (propose, never auto-send) | **W6** |
| J. Capability self-awareness | Counts-only harness endpoint | `system.state` read tool from grants+policy+health+coverage | **W7** |
| K. System self-awareness | None | Version/deploy/health/cost/known-gaps in system.state; "why did you miss X" from calibration misses | **W7** |
| Evals | Extraction + routing only | Behavioral scenario suite (hermetic + live-judged); calibration as product KPI | **W8** + per-wave |
| Latency/cost | Ledger exists, no targets/dashboards | Per-tier latency targets; daily cost rollup; routing metrics | **W3** |

---

## 7. Phased Execution Plan

Sequencing rationale: W1 creates the context seam everything else plugs into; W2/W3/W7 are independent of each other; W4 needs W3's tiers; W5/W6 build the judgment layer; W8 formalizes measurement (scenario harness starts in W1 and accretes). Per the standing directive: worktree lanes, builders never self-verify, verifier + adversary wave per merge, ledger per wave.

### W1 — Context Foundation (the seam)
- **Goal**: the passes stop being blind; "what's going on?" becomes answerable; epistemic caveats appear.
- **Scope**: (a) revive `WorkingContextProvider` as `packages/core/src/context/` assembler with per-pass budgets; (b) write thread state to `interaction_threads.metadata` (topic label, referent registry: last proposal/read/review items with refs+labels, timestamps); (c) route pass gets context header (last 2 exchanges + live referents, flattened); (d) new read tool `day.state` — assembled over `queries/` + brief collectors (today/next, waiting, blocked/stalled, best-unlock, overnight delta, escalations), rendered as labeled structured text, principal-scoped; (e) staleness caveats: per-source `last_synced_at` → rendered freshness lines in day.state and answer DATA blocks; (f) answer prompt restructured into provenance-labeled blocks; (g) behavioral eval harness skeleton (scenario runner, fake-model hermetic) lands with first scenarios: referent continuity, day.state grounding, staleness honesty.
- **Dependencies**: none.
- **Acceptance**: "what's going on?" (routed to day.state) returns coherent multi-section picture incl. waiting/blocked/unlock from live DB; router resolves "the second one" against referent registry in ≥90% of scenario corpus; every day.state claim traces to a query (verifier spot-audit); staleness line present when calendar >6h stale.
- **Security/adversarial**: injection corpus through new header/blocks; referent registry cannot reference other principals' threads; day.state principal-scoping test.
- **Rollback**: context header + day.state are additive read paths; feature flags via policy.yaml `gateway.context` section (fail-closed to current behavior).

### W2 — Memory Recall
- **Goal**: durable memory influences conversation, with attribution, never silently.
- **Scope**: `memory.recall` read tool — SQL over evidence/decisions/procedures/commitments (+ reviewed episodes) filtered by principal + domain sensitivity + recency + simple relevance (v1: term/domain match, pg trigram optional; **no vector DB** — revisit post-V1), ≤5 items, each rendered with source + date + assertion-kind label; route pass may pick `memory.recall` alongside data tools; recall never feeds capture/promotion (read-only pin); egress: recalled items pass existing sensitivity filter.
- **Dependencies**: W1 (context blocks).
- **Acceptance**: scenario "you mentioned X last week" recalls with correct attribution; irrelevant recall suppressed (precision scenario ≥80% hermetic); zero new memory writes from recall path (DB pin).
- **Security**: injection via stored memory content (flattening + trust labels); recall cannot surface other-principal rows; sensitive-classified items excluded per egress policy.

### W3 — Model Tiers (FAST/STANDARD/DEEP)
- **Goal**: reasoning quality policy-controlled, cost-visible, latency-bounded.
- **Scope**: policy.yaml `gateway.passes` extended: `answer_fast`, `answer_standard`, `answer_deep`, `answer_fallback`; deterministic depth classifier in model-selection.ts (features: route tool choice, question class markers, referent complexity, DATA block count) → tier enum → policy map; **eval-gated default upgrade** of STANDARD (candidates: gpt-4.1, claude-sonnet class — decided by rerunning the routing eval harness in answer mode, see §8); DEEP reserved for synthesis-class turns (day.state narration, "why" chains, weekly reflections) with per-day DEEP budget; answer_fallback for provider failure (one retry, existing pattern); latency/cost rollup script from `model_calls`; delete dead code (`escalationAuditFields`, unused param).
- **Dependencies**: W1 (context makes STANDARD worth paying for).
- **Acceptance**: tier distribution logged per turn; hermetic scenario suite passes at STANDARD where it failed at FAST; p50/p95 latency per tier within targets (§9); daily cost rollup runnable; adversarial: no route/model output string can influence tier beyond the fixed feature classifier (pin).
- **Rollback**: tiers map to current single model via policy edit; no schema changes.

### W4 — Persona
- **Goal**: chief-of-staff register; per-principal, per-surface, versioned, configurable.
- **Scope**: policy.yaml `personas:` (per principal+surface: register, brevity rules, explanation style, version); context assembler injects persona fragment per pass; prompts move from hardcoded strings to versioned fragments (persona + epistemic rules + tool instructions) with `prompt_version` already ledgered in model_calls; josctl persona drafted by lead, **ratified by owner**; yusra persona stub (gentler/shorter) unless deferred.
- **Dependencies**: W3 (tier-aware prompt assembly).
- **Acceptance**: persona consistency across scenario suite; **capability-resolution identical under every persona** (adversarial pin: reads/tools/budgets/egress unchanged); prompt_version bump auditable.
- **Rollback**: policy edit; personas default to current utilitarian prompt.

### W5 — Priority & Observed State
- **Goal**: "what's the one thing?" answered deterministically; planned/observed separation real.
- **Scope**: (a) `queries/priority.ts` — scorer over: overdue owes_me with may_follow_up, deadline proximity, blocked-transitive-downstream (reuse leverage BFS), calendar imminent, waiting-on aging; returns ranked list with per-item reason strings; surfaced in day.state top-line + direct question; (b) calendar occurrence sweep workflow (hourly): past events → `occurrence` column `presumed_occurred` (explicitly labeled, never "confirmed"); (c) commitment status transitions via principal verbs ("done", "renegotiated: …", "missed") — user_declared provenance, audited, transition-guarded (the dead enum comes alive); (d) divergence v1: evening block — yesterday's planned vs cancelled/moved + commitments created same-day; rendered in evening close + calibration context; (e) migration 017 (calendar_events.occurrence, commitments transition audit fields).
- **Dependencies**: W1; (d) benefits from W3 DEEP narration but renders deterministically without it.
- **Acceptance**: "one thing" scenario corpus picks the blocking-overdue item ≥85%; renders never state planned events as occurred (label pin); commitment verbs transition status with provenance; divergence block only when true divergence exists (suppression pin).
- **Security**: occurrence sweep is read-then-label (no external calls); commitment transitions principal-scoped + audited; adversarial: forged "done" from unpaired sender impossible (existing pairing gate).

### W6 — Initiative & Follow-Through
- **Goal**: bounded proactive intelligence; no spam.
- **Scope**: (a) reconcile-unknown workflow (15min) wrapping existing `reconcileCalendarAction`; (b) follow-up loops: succeeded actions tied to a future moment → next-morning one-line check-in question (feeds calibration/occurrence, not new tables); (c) nudge suggestions: overdue + may_follow_up + aging → brief line with pre-drafted message as a *proposal* (existing propose machinery, never auto-send); (d) interruption policy in policy.yaml `attention:` — quiet hours (default 22:00–07:00 PT), max unsolicited touches/day (default 3, briefs+calibration excluded), urgent-only midday window (escalation ≥ high, existing threshold); (e) attention decisions logged with reasons (why surfaced / why silent) — auditable restraint.
- **Dependencies**: W5 (priority feeds selection).
- **Acceptance**: follow-up arrives for actionable outcomes and **not** for terminal successes (suppression tests); interruption cap enforced under burst simulation; "why didn't you bother me about X" answerable from attention log; calibration noise metric does not regress (weekly).
- **Security**: no new outbound channels; nudges ride existing proposal confirm flow; adversarial: nudge drafting cannot send without confirm token (existing).

### W7 — Self-Awareness
- **Goal**: "what can you see/do / why did you miss that / what are you?" answered from runtime truth.
- **Scope**: `system.state` read tool rendering: connected sources + freshness + coverage gaps (from calibration `source_not_connected` misses + read-tool coverage sentences), live capabilities (policy reads + grants + actions config), version (git SHA + deploy date env, set at build), monthly cost + call counts from ledger, known limitations (static honest list, versioned); "why missed" query path over calibration misses + attention log; **strictly read-only** — no self-modification surface of any kind.
- **Dependencies**: none (parallelizable with W2/W3).
- **Acceptance**: scenario: "can you send an email?" → honest no with capability list; "why didn't you catch that?" → cites miss classification + source coverage; version answer matches deploy.
- **Security**: system.state leaks no secrets/other principals (pin); no write paths (structural grep pin, mirroring edge send-only test).

### W8 — Evaluation & Calibration Closure
- **Goal**: intelligence is measured, not assumed.
- **Scope**: scenario suite to full breadth (§13 list); live-judged mode (judge = policy-pinned STANDARD model, budget-gated, judged rubric checked into repo); calibration metrics as product KPIs: daily rating trend, miss rate by source, useful/noise/incorrect ratios — weekly rollup extended with these; exit audit report.
- **Dependencies**: all waves (accretes from W1).
- **Acceptance**: see exit criteria §16.

---

## 8. Model Strategy

- **Current**: route=openai/gpt-4.1-mini (96.7% parse, 658ms), route_fallback=google/gemini-3.8-flash, answer=principal default gpt-4o-mini. Answer quality was never eval'd — only routing was.
- **Near-term (W3)**: three answer tiers + fallback, policy-mapped:
  - FAST: acks, simple factual, single-tool lookups (4o-mini/4.1-mini class).
  - STANDARD (default): normal conversation, multi-turn, narration (gpt-4.1 / sonnet class — **chosen by a purpose-run eval**, not by taste).
  - DEEP: synthesis ("what's going on" full assembly, "why" chains, weekly reflection) — budget-capped per day.
  - Selection = deterministic classifier → tier → policy map. Vendor names live only in policy.yaml.
- **Future (post-V1)**: context-size-aware tier bumping, per-domain sensitivity routing, principal-pair personas with tier preferences, eval-driven quarterly re-selection with ledgered evidence.
- **Never**: models emitting model IDs; unledgered calls; tiers without budget caps.

## 9. Hermes Strategy

- **Owns (eventually)**: context selection/compression/assembly as a remote implementation of the `WorkingContextProvider` port; rolling summarization; relevance ranking beyond SQL v1; persona assembly offloaded per principal.
- **Never owns**: identity, authorization, conversation history storage, semantic memory, world model, policy (ADR-0003 already pins harnesses to cache-only).
- **When**: **not in Jarvis V1.** V1 ships the in-core deterministic assembler so the seam is proven under load + evals; Hermes becomes valuable when context assembly cost/complexity justifies a dedicated service (multi-surface, long-horizon episodic compression). The port + its tests are the entire V1 Hermes obligation.

## 10. Memory Strategy

| Layer | Store | Lifetime | Feeds conversation via |
|---|---|---|---|
| Current-turn context | turn-local | request | direct |
| Working memory | interaction_messages (72h active) | 72h sliding | history block (existing) |
| Episodic raw | interaction_messages (retention) | 7d | recall v1: reviewed episodes only |
| Semantic memory | evidence/decisions/procedures/commitments | canonical | `memory.recall` (W2), provenance-labeled |
| World state | events/calendar/commitments/gmail | canonical | day.state + read tools |

Promotion stays explicit (ADR-0004). Retrieval is the only new direction, always: bounded, principal-scoped, sensitivity-filtered, provenance-rendered, read-only.

## 11. Proactive / Attention Strategy

Notice (deterministic): overdue/aging commitments, blocked-transitive changes, action outcomes (unknown → reconciled; succeeded-with-future-moment → follow-up), divergence, escalations, calibration misses (source coverage gaps).
Decide: priority score + suppression rules (meaningfulness gates extended from briefs) + interruption budget (quiet hours, ≤3 unsolicited/day, urgent=escalation≥high only).
Batch: everything non-urgent into morning/evening briefs (existing artifacts).
Escalate: existing escalation machinery at ≥high, unchanged.
Follow up: W6 loops; every attention decision journaled with its reason (silence is auditable).
Learn: calibration noise/miss weekly review feeds suppression thresholds (owner-adjustable via policy, not auto-tuning in V1).

## 12. Self-Awareness Strategy

Capability introspection (W7 `system.state`): from grants + policy reads + actions config + adapter registry — runtime truth, no static prompt. Source awareness: per-source freshness + coverage honesty sentences (W1 staleness) + gap synthesis from calibration misses. System status: version/deploy/health/cost/latency rollups from ledger + sensor state. Minimal self-model: versioned limitations document rendered on "what are your limits?". Future self-iteration (explicitly out of V1): observe→propose→isolated harness→worktree→evals→review→deploy loop — read-only introspection now, zero mutation surface.

## 13. Evaluation & Metrics

- **Offline (hermetic, CI)**: scenario suite — referent continuity, multi-turn reasoning, recall relevance + attribution, missing-source admission, inference explanation, priority selection, noise suppression, principal isolation, persona consistency, tier appropriateness, ambiguity→clarify, conflicting evidence handling, injection resistance. Fake-model deterministic assertions for structure; golden outputs for renders.
- **Offline (live-model, manual/nightly)**: same scenarios through real models, judged by policy-pinned STANDARD judge with checked-in rubric; budget-gated; results to `docs/evals/`.
- **Dogfood**: calibration nightly rating (world-model accuracy), useful/noise/incorrect on briefs/items, miss reports (first-class).
- **Latency**: per-tier p50/p95 from `model_calls.latency_ms` — targets: route ≤800ms p50; FAST ≤2s p95; STANDARD ≤4s p50/8s p95; DEEP ≤15s p95.
- **Cost**: daily rollup from ledger; typical day target ≤$3, alert $5 (soft), monthly caps unchanged ($20/$50).
- **Noise/miss**: interrupts/day actual vs budget; calibration miss-rate trend; follow-up suppression correctness.

## 14. Risk Register

| Risk | Vector | Mitigation |
|---|---|---|
| Context poisoning | recall/day.state content carries adversarial text | flattening + trust labels + injection corpus per wave; memory promotion gates unchanged |
| Prompt injection via sensors | gmail/calendar fields already partially mitigated | extend redaction tests to recall blocks + referent registry |
| Memory contamination | recall amplifies bad canonical rows | provenance rendering; review queue unchanged; misses flag sources |
| Overconfidence | model narrates planned as actual | epistemic labels enforced in renders + scenario pins |
| Notification fatigue | initiative loops over-fire | interruption budget + suppression gates + calibration noise KPI |
| Model cost creep | DEEP tier overuse | deterministic classifier, DEEP/day cap, daily rollup alerts |
| Latency | assembled context grows | per-pass token budgets in assembler (code-enforced); parallel read fan-out |
| Cross-principal leakage | new read surfaces | principal-scoped SQL + isolation tests per wave |
| Architectural drift | parallel memory/policy systems | single assembler, single query layer, single policy; verifier waves check for parallel systems |
| Self-modification risk | none in V1 by construction | read-only introspection, structural grep pin |
| Provider dependence | single-vendor outage | answer_fallback + multi-vendor policy map |
| Work-data creep | intelligence hungry for context | WorkSignals interface only; hard non-goal (§15) |

## 15. Explicit Non-Goals

- Work data ingestion of any kind (no Slack/Granola/work-email/GitHub in personal core; Work Edge gets its own plan later — only the `WorkSignals` attention-input *interface* may be sketched in W5/W6 types).
- Voice, general computer control, autonomous financial action, autonomous outbound sends.
- Unlimited autonomy; self-modification; new sensors (finance/Plaid waits on owner keys).
- Vector DB / embedding retrieval (v1 is SQL relevance; revisit with evidence).
- Auto-tuning attention thresholds from calibration (owner adjusts via policy in V1).
- Multi-user scaling, new surfaces beyond iMessage.
- Hermes as a service.

## 16. Jarvis V1 Exit Criteria

All of the following, measured, not vibes:

1. Multi-turn referent scenario suite ≥90% (hermetic) — "the second one"/"changed my mind" resolve or clarify.
2. Persona consistent across scenarios; capability resolution byte-identical under persona swap (test).
3. STANDARD answer tier live as default, chosen by a ledgered eval; FAST/DEEP distribution logged.
4. Recall scenario: ≥80% precision hermetic, attribution present in 100% of recalls; zero recall-path writes.
5. "What's going on?" end-to-end scenario returns prioritized multi-section answer with provenance and staleness caveats — from live DB in dogfood, not fixtures.
6. "What do I actually need to deal with?" returns ranked output with reasons; ≥85% agreement with scenario goldens.
7. Planned/observed/inferred labels pinned by tests; no render conflates them.
8. "Why do you believe X" answers cite sources (thread, memory w/ date, sensor).
9. "What can you see/do" answered from runtime state, matching grants/policy exactly.
10. Proactive touches ≤ budget/day in dogfood over 2 weeks; ≥1 meaningful follow-up per week acting on its own actions; calibration noise ratio not worse than pre-V1 baseline.
11. Calibration daily rating + useful/noise/incorrect + miss-rate trended weekly and reviewed with owner at exit.
12. Principal isolation adversarial suite green (incl. recall + day.state + system.state).
13. WorkSignals interface (types + doc section) exists such that a future Work Edge can feed attention inputs without redesign — no other work-data surface.
14. Full suite + lint green; latency/cost within §13 targets on a 2-week dogfood sample.

## 17. Recommended Execution Order

```text
W1 Context Foundation            (seam: assembler, thread state, day.state, staleness, eval skeleton)
 ├── W2 Memory Recall            (parallel lane)
 ├── W3 Model Tiers              (parallel lane; includes STANDARD eval bake-off)
 └── W7 Self-Awareness           (parallel lane — zero deps)
W4 Persona                       (after W3)
W5 Priority & Observed State     (after W1; overlaps W4 harmlessly — separate tables/paths)
W6 Initiative & Follow-Through   (after W5)
W8 Evaluation & Calibration Closure (harness grows from W1; formal closure last)
```

Rationale: W1 unblocks three independent lanes; judgment layers (W5/W6) need the seam but not the persona; measurement accretes so exit criteria are already instrumented by W8 rather than retrofitted. Each wave ships behind policy.yaml switches with fail-closed defaults.

## 18. Open Decisions Requiring Jehad

1. **STANDARD/DEEP model + cost ceiling** (W3): approve the eval-shortlist and the daily cost target (≤$3 typical / $5 alert) before the bake-off finalizes the policy mapping.
2. **Chief-of-staff persona draft** (W4): I draft; you ratify wording + register (terse/judgment-forward is my default assumption — confirm).
3. **Interruption defaults** (W6): quiet hours 22:00–07:00 PT, ≤3 unsolicited touches/day — confirm or adjust.
4. **yusra in V1 scope**: josctl-only persona (recommended) vs drafting hers now.
5. **Commitment transition authority** (W5): principal verbs like "done" auto-transition with user_declared provenance (recommended) vs review-gated.
6. **Hermes timing**: confirm deferral to post-V1 (recommended; port + tests land anyway).

---

*Prepared from repository audits at `c65ec8a`. All file:line references verified by three independent read-only audits (conversation surface, world model/initiative, docs/evals/infra). No implementation has begun.*
