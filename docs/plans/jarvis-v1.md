# Jarvis V1 — Intelligence Plan

Status: **accepted (rev 2)** — owner verdict 2026-09-21, seven revisions incorporated
Date: 2026-09-21
Grounding: audits of HEAD `c65ec8a` (post-calibration wave), 1,511 tests green, migrations 000–016

**Revision 2 changelog** (owner verdict "accept with revisions, no architecture rewrite"):
- **R1** Calendar occurrence: time-passing is not evidence — `scheduled_past_unverified`; `observed_occurred` only on corroboration; calendar deltas rendered as **plan divergence** (§7 W5, §16).
- **R2** Persona: structured, versioned **interaction profiles** (principal+surface) with eventual self-configuration; policy.yaml stays security/default layer only (§7 W4).
- **R3** Multi-read composition: bounded allowlisted read set (≤3, parallel, token-budgeted); read composition and action proposals are mutually exclusive (§4, §7 W1).
- **R4** Cost: monthly envelope decided first, daily/DEEP budgets derived from it; budgets are runaway-guardrails, not experience targets (§8, §13, §18).
- **R5** Eval judging: independent-family judge + owner spot-checks; hermetic structural tests remain the primary hard gate (§7 W3/W8, §13).
- **R6** Verb mutation semantics: "changed my mind" is thread-local unless explicitly targeting canonical state; bare `done/renegotiated/missed` mutate only via sole-eligible-item or explicit `[ref]` (§7 W1/W5).
- **R7** Recall metric: recall@5 target alongside precision; must-return-none scenarios (§7 W2, §13, §16).
- **Pin** Gmail sensor documented **personal-domain only**; employer mailboxes belong to the future Work Edge (§5, §15).

---

## 1. Executive Summary

Jehad OS feels like "a secure workflow engine with an LLM attached" because, at the conversation surface, **that is literally what it is**. The audits found four concrete root causes:

1. **The router is blind and the answer pass is amnesiac-by-design.** The route pass prompt contains *only the user's message and a tool list* — no history, no thread state (`conversation.ts:205-221`). "What about the second one?" routes with zero referent context. The answer pass gets raw message history and *at most one* read-tool result. Nothing assembles a picture — and composite questions ("what's going on, and does that relate to what I decided last week?") are structurally unanswerable when only one read result can ever reach the prompt.
2. **Memory is write-only.** Capture → review → canonical writes work, but no code path ever reads evidence, decisions, procedures, or semantic memory back into a conversation. The system remembers by filing and never recalling.
3. **The answer model is the cheapest tier.** `gateway.passes` defines `route` and `route_fallback` only; the answer pass falls through to the principal default (gpt-4o-mini). The model-routing wave optimized the *router*; nothing ever upgraded the *reasoner*. There is no DEEP path.
4. **Intelligence machinery exists but is disconnected from the chat.** `packages/core/src/queries/` already implements waiting-on, blocked/stalled, transitive-leverage ("best unlock"), and what-changed — the exact ingredients of "what's going on?" — but conversation exposes only four narrow read tools. Briefs use the query layer; chat cannot.

Secondary causes: no persona (one hardcoded utilitarian prompt for every principal), no prioritization ("the one thing" is answerable by the leverage query and never asked), no planned-vs-observed distinction in renders, calibration evidence written but never consumed, no capability introspection, no behavioral evals, actions terminal after completion (no follow-through).

**The minimum changes that materially change the experience** are therefore not new subsystems but *connections*: give the passes assembled context (from a bounded set of parallel reads), wire the existing query layer into conversation as an assembled-state read, build a bounded retrieval path so durable memory can influence answers, upgrade the answer tier under policy control, and put a chief-of-staff voice on top. Then add the two genuinely new organs — a minimal priority model and follow-through/initiative loops — on existing primitives (commitments, escalations, calibration).

**Jarvis V1 in practical terms:** Jehad asks "what's going on?" and gets a coherent, prioritized, provenance-honest picture assembled from live state; follows up "what's the one thing?" / "why?" and gets grounded reasoning; refers back to earlier turns and it resolves; mentions something from last week and it recalls it with attribution; the system states what it cannot see (including what it *scheduled* but cannot verify happened), proactively surfaces a small number of meaningful things (including follow-ups on its own actions), and nightly calibration measures whether any of this actually helped.

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
- **Sensors**: calendar (15min sync + change notifications ≤48h), gmail (5min poll, health model, quota-hardened — **personal-domain account only**, see §5). Model egress pre-dispatch (ADR-0012), `model_calls` ledger with tokens/cost/latency, monthly caps + per-principal hour/day budgets.
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
- Context assembly (any form), multi-read composition, memory retrieval, interaction profiles, depth-tiered models, priority/"one thing" surface, occurrence-state tracking, plan-divergence detection, follow-through on action outcomes, initiative beyond fixed crons, capability/system introspection, behavioral evals, cost/latency dashboards.

### Technical debt / hazards to clear in passing
- Dead code: `escalationAuditFields` (model-selection.ts:44-49), unused `routeOutputText` param, unused `WorkingContextProvider` seam (threads.ts:269-288 — **revive, don't delete**: it is the natural ContextAssembler port).
- `docs/plans/finance-sensors-contracts.md` cites ADR-0015 which does not exist.
- Gmail contracts ESCALATE-1…7 still await owner verdict (non-blocking here).
- Prompts hardcoded in .ts (conversation.ts:153-272) — blocks profile versioning.

### Important constraints
- Edge iMessage delivery is a **temporary stopgap** on this Mac (real edge lives in `/Users/Shared/tito`, separate repo).
- No harness/vendor SDK imports in packages/core (ADR-0002).
- `imessage:ingest` grant expires 2026-09-26 (renewal runbook).
- Answer-model upgrades are **policy + budget decisions**, not code defaults.

---

## 3. Jarvis V1 Product Contract

The canonical experience:

```text
Jehad: What's going on?

OS: You have one thing that actually needs your attention.
    The 9am Henna sync — she's asked twice, and your last two
    reschedules were same-day. Your other open loops are either
    waiting on someone else (2) or can wait (4).
    Yesterday's plan also churned: 3 of 5 calendared blocks were
    moved or cancelled same-day. That's plan divergence — I can't
    yet verify what actually happened.

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

Jehad: What's going on with the plan, and does this tie to what I
       decided last week?

OS: (composes day.state + memory.recall in one turn, both labeled)
```

Contract lines:
1. **"What's going on?"** yields an assembled, prioritized picture from live state — never a tool dump, never fabricated, with provenance on request ("why?"). Composite questions compose a **bounded set of reads** (§4), each provenance-labeled.
2. **Referent continuity**: "the second one", "actually I changed my mind", "that thing from yesterday" resolve from thread state; "changed my mind" **retracts the thread's stance** — it touches canonical state only when explicitly targeting it, through the existing proposal/confirm or review flows; ambiguity → one clarifying question, never a guess.
3. **Recall**: durable knowledge (decisions, commitments, preferences, episodes via review) surfaces with attribution ("you told me on…", "per your decision on…") when relevant — and stays silent when nothing relevant exists.
4. **Epistemic honesty**: planned ≠ scheduled-past-unverified ≠ observed; stale sources caveated ("calendar last synced 6h ago"); "I can't see work email" stated, not papered over; calendar churn is reported as **plan divergence**, never as verified fact about the day.
5. **Priority**: "what do I need to deal with?" returns a ranked short answer with reasons, from the deterministic priority model.
6. **Initiative with restraint**: a small number of proactive touches per day (see §11); follow-through on its own actions ("did the reservation hold?" — and the answer graduates occurrence state, see W5).
7. **Self-knowledge**: "what can you see/do?" answered from runtime grants/sources/health/policy, not a static prompt.
8. **Persona**: serious chief-of-staff register for Jehad (terse, judgment-forward, no filler) as a **versioned interaction profile**; principals can eventually tune their own profile through conversation; profiles never change authority.
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
  ↓ (**bounded read set: 1–3 allowlisted read capabilities, parallel,
     token-budgeted — mutually exclusive with action proposals**)
READ LAYER  ← existing 4 tools + **day.state** (assembled state via queries/
             + brief collectors) + **memory.recall** (bounded retrieval over
             canonical memory) + **system.state** (runtime introspection)
  ↓
**CONTEXT ASSEMBLER** (packages/core/src/context/, implements the existing
  WorkingContextProvider seam): packs per-pass context = interaction-profile
  fragment + working context + N DATA blocks with per-block provenance +
  uncertainty caveats (staleness, coverage, occurrence state) + budget-bounded
  token allocation per block
  ↓
ANSWER pass ← tier chosen by **deterministic depth classifier** (FAST/STANDARD/DEEP),
              policy.yaml maps tier→model; models never name models
  ↓
reply + thread state update (**interaction_threads.metadata**: topic,
  referent registry, last stance, pending follow-ups) + audit (unchanged)
```

- **Context assembly** is deterministic TS in-core for V1. The `WorkingContextProvider` port (threads.ts:269-288, currently dead) becomes the seam; **Hermes, when it exists, is a remote implementation of that port** — never canonical state (see §9).
- **Multi-read composition (R3)**: the route pass may select a bounded set (≤3) of allowlisted, read-only capabilities, executed in parallel with per-block token budgets. Composition is for reads only — a turn either composes reads and answers, or proposes an action, never both (the route schema makes the two shapes mutually exclusive; adversarial pin).
- **Memory layers** stay distinct and flow only forward: current-turn → working (72h thread) → episodic (7d raw) → semantic (reviewed canonical) → world state. Retrieval reads backward (semantic→working) only through `memory.recall`, bounded and provenance-labeled.
- **World model**: queries/ extended with `priority.ts` (the-one-thing scorer) and occurrence-state writers (calendar sweep → `scheduled_past_unverified`; corroboration → `observed_occurred`; principal verbs → commitment transitions under the sole-eligible-item resolver). Brief collectors (`briefs/data.ts`) reused by `day.state` so chat and briefs render from **one** assembly layer.
- **Interaction profiles (R2)**: structured, versioned, principal+surface-bound presentation configuration; policy.yaml holds only security/default binding (§7 W4).
- **Initiative**: attention workflows on existing notification/escalation machinery with a policy.yaml interruption budget (§11).
- **Self-awareness**: `system.state` renders from policy + grants + sensor health + `model_calls` + deploy metadata; read-only.

---

## 5. Architectural Invariants

Non-negotiable (each gains or keeps an adversarial test pin):

1. Policy chooses models; models never choose models (depth classifier is deterministic code over route output; no model-emitted string can name a provider/model).
2. Interaction profiles are presentation only — cannot alter reads, tools, budgets, egress, or authorization (pin: identical capability resolution under every profile version, including self-modified ones).
3. Tool output may influence reasoning, never authorization.
4. Retrieved memory is data, not instructions (same flattening/escaping as thread history; recall blocks carry trust labels; injection test corpus).
5. Harnesses own no canonical state (Hermes/edge implement ports; caches at most).
6. Conversation history is not automatically semantic memory (unchanged promotion gates; recall never writes).
7. Planned ≠ scheduled-past-unverified ≠ observed ≠ inferred ≠ corrected — distinct labels end-to-end. Time passing is never evidence of occurrence; `observed_occurred` requires corroboration (explicit principal statement, cross-source signal, or a future sensor). Calendar status remains Google's belief; occurrence is a separate fact.
8. Action intent ≠ outcome (unchanged; follow-through only *asks* or *reports*).
9. Principal isolation stays structural (recall, day.state, system.state, and profiles are principal-scoped; cross-principal tests extended; a principal can modify only their own profile).
10. Work data stays outside the personal core; only the `WorkSignals` *interface* is defined (§15). **The live Gmail sensor is personal-domain only** — employer mailboxes belong to the future Work Edge, never to this sensor (documentation pin; enrollment stays personal-account).
11. Unknown > fabricated certainty (coverage sentences, staleness caveats, occurrence labels, uncertainty language rules in profiles).
12. Bounded context always (per-pass and per-block token budgets enforced in code, not by hope).
13. **Thread-local by default (R6)**: conversational corrections ("changed my mind") mutate thread state; canonical mutations ride existing proposal/confirm or review flows only.
14. **Bare verbs resolve or refuse (R6)**: `done/renegotiated/missed`-style transitions mutate only when exactly one eligible item exists; zero → honest none; multiple → require an item ref (`[7K4]`-style) or clarify. Never guess.

---

## 6. Gap Analysis

| Dimension | Current | Required for V1 | Delta |
|---|---|---|---|
| A. Model quality | route=4.1-mini, answer=principal default (gpt-4o-mini), parse-failure fallback only | FAST/STANDARD/DEEP tiers, policy-mapped; STANDARD default; DEEP for synthesis; answer_fallback; **envelope-derived budgets** | **W3** |
| B. Continuity | 72h/20-msg/6k-token raw history; referents = one prompt line; router sees nothing | Router context header; thread topic state + referent registry + last-stance in `metadata`; "changed my mind" → thread-local retraction | **W1** |
| C. Hermes | Zero code; one ADR name-drop | Port defined (WorkingContextProvider revived), in-core deterministic implementation | seam in **W1**, build deferred (owner-endorsed) |
| D. Long-term memory | Write-only canonicalization; no retrieval | `memory.recall` bounded retrieval, provenance-rendered, **precision AND recall@5 measured** | **W2** |
| E. Interaction profiles | One hardcoded utilitarian prompt | Structured versioned profiles (principal+surface), thread-scoped overrides, conversational self-configuration; policy = security/default layer | **W4** |
| F. World awareness | Coverage sentences per tool; no staleness, no occurrence state | Staleness caveats; `scheduled_past_unverified` → `observed_occurred` on corroboration; plan-divergence rendering | **W1** (staleness) + **W5** (occurrence) |
| G. Proactivity | Fixed crons: briefs 6am/9pm, calibration 8pm, calendar-change pushes | Follow-through loops (action outcomes), commitment nudges, interruption budget, midday urgent-only window | **W6** |
| H. Prioritization | Query ingredients exist (waiting/blocked/leverage); no "one thing" | `queries/priority.ts`: deterministic scorer; surfaced via day.state + direct question | **W5** |
| I. Planning/follow-through | Actions terminal; unknown-outcome reconcile on-demand only | Scheduled reconcile workflow; outcome→follow-up question → occurrence graduation; bounded nudge proposals | **W6** |
| J. Capability self-awareness | Counts-only harness endpoint | `system.state` read tool from grants+policy+health+coverage | **W7** |
| K. System self-awareness | None | Version/deploy/health/cost/known-gaps in system.state; "why did you miss X" from calibration misses | **W7** |
| Read composition | Exactly one tool result per turn | Bounded allowlisted read set (≤3), parallel, per-block budgets | **W1** |
| Evals | Extraction + routing only | Behavioral scenario suite (hermetic + independently-judged live); calibration as product KPI | **W8** + per-wave |
| Latency/cost | Ledger exists, no targets/dashboards | Per-tier latency targets; envelope-derived daily/DEEP budgets; rollups | **W3** |

---

## 7. Phased Execution Plan

Sequencing rationale: W1 creates the context seam everything else plugs into; W2/W3/W7 are independent of each other; W4 needs W3's tiers; W5/W6 build the judgment layer; W8 formalizes measurement (scenario harness starts in W1 and accretes). Per the standing directive: worktree lanes, builders never self-verify, verifier + adversary wave per merge, ledger per wave.

### W1 — Context Foundation (the seam)
- **Goal**: the passes stop being blind; "what's going on?" becomes answerable; composite questions become askable; epistemic caveats appear.
- **Scope**: (a) revive `WorkingContextProvider` as `packages/core/src/context/` assembler with per-pass and per-block budgets; (b) write thread state to `interaction_threads.metadata` (topic label, referent registry: last proposal/read/review items with refs+labels, **last stance**); (c) route pass gets a context header (last 2 exchanges + live referents, flattened); (d) **route schema → bounded read set**: `tools: string[]` (1–3) from a per-turn allowlist, `tool:"none"` semantics preserved, parallel execution, per-block token caps; read composition and action proposals mutually exclusive (schema-enforced + adversarial pin); (e) new read capability `day.state` — assembled over `queries/` + brief collectors (today/next, waiting, blocked/stalled, best-unlock, overnight delta, escalations), rendered as labeled structured text, principal-scoped; (f) staleness caveats: per-source `last_synced_at`/`last_tick_at` → freshness lines in day.state and DATA blocks; (g) "changed my mind" → **thread-local retraction** of the thread's last stance/proposal (canonical state only via explicit target through existing flows); (h) behavioral eval harness skeleton (scenario runner, fake-model hermetic) with first scenarios: referent continuity, day.state grounding, staleness honesty, composite multi-read.
- **Dependencies**: none.
- **Acceptance**: "what's going on?" (routed to day.state) returns coherent multi-section picture incl. waiting/blocked/unlock from live DB; composite scenario selects ≥2 reads and composes with per-block provenance; router resolves "the second one" against the referent registry in ≥90% of scenario corpus; "changed my mind" retracts thread stance with zero canonical-row changes (DB pin); staleness line present when calendar >6h stale; every day.state claim traces to a query (verifier spot-audit).
- **Security/adversarial**: injection corpus through new header/blocks; referent registry cannot reference other principals' threads; day.state principal-scoping test; read-set cannot include non-allowlisted or action capabilities (pin).
- **Rollback**: context header + day.state + read-set are additive read paths; feature flags via policy.yaml `gateway.context` section (fail-closed to current single-tool behavior).

### W2 — Memory Recall
- **Goal**: durable memory influences conversation, with attribution, never silently — and actually shows up when it should.
- **Scope**: `memory.recall` read capability — SQL over evidence/decisions/procedures/commitments (+ reviewed episodes) filtered by principal + domain sensitivity + recency + simple relevance (v1: term/domain match, pg trigram optional; **no vector DB** — revisit post-V1), ≤5 items, each rendered with source + date + assertion-kind label; composable within the W1 read set; recall never feeds capture/promotion (read-only pin); egress: recalled items pass existing sensitivity filter.
- **Dependencies**: W1 (context blocks, read-set).
- **Acceptance**: known-relevant scenarios — precision ≥80% **and recall@5 ≥85%** (R7); no-relevant-memory scenarios return empty (must-return-none pin — a system that never recalls is a failure, not a success); attribution present in 100% of recalls; zero new memory writes from recall path (DB pin); dogfood tracks recall-fire rate against golden expectations.
- **Security**: injection via stored memory content (flattening + trust labels); recall cannot surface other-principal rows; sensitive-classified items excluded per egress policy.

### W3 — Model Tiers (FAST/STANDARD/DEEP)
- **Goal**: reasoning quality policy-controlled, cost-visible, latency-bounded — experience first.
- **Scope**: policy.yaml `gateway.passes` extended: `answer_fast`, `answer_standard`, `answer_deep`, `answer_fallback`, and an `eval.judge` pass for W8; deterministic depth classifier in model-selection.ts (features: route tool-set, question-class markers, referent complexity, DATA-block count) → tier enum → policy map; **eval-gated default upgrade** of STANDARD (candidates: gpt-4.1, claude-sonnet class — decided by bake-off, §13); DEEP reserved for synthesis-class turns with a per-day DEEP budget **derived from the ratified envelope (R4, §18-1)**; answer_fallback for provider failure (one retry, existing pattern); latency/cost rollup script from `model_calls`; delete dead code (`escalationAuditFields`, unused param).
- **Dependencies**: W1 (context makes STANDARD worth paying for).
- **Acceptance**: tier distribution logged per turn; hermetic scenario suite passes at STANDARD where it failed at FAST; p50/p95 latency per tier within targets (§13); daily cost rollup runnable; adversarial: no route/model output string can influence tier beyond the fixed feature classifier (pin).
- **Rollback**: tiers map to current single model via policy edit; no schema changes.

### W4 — Interaction Profiles (persona, revised per R2)
- **Goal**: chief-of-staff register via structured, versioned, self-configurable presentation profiles; policy stays the security/default layer.
- **Scope**: (a) migration: `interaction_profiles` (principal_id, surface, version, definition jsonb — register, brevity, explanation style, address terms — created_via owner|self, created_at) with an active-version rule; policy.yaml gains a `personas:` section holding **only** default bindings, the profile-schema ceiling, and the on/off flag — no prompt text in policy; (b) context assembler injects the active profile fragment per pass; prompt fragments (profile + epistemic rules + tool instructions) versioned, `prompt_version` already ledgered in model_calls; (c) thread-scoped temporary overrides ("be brief today") live in `interaction_threads.metadata` and expire with the thread — never touch the profile; (d) persistent self-configuration through conversation: propose→confirm ("keep answers under 3 lines") → new profile version, audited, **principal modifies only their own profile**; (e) initial josctl chief-of-staff profile authored by lead, one-time owner approval (§18-2); yusra stub unless deferred (§18-4).
- **Dependencies**: W3 (tier-aware prompt assembly).
- **Acceptance**: profile consistency across scenario suite; capability resolution byte-identical under every profile version and under self-modified profiles (adversarial pin); self-config cannot alter ceiling-defined fields, other principals, or authorization (pins); thread overrides never persist (pin).
- **Rollback**: policy.yaml default-binding edit; profiles are inert without the assembler flag.

### W5 — Priority & Observed State (occurrence semantics per R1)
- **Goal**: "what's the one thing?" answered deterministically; planned/observed separation real and honest.
- **Scope**: (a) `queries/priority.ts` — scorer over: overdue owes_me with may_follow_up, deadline proximity, blocked-transitive-downstream (reuse leverage BFS), calendar imminent, waiting-on aging; ranked list with per-item reason strings; surfaced in day.state top-line + direct question; (b) calendar occurrence sweep (hourly): events whose end_time passed → `occurrence = scheduled_past_unverified` — **time passing is not evidence of occurring**; graduation to `observed_occurred` only on corroboration: explicit principal statement (user_declared, auto-applies per §18-5) or cross-source signal (e.g., gmail confirmation) which **surfaces a proposal to confirm rather than auto-graduating**; `observed_missed` via explicit principal correction only in V1; (c) commitment status transitions via conversational verbs under the **resolver rule (R6)**: bare `done/renegotiated/missed` mutate only when exactly one eligible item exists (thread-relevant, open, principal-scoped); zero → honest "nothing eligible"; multiple → require `[ref]` (review_refs codes) or a clarifying question; transitions carry user_declared provenance + audit + existing transition guards; (d) **plan divergence v1**: same-day calendar mutations (moved/cancelled within a lead-time window) — count + items, rendered as plan churn with explicit "actual day unverified" honesty; feeds evening close + calibration context; (e) migration 017: `calendar_events.occurrence` (+ `occurrence_confirmed_by` provenance), commitments transition audit fields.
- **Dependencies**: W1; (d) benefits from W3 DEEP narration but renders deterministically without it.
- **Acceptance**: "one thing" scenario corpus picks the blocking-overdue item ≥85%; renders never present `scheduled_past_unverified` as happened, nor calendar churn as verified fact about the day (label pins); commitment-verb resolver behavior pinned (sole→apply, none→honest, many→ref/clarify); plan-divergence block only when churn exists (suppression pin).
- **Security**: occurrence sweep is read-then-label (no external calls); commitment transitions principal-scoped + audited; adversarial: forged "done" from unpaired sender impossible (existing pairing gate).

### W6 — Initiative & Follow-Through
- **Goal**: bounded proactive intelligence; no spam.
- **Scope**: (a) reconcile-unknown workflow (15min) wrapping existing `reconcileCalendarAction`; (b) follow-up loops: succeeded actions tied to a future moment → next-morning one-line check-in question whose **answer graduates occurrence state** (W5 corroboration path); (c) nudge suggestions: overdue + may_follow_up + aging → brief line with pre-drafted message as a *proposal* (existing propose machinery, never auto-send); (d) interruption policy in policy.yaml `attention:` — quiet hours (default 22:00–07:00 PT), max unsolicited touches/day (default 3, briefs+calibration excluded), urgent-only midday window (escalation ≥ high, existing threshold); (e) attention decisions logged with reasons (why surfaced / why silent) — auditable restraint.
- **Dependencies**: W5 (priority feeds selection; occurrence graduation target).
- **Acceptance**: follow-up arrives for actionable outcomes and **not** for terminal successes (suppression tests); follow-up replies graduate occurrence per W5 rules; interruption cap enforced under burst simulation; "why didn't you bother me about X" answerable from attention log; calibration noise metric does not regress (weekly).
- **Security**: no new outbound channels; nudges ride existing proposal confirm flow; adversarial: nudge drafting cannot send without confirm token (existing).

### W7 — Self-Awareness
- **Goal**: "what can you see/do / why did you miss that / what are you?" answered from runtime truth.
- **Scope**: `system.state` read capability rendering: connected sources + freshness + coverage gaps (from calibration `source_not_connected` misses + read-tool coverage sentences), live capabilities (policy reads + grants + actions config), version (git SHA + deploy date env, set at build), monthly cost + call counts from ledger, known limitations (static honest list, versioned); "why missed" query path over calibration misses + attention log; **strictly read-only** — no self-modification surface of any kind.
- **Dependencies**: none (parallelizable with W2/W3).
- **Acceptance**: scenario: "can you send an email?" → honest no with capability list; "why didn't you catch that?" → cites miss classification + source coverage; version answer matches deploy.
- **Security**: system.state leaks no secrets/other principals (pin); no write paths (structural grep pin, mirroring edge send-only test).

### W8 — Evaluation & Calibration Closure
- **Goal**: intelligence is measured, not assumed — by gates that don't grade their own homework.
- **Scope**: scenario suite to full breadth (§13 list); live-judged mode uses an **independent judge** (policy `eval.judge` pass from a different provider family than the candidate under test, rotated where practical) plus **owner spot-checks** (weekly sample during dogfood; mandatory ≥20-turn sample before any model ratification); discordance between judges flagged in the report; hermetic structural tests remain the **primary hard gate** — LLM judges are evidence, not truth (R5); calibration metrics as product KPIs: daily rating trend, miss rate by source, useful/noise/incorrect ratios — weekly rollup extended; exit audit report.
- **Dependencies**: all waves (accretes from W1).
- **Acceptance**: see exit criteria §16.

---

## 8. Model Strategy

- **Current**: route=openai/gpt-4.1-mini (96.7% parse, 658ms), route_fallback=google/gemini-3.8-flash, answer=principal default gpt-4o-mini. Answer quality was never eval'd — only routing was.
- **Near-term (W3)**: three answer tiers + fallback + judge pass, policy-mapped:
  - FAST: acks, simple factual, single-tool lookups (4o-mini/4.1-mini class).
  - STANDARD (default): normal conversation, multi-turn, narration (gpt-4.1 / sonnet class — **chosen by the independently-judged bake-off**, not by taste).
  - DEEP: synthesis (full "what's going on" assembly, "why" chains, weekly reflection) — per-day DEEP budget derived from the envelope.
  - Selection = deterministic classifier → tier → policy map. Vendor names live only in policy.yaml.
- **Budgets (R4)**: the monthly envelope is decided **first** (§18-1); daily planning number and the DEEP/day cap are **derived** from it (formulas in §13). Budgets exist to catch runaway loops (lesson: the gmail retry storm), not to constrain the experience — sustained overshoot triggers an envelope decision with ledger evidence, never a silent downgrade of STANDARD/DEEP.
- **Future (post-V1)**: context-size-aware tier bumping, per-domain sensitivity routing, principal tier preferences, eval-driven quarterly re-selection with ledgered evidence.
- **Never**: models emitting model IDs; unledgered calls; tiers without budget caps; self-family judging of bake-offs.

## 9. Hermes Strategy

- **Owns (eventually)**: context selection/compression/assembly as a remote implementation of the `WorkingContextProvider` port; rolling summarization; relevance ranking beyond SQL v1; profile assembly offloaded per principal.
- **Never owns**: identity, authorization, conversation history storage, semantic memory, world model, policy (ADR-0003 already pins harnesses to cache-only).
- **When**: **not in Jarvis V1** (owner-endorsed in verdict). V1 ships the in-core deterministic assembler so the seam is proven under load + evals; Hermes becomes valuable when context assembly cost/complexity justifies a dedicated service. The port + its tests are the entire V1 Hermes obligation.

## 10. Memory Strategy

| Layer | Store | Lifetime | Feeds conversation via |
|---|---|---|---|
| Current-turn context | turn-local | request | direct |
| Working memory | interaction_messages (72h active) | 72h sliding | history block (existing) |
| Episodic raw | interaction_messages (retention) | 7d | recall v1: reviewed episodes only |
| Semantic memory | evidence/decisions/procedures/commitments | canonical | `memory.recall` (W2), provenance-labeled |
| World state | events/calendar/commitments/gmail | canonical | day.state + read set |

Promotion stays explicit (ADR-0004). Retrieval is the only new direction, always: bounded, principal-scoped, sensitivity-filtered, provenance-rendered, read-only.

## 11. Proactive / Attention Strategy

Notice (deterministic): overdue/aging commitments, blocked-transitive changes, action outcomes (unknown → reconciled; succeeded-with-future-moment → follow-up), **plan divergence** (calendar churn — labeled as plan change, never as verified day), escalations, calibration misses (source coverage gaps).
Decide: priority score + suppression rules (meaningfulness gates extended from briefs) + interruption budget (quiet hours, ≤3 unsolicited/day default, urgent=escalation≥high only).
Batch: everything non-urgent into morning/evening briefs (existing artifacts).
Escalate: existing escalation machinery at ≥high, unchanged.
Follow up: W6 loops; every attention decision journaled with its reason (silence is auditable).
Learn: calibration noise/miss weekly review feeds suppression thresholds (owner-adjustable via policy, not auto-tuning in V1).

## 12. Self-Awareness Strategy

Capability introspection (W7 `system.state`): from grants + policy reads + actions config + adapter registry — runtime truth, no static prompt. Source awareness: per-source freshness + coverage honesty sentences (W1 staleness) + gap synthesis from calibration misses. System status: version/deploy/health/cost/latency rollups from ledger + sensor state. Minimal self-model: versioned limitations document rendered on "what are your limits?". Future self-iteration (explicitly out of V1): observe→propose→isolated harness→worktree→evals→review→deploy loop — read-only introspection now, zero mutation surface.

## 13. Evaluation & Metrics

- **Offline (hermetic, CI)**: scenario suite — referent continuity, multi-turn reasoning, composite multi-read, recall relevance + attribution, missing-source admission, inference explanation, priority selection, noise suppression, principal isolation, profile consistency, tier appropriateness, ambiguity→clarify, conflicting evidence handling, injection resistance. Fake-model deterministic assertions for structure; golden outputs for renders. **Primary hard gate.**
- **Offline (live-model, manual/nightly)**: same scenarios through real models, judged by an **independent-family judge** (policy `eval.judge`; e.g., google judge for openai candidates and vice versa), rotated where practical; discordance flagged; budget-gated; results to `docs/evals/`. LLM judges are evidence, not truth.
- **Human**: owner spot-checks weekly during dogfood; mandatory ≥20-turn reviewed sample before any model ratification (R5).
- **Dogfood**: calibration nightly rating (world-model accuracy), useful/noise/incorrect on briefs/items, miss reports (first-class).
- **Latency**: per-tier p50/p95 from `model_calls.latency_ms` — targets: route ≤800ms p50; FAST ≤2s p95; STANDARD ≤4s p50/8s p95; DEEP ≤15s p95.
- **Cost (R4)**: envelope-first. Let E_soft/E_hard be the ratified monthly envelope (recommendation §18-1: $40/$90 for the proving phase, with an explicit revert decision at exit). Derived: daily planning = E_soft/30 (~$1.3); DEEP/day ≤ 0.5× daily planning; daily alert at 1.5× daily planning; monthly hard cap remains an absolute rail. Sustained overshoot = envelope decision with ledger evidence, never automatic downgrade.
- **Retrieval**: precision ≥80%, **recall@5 ≥85%**, must-return-none on no-relevant scenarios, dogfood recall-fire rate vs goldens.
- **Noise/miss**: interrupts/day actual vs budget; calibration miss-rate trend; follow-up suppression correctness.

## 14. Risk Register

| Risk | Vector | Mitigation |
|---|---|---|
| Context poisoning | recall/day.state content carries adversarial text | flattening + trust labels + injection corpus per wave; memory promotion gates unchanged |
| Prompt injection via sensors | gmail/calendar fields already partially mitigated | extend redaction tests to recall blocks + referent registry |
| Memory contamination | recall amplifies bad canonical rows | provenance rendering; review queue unchanged; misses flag sources |
| Overconfidence | model narrates planned/unverified as actual | occurrence labels + plan-divergence wording enforced in renders + scenario pins |
| Notification fatigue | initiative loops over-fire | interruption budget + suppression gates + calibration noise KPI |
| Model cost creep | DEEP tier overuse | envelope-derived caps, deterministic classifier, daily rollup alerts — envelope decisions on evidence, not silent downgrades |
| Eval self-preference | bake-off judged by same model family | independent-family judge + rotation + owner spot-checks + discordance report (R5) |
| Latency | assembled context + multi-read grows | per-pass/per-block token budgets in assembler (code-enforced); parallel read fan-out |
| Cross-principal leakage | new read surfaces + profiles | principal-scoped SQL + self-config own-profile-only + isolation tests per wave |
| Architectural drift | parallel memory/policy systems | single assembler, single query layer, single policy; verifier waves check for parallel systems |
| Self-modification risk | none in V1 by construction | read-only introspection, structural grep pin |
| Provider dependence | single-vendor outage | answer_fallback + multi-vendor policy map |
| Work-data creep | intelligence hungry for context | WorkSignals interface only; hard non-goal; gmail sensor pinned personal-domain (§15) |

## 15. Explicit Non-Goals

- Work data ingestion of any kind (no Slack/Granola/work-email/GitHub in personal core; Work Edge gets its own plan later — only the `WorkSignals` attention-input *interface* may be sketched in W5/W6 types). **The Gmail sensor is and remains personal-domain only; employer mailbox enrollment is prohibited** (Work Edge scope) — documentation pin per owner verdict.
- Voice, general computer control, autonomous financial action, autonomous outbound sends.
- Unlimited autonomy; self-modification; new sensors (finance/Plaid waits on owner keys).
- Vector DB / embedding retrieval (v1 is SQL relevance; revisit with evidence).
- Auto-tuning attention thresholds from calibration (owner adjusts via policy in V1).
- Auto-graduating occurrence from time-passing or single weak signals (corroboration required, §5-7).
- Multi-user scaling, new surfaces beyond iMessage.
- Hermes as a service.

## 16. Jarvis V1 Exit Criteria

All of the following, measured, not vibes:

1. Multi-turn referent scenario suite ≥90% (hermetic) — "the second one"/"changed my mind" resolve or clarify, with thread-local semantics (zero canonical writes from "changed my mind").
2. Profile consistent across scenarios; capability resolution byte-identical under every profile version incl. self-modified (test).
3. STANDARD answer tier live as default, chosen by a ledgered **independently-judged** eval with owner-reviewed sample; FAST/DEEP distribution logged.
4. Recall: precision ≥80% **and recall@5 ≥85%** hermetic, attribution in 100% of recalls, must-return-none passing; zero recall-path writes.
5. "What's going on?" end-to-end scenario returns prioritized multi-section answer with provenance and staleness caveats — from live DB in dogfood, not fixtures; composite questions compose ≥2 reads when warranted.
6. "What do I actually need to deal with?" returns ranked output with reasons; ≥85% agreement with scenario goldens.
7. Occurrence labels pinned: `scheduled_past_unverified` never rendered as happened; calendar churn rendered as plan divergence; `observed_occurred` always carries corroboration provenance.
8. "Why do you believe X" answers cite sources (thread, memory w/ date, sensor).
9. "What can you see/do" answered from runtime state, matching grants/policy exactly.
10. Proactive touches ≤ budget/day in dogfood over 2 weeks; ≥1 meaningful follow-up per week acting on its own actions; calibration noise ratio not worse than pre-V1 baseline.
11. Calibration daily rating + useful/noise/incorrect + miss-rate trended weekly and reviewed with owner at exit.
12. Principal isolation adversarial suite green (incl. recall + day.state + system.state + profiles).
13. WorkSignals interface (types + doc section) exists such that a future Work Edge can feed attention inputs without redesign — no other work-data surface.
14. Full suite + lint green; latency/cost within §13 targets on a 2-week dogfood sample.

## 17. Recommended Execution Order

```text
W1 Context Foundation            (seam: assembler, thread state, read-set, day.state, staleness, eval skeleton)
 ├── W2 Memory Recall            (parallel lane)
 ├── W3 Model Tiers              (parallel lane; independently-judged STANDARD bake-off; envelope-gated DEEP)
 └── W7 Self-Awareness           (parallel lane — zero deps)
W4 Interaction Profiles          (after W3)
W5 Priority & Observed State     (after W1; overlaps W4 harmlessly — separate tables/paths)
W6 Initiative & Follow-Through   (after W5)
W8 Evaluation & Calibration Closure (harness grows from W1; formal closure last)
```

Rationale: W1 unblocks three independent lanes; judgment layers (W5/W6) need the seam but not the profiles; measurement accretes so exit criteria are already instrumented by W8 rather than retrofitted. Each wave ships behind policy.yaml switches with fail-closed defaults.

## 18. Open Decisions Requiring Jehad

1. **Monthly envelope for the proving phase** (W3): recommended $40 soft / $90 hard for the V1 dogfood window with an explicit revert-to-$20/$50 decision at exit; daily/DEEP/alert budgets derive from it (§13). Experience first — the envelope exists to catch runaway loops, not to ration reasoning.
2. **Initial josctl chief-of-staff profile** (W4): one-time approval of the lead-authored profile; thereafter self-configurable through conversation (thread-scoped overrides free, persistent changes versioned).
3. **Interruption defaults** (W6): quiet hours 22:00–07:00 PT, ≤3 unsolicited touches/day — confirm or adjust.
4. **yusra profile in V1**: josctl-only (recommended) vs drafting hers now.
5. **Occurrence corroboration policy** (W5): recommended — explicit principal statements auto-graduate (`observed_occurred`, user_declared provenance); cross-source signals (e.g., gmail confirmations) surface a confirm-proposal rather than auto-graduating; `observed_missed` principal-declared only.

*(Hermes deferral was confirmed by owner verdict and is no longer open.)*

---

*Revision 2 incorporates the owner verdict of 2026-09-21 (seven revisions + the Gmail personal-domain documentation pin). Grounded in repository audits at `c65ec8a`; all file:line references verified by three independent read-only audits. Planning is closed; execution proceeds under the standing parallel directive.*
