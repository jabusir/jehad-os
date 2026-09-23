# Jehad OS — Delegate & Watch Roadmap (Useful When Nobody Is Talking to It)

- **Status:** proposed 2026-09-22. Planning artifact only — no code. Grounded in
  `main` @ `8dadfee` (tree clean at drafting; now carries uncommitted planning
  artifacts — see §0 re-verification). Plan-review loop complete (turns 1–9;
  drafter + proposer both declare ready for build; final grounding re-checked
  2026-09-22: cited artifacts exist, no conflicting migrations, no open
  markers). Awaiting owner review, then ratification.
- **Question this plan answers:** *How do we make Jehad OS genuinely useful when
  Jehad is not talking to it?* The unit of progress shifts from "smarter replies"
  to **useful work completed while the owner was absent**, verified independently.
- **Relation to prior artifacts:** this is the concrete execution plan for
  directive Phase 3 (durable delegation) plus Watch, sequenced after Wave F/SV/T
  closure (`docs/plans/feedback-and-self-verification.md`) and the Jarvis V1
  leftovers (`docs/plans/jarvis-v1.md`). It supersedes no accepted ADR; it
  implements what ADR-0008/0011/0013/0015 and the §40 program contract already
  permit. It does **not** adopt the "evolve vs replace" framing as a new
  architecture decision — the five-plane shape below is a reading of what the
  repo already has (§3).

## 0. Verification record (what was inspected)

Verified against `main` @ `8dadfee`, 2026-09-22:

- Kernel: `packages/core/src/**` (~31.7k LOC non-test): `imessage/conversation.ts`
  (2,499 lines, `converseTurn` L784+), `policy/ceiling.ts` (944), notifications,
  escalations, promotions, commitments, reminders, briefs, queries (priority /
  leverage / blocked / waiting / day-state / self-brief / staleness / lessons),
  claim audit, model budget ledger, actions, grants, egress.
- Data: `packages/db/migrations/000..022` (37 tables). No outcome / watch /
  assignment / verifier / delegation table exists anywhere (grep-verified,
  re-confirmed this turn).
- Execution: `packages/adapters/src/ports/workflow-runtime.ts` (start / signal /
  cancel / status) + faithful impl `packages/workflow/src/runtime.ts` incl.
  `waitForSignal` and `pauseForApproval` (per-run unique event names
  `jehad/signal/<runId>/<name>`, `jehad/approval/<runId>/<id>`). **Zero callers
  outside `packages/workflow`** — all 12 registered functions are cron-polling
  (`apps/worker/src/workflows.ts`). The `runs`/`human_waits` correlator exists
  (`packages/workflow/src/correlator.ts`) but is **not wired** into
  `apps/worker/src/index.ts`, so cron firings do not write `runs` rows.
  Boundary test `packages/workflow/src/boundary.test.ts` keeps Inngest imports
  confined; `devserver.test.ts` proves kill/resume against a real dev server.
- Sensors/edges: calendar syncToken sync (15-min), gmail historyId sync (5-min,
  `gmail.readonly`, content-free metadata + billing-sender extraction),
  iMessage inbound sensor (chat.db read-only, FDA wrapper, paired-handle
  content rule), edge-agent (send-only osascript + imsg-plus typing, grant
  `send_channel:imessage`), staleness view (6h) across the three sources.
- Docs/ADRs: ADR-0001..0015; directive §9/§28/§32/§40; phase0 plan; jarvis-v1
  rev 3; feedback-and-self-verification (Wave F/T/SV).
- **Re-verified 2026-09-22 (post-draft reconciliation, turn 5 of plan
  review):** `main` unchanged (`8dadfee`); no code has landed. The working
  tree is **no longer clean**: it now carries uncommitted planning artifacts —
  `docs/adr/ADR-0016-gmail-content-ingestion.md` and
  `docs/adr/ADR-0017-outcome-execution-semantics.md` (untracked **drafts**,
  cited throughout this plan as the governing decisions for GC0/D0; they land
  with ratification, before any wave that depends on them), the canonical
  `docs/plans/delegate-watch-roadmap.md` (untracked), and alignment edits to
  `docs/plans/gmail-sensor-contracts.md` + `docs/threat-model.md`. Correction
  pass applied the same day: Gmail content ingestion (ADR-0016), outcome execution semantics
  (ADR-0017 — first-class criteria, typed predicates, wait/resume handshake,
  Outcome/Commitment/Task contract). Migration numbers shifted accordingly:
  gmail content 023 (implemented first), outcomes 024, watches 025,
  assignments 026.

## 1. Executive summary

Jehad OS is already a governed kernel with a strong conversational surface: it
answers truthfully (send-time claim audit), remembers with provenance, tracks
commitments/reminders/calendar, and interrupts politely. What it cannot do yet
is **carry an outcome**: nothing in the repo represents "what Jehad asked the
system to accomplish", no process owns work across time, nothing waits on the
world and resumes, and no worker's claim of success is independently verified —
because there are no workers.

The gap is not another sensor, memory layer, or model. It is three durable
primitives the directive already planned (§32 Phase 3, §40 items 11–19):

```text
OUTCOME   — a confirmed desired result, owned by canonical state, executed by
            a durable process that plans, dispatches, waits, resumes, verifies.
WATCH     — a persistent desired-state condition, observed by events/polls,
            silent when nothing changed, escalating only real transitions.
ASSIGNMENT— a bounded, budgeted, granted unit of work for a role-scoped worker,
            verified by a separate verifier assignment (builder ≠ verifier).
```

The decisive repo finding: **the execution machinery is mostly built and
orphaned.** The `WorkflowRuntime` port, durable waits, approval pauses,
event/outbox ledger, action-intent machinery, escalation queue, and budget
ledger all exist. Wave D0 is therefore mostly **wiring, not construction**:
give the port its first real consumers, put waits in Postgres so they survive
restarts, and route canonical events into resume signals.

Plan shape (waves detailed in §19):

```text
NOW        close F/SV remnants (incl. the Sep 26 grant-reminder deadline),
           wire the runs correlator                        (days)
GC0        Gmail content ingestion (023; ADR-0016)
D0         Outcome primitive + durable waits + resume router
D1         Worker contract (HarnessAdapter v1, assignments, budgets)
D2         ResearchWorker (model-bounded, no new harness)   } D2/D3
D3         Verifier + completion gate                        } overlap
D4         First real Delegate vertical: "Chase & Close"     ∥ W0 Watch foundation
W1         Watch → follow-through (resume delegated work)
CR0/CR1    Control Room: CLI first, then loopback web
DOGFOOD    2-week unattended-work trial + attention tuning
GATED      Memory V2 · orchestrator decomposition · Work Edge · work sensors
```

Three things make this cheaper than it looks: (1) Delegate intake reuses the
existing propose→confirm turn interpreter (W6 proposals extend by one type);
(2) judgment escalation reuses escalations + notifications + `pauseForApproval`;
(3) verification extends the ADR-0015 style — deterministic, DB-grounded checks.

One operational fact becomes material for the first time: **unattended work
requires an always-on host.** Today everything runs on this laptop against an
unsigned Inngest dev server, and the E2 hosting decision (also Inngest
managed-vs-self-hosted) is still standing. D4's "morning after" dogfood cannot
be honest until E2 lands or an interim keep-awake discipline is accepted.

## 2. Repository-grounded current state

### 2.1 What exists and is reusable

| Capability | Where it lives today | Disposition for Delegate/Watch |
| --- | --- | --- |
| Canonical state + events/outbox ledger | `packages/db` (37 tables), `packages/core/src/events` (atomic events+outbox write, `store.ts`), dispatcher `apps/api/src/outbox.ts` (idempotent, retrying) | **Reuse** — outcomes/watches/assignments are new rows + additive event types (ADR-0006) |
| Policy / grants / autonomy ceiling / egress | `policy.yaml`, `packages/core/src/policy/*`, `packages/core/src/egress/*` | **Reuse** — worker grants and reaction ceilings are new entries, not new machinery |
| Action intent → attempt → outcome (unknown + reconcile) | `packages/core/src/actions/*`, migrations 002/014 | **Reuse** — every external side effect an outcome takes rides this |
| Durable workflow runtime + waits + approval pauses | `packages/adapters/src/ports/workflow-runtime.ts`, `packages/workflow/src/runtime.ts`, `definition.ts` (`waitForSignal`, `pauseForApproval` w/ `human_waits` rows) | **Reuse — currently orphaned.** D0 gives it real consumers |
| Escalations + human-wait intervals + notifications queue (ratified autoApproveKinds, dead-letter sentinel, claim-lease delivery) | `packages/core/src/escalations`, `packages/core/src/notifications`, migration 006/010 | **Reuse** — decision requests and progress batching ride this |
| Judgment-free turn pipeline w/ propose→confirm | `packages/core/src/imessage/conversation.ts` (route/answer tiers, W6 turn interpreter proposals: `task_batch`, `system_feedback`, …) | **Extend** — one new proposal type `outcome_spec`; confirm verb creates the outcome |
| Truthfulness machinery | ADR-0015 claim audit + lessons (`converse.claim_audit`, nightly harvest, ratified LESSONS block) | **Reuse** — verifier findings reuse the same "DB is authoritative" style |
| Commitments / reminders / briefs / priority / waiting / blocked / leverage queries | `packages/core/src/commitments`, `…/reminders`, `…/briefs`, `…/queries/*` | **Reuse** — outcomes surface through briefs and `theOneThing` |
| Model access w/ egress + race-safe budgets (`model_calls`) | `packages/core/src/model/call-model.ts`, deep-tier budget (`packages/core/src/imessage/deep-budget.ts`), per-principal×surface budgets | **Reuse** — per-outcome/assignment budget = new scope key on the existing barrier |
| Sensors: Calendar, Gmail (two policy-distinguished data classes: `gmail.metadata` + `gmail.content`, ADR-0016), iMessage in; iMessage out via edge | `packages/core/src/{calendar,gmail,imessage}`, `apps/imessage-sensor`, `apps/edge-agent` | **Reuse + one capability expansion** — Gmail observation depth extends metadata→bounded content (§13). No new external services |
| Multi-principal isolation (pairing, per-principal grants/budgets/turn locks) | migration 010/011/012, `packages/core/src/imessage/pairing.ts`, `policy.yaml gateway.principals` | **Preserve** — outcomes are principal-scoped like everything else |
| Occurrence epistemics (planned ≠ observed; user_declared graduates) | migration 017, `src/calendar` | **Reuse** — the same planned/observed discipline governs outcome completion |
| Evals (golden extraction, model routing, answer quality) | `evals/*`, `docs/evals/*` | **Extend** — outcome/watch scenario suites (§20) |

### 2.2 Wave status the roadmap inherits

- **Landed:** F1–F3 (ratified kinds into every producer + dead-letter
  sentinel), SV1–SV3 (claim audit, one grounded revise, lessons), ADR-0015;
  Wave T typing (imsg-plus IPC path; default OFF pending owner host decision).
- **Open, urgent:** **F5 — grant-reminder must be verified delivered before the
  ~Sep 26 `imessage:ingest` grant expiry**; F4 — live calibration
  prompt_sent→claimed→delivered check.
- **Open, SV4 remainder:** standalone nightly drift report;
  **promise-without-artifact nightly reconciliation**; sent→delivered-break
  sentinel — none found in code (claim-drift/dead-letter/denial-spike signals
  exist in `lesson-harvest-workflows.ts`).
- **Open, Jarvis V1 remainder (§16/§18):** scheduled **reconcile-unknown
  workflow** and **follow-up loops on own action outcomes** (W6-phase-2 beyond
  reminders), nudge suggestions as proposals, attention decision log, W8
  closure (scenario suite + judge bake-off + measured §16 exit criteria); owner
  decisions: monthly envelope, chief-of-staff profile, interruption defaults,
  yusra profile, occurrence corroboration.
- **Standing gates:** E2 hosting (now materially urgent, §19 NOW) · E3
  satisfied (Calendar/Gmail live) · E4 satisfied in its narrow send/deliver
  form (edge-agent), future expansion re-gated.

### 2.3 Genuinely missing (the whole build list)

1. An **Outcome** entity + state machine (no table, no events, no process).
2. **Watches** (none; cron prompts are explicitly not watches).
3. **Assignments/workers** (no `HarnessAdapter` implementation; port exists).
4. An independent **Verifier** with a completion gate.
5. **Event-driven resume** of waiting work (nothing signals anything today).
6. `runs` correlation for existing cron workflows (observability gap).
7. A **Control Room** surface beyond iMessage + `josctl`.
8. Per-outcome budget/deadline/replan ceilings.

Nothing else in the repo blocks this roadmap.

## 3. Architectural assessment

The proposed five-plane separation is validated, with one correction: the repo
already implements four of the five planes; the **execution plane is the thin
layer**, and it is thin because the runtime port is orphaned — not because it
is missing.

```text
                JEHAD (+ YUSRA later, per owner decisions)
                     │ paired principals (ADR-0013)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ EXPERIENCE    iMessage gateway (converse grant, budgets,        │
│               personas, claim audit) · josctl · Control Room    │
│               (new, CR0/CR1) — iMessage stays primary           │
└──────────────┬──────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────┐
│ EXECUTIVE     conversation.ts turn pipeline (route → interpret  │
│               → answer), context assembler, memory recall,      │
│               priority/leverage queries, self-brief, briefs.    │
│               DELEGATE intake = one new proposal type.          │
│               This plane stays the ONLY user-facing manager.    │
└──────────────┬──────────────────────────────────────────────────┘
               ▼ proposes / confirms (deterministic verbs)
┌─────────────────────────────────────────────────────────────────┐
│ CONTROL       Postgres canonical state: outcomes, watches,      │
│               assignments (new) + commitments, decisions,        │
│               events, evidence, audit, policy, grants,           │
│               action intents, escalations, human_waits, runs,    │
│               model_calls (existing)                             │
└──────────────┬──────────────────────────────────────────────────┘
               ▼ governed work (outbox → workflow dispatch)
┌─────────────────────────────────────────────────────────────────┐
│ EXECUTION     Inngest via WorkflowRuntime port (FIRST real      │
│               consumers): outcome-executor, resume router,      │
│               watch-evaluator · workers = HarnessAdapter v1     │
│               (model-bounded roles) · verifier assignments      │
└──────────────┬──────────────────────────────────────────────────┘
               ▼ grants (scoped, expiring, token-verifiable)
   PERSONAL EDGES: iMessage in/out · Gmail (RO) · Calendar (RO+1 confirm write)
   WORK EDGE: unchanged — absent from the personal core by design (§14)
```

Refinements to the prompt's sketch, grounded in repo reality:

- **Executive is already single.** No agent zoo is created; workers are typed
  roles dispatched through `HarnessAdapter` (§8), consistent with
  `docs/harness-architecture.md` §5. The executive keeps intent, planning
  priority, and what-needs-Jehad; planning decomposes outcomes into
  assignments, not conversations.
- **Control plane owns waits.** The prompt's "suspend durably / resume on
  event" is implemented as Postgres rows (`outcome_waits`), not as Inngest
  state — this is what makes restart survival free and the runtime swappable
  (ADR-0008 authority split, preserved exactly).
- **Experience plane gains a surface, not a store.** Control Room (§16) is a
  projection of canonical state over existing read queries; it never becomes
  a second truth store (cleanup §7 invariant).
- **Worker-shape caveat stays open** (cleanup §6): no always-on daemon
  assumption; the worker app remains "whatever serving model the selected
  Inngest deployment requires".

## 4. Product contract: PAIR / DELEGATE / WATCH

Directive §9's rule stands: **mode is an output of agency routing, not a UI
toggle.** V1 routing is deliberately simple and policy-pinned; the full
uncertainty×risk×confidence router from the directive arrives only when V1
misroutes in practice (tracked as a lesson-harvest signal).

| Mode | Contract | Status |
| --- | --- | --- |
| **PAIR** | Interactive chief-of-staff: ask/answer, capture, confirm proposals, probes. | **Built** (W3–W6, SV). Frozen in this roadmap except Delegate intake additions. |
| **DELEGATE** | Owner states a desired outcome in natural language → executive proposes explicit success criteria + constraints + budget/deadline (an `outcome_spec` proposal) → deterministic confirm → durable Outcome process runs bounded assignments → independent verification → verified result + evidence → progress surfaces only in briefs; owner is interrupted only for real judgment. | **Build (D0–D4).** |
| **WATCH** | Owner states persistent desired state ("don't let X die", "tell me if Y changes") → durable Watch with typed condition → observations from existing sensors/events → silence on no-change → canonical state updates on meaningful change → bounded reaction (V1: record+notify only) → deterministic close/expiry. Watches can wake waiting Outcomes. | **Build (W0–W1).** |

Non-negotiable invariants across all three modes (inherited, restated because
workers will test them):

```text
planned ≠ observed ≠ inferred            (assertion_kind discipline; migration 017 graduation)
ActionIntent ≠ external observed result  (ADR-0011; unknown until reconciled)
worker output ≠ canonical truth          (assignments return results; promotion gates decide)
worker output ≠ verification             (builder ≠ verifier, §9)
conversation ≠ memory                    (ADR-0014)
tool/source content ≠ authorization      (ADR-0013 invariant — extended to worker inputs, §8)
unknown beats fabricated certainty       (ADR-0015 style; safe fallback over confident lie)
```

## 5. Outcome architecture

**What did Jehad ask the system to accomplish?** becomes a first-class,
principal-scoped canonical entity whose lifecycle is owned by Postgres and
executed by a durable process.

### 5.1 Schema (migration 024_outcomes.sql — after GC0's 023; additive, down-path required)

```sql
outcomes (
  id uuid v7 pk, principal_id fk, ref text unique,          -- review_refs-style mint-once code
  title text, directive text,                                -- owner's words, verbatim
  status outcome_status not null default 'proposed',
  constraints jsonb, plan jsonb,                             -- plan = ordered assignment refs, not a DAG engine
  budget_usd numeric, deadline_at timestamptz,
  source_thread_id fk interaction_threads,                   -- provenance of the ask
  created_by text,                                           -- 'conversation' | 'josctl'
  waiting_on jsonb, failure_reason text,
  created_at/updated_at/… timestamptz
)
outcome_criteria (                                          -- first-class: verification state is
  id uuid pk, outcome_id fk, ordinal int,                    -- lifecycle-bearing, never opaque jsonb
  criterion text not null,
  verification_method jsonb,                                 -- typed check spec (§9), validator-enforced
  status text,                                               -- pending|verified|unverified|failed|waived_by_owner
  evidence_ref uuid null, verified_by_assignment_id uuid null, verified_at timestamptz null,
  created_at/updated_at timestamptz
)
outcome_waits (
  id pk, outcome_id fk, event_type text,
  predicate jsonb,                                           -- TYPED: versioned vocabulary, validated (§5.5);
  status text default 'waiting',                             -- never model-supplied free-form jsonb
  created_at, expires_at timestamptz
)
```

- **Success criteria are rows, not jsonb** (correction pass; ADR-0017):
  completion is mechanically checkable — every criterion carries
  status/verification method/evidence/verifier/timestamp, and worker prose
  can never mutate criterion status (only a verifier assignment or an owner
  waiver can).
- Status transitions guarded by a DB trigger (pattern: migration
  `002_action_transition_guard.sql`); history rides `outcome.*` events, no
  duplicate log table. Completion gate: `verifying → completed` requires
  every required criterion `verified` (or `waived_by_owner`) **and** ≥1
  succeeded verifier assignment carrying `evidence` rows.
- New event types (additive): `outcome.created · accepted · status_changed ·
  wait_started · wait_satisfied · completed · failed · cancelled · blocked ·
  escalated`.
- **Status set** (D0; refined only with evidence of need):

```text
proposed → accepted → queued → running ⇄ waiting_external
                                    ⇄ waiting_user
                                    ⇄ blocked → running
                          running → verifying → completed
       any (pre-terminal) → failed | cancelled
```

- **Completion gate = criteria, mechanically**: an outcome completes only
  when its `outcome_criteria` rows satisfy the completion policy and
  verifier evidence exists (above). `unverified`/`failed` criteria keep the
  outcome honestly open.
- Reuse, not duplication: an outcome's external side effects ride
  `action_intents/attempts` (ADR-0011); its spend rides `model_calls` (new
  nullable `assignment_id`/`outcome_id` columns); its human waits ride
  `human_waits` via `pauseForApproval`; its results/artifacts ride `artifacts`
  + `evidence`; its judgment requests ride `escalations`.
- **Retention interaction (must-handle):** `interaction_messages` are deleted
  at 7 days (ADR-0014). Anything an outcome/verifier needs from a thread
  (quoted text, counterparty claims) must be captured into `artifacts`/
  `evidence` **at assignment/verification time**, never re-read from the
  thread later.

### 5.2 The outcome process (one Inngest function per outcome)

`outcome-executor`, started through the `WorkflowRuntime` port by the confirm
verb (first real port consumer):

```text
loop (each iteration writes outcome.status_changed + updates plan):
  read canonical state (domain services only)
  if plan incomplete and assignable work exists:
      create assignment (grant + budget + deadline)      → dispatch worker (D1)
      await assignment result
      if builder succeeded: create verifier assignment   → await verification
          verified: record evidence, advance plan
          not verified: one bounded repair pass, else blocked/failed
  else if success criteria met: → verifying → completed (gate, §9)
  else if waiting on world: insert outcome_waits row → status=waiting_external
      → register step.waitForSignal → RE-READ canonical wait row
      → if already satisfied: continue immediately (lost-wakeup handshake)
      → else: remain suspended
  else if human judgment needed: raise escalation (decision envelope, §11)
      → pauseForApproval → suspend
```

- **Wait/resume lost-wakeup handshake is structural, not best-effort**
  (correction pass; ADR-0017): CAS on the wait row prevents double
  satisfaction but cannot prove wake delivery — the resume router may
  satisfy+signal *before* the executor registers its runtime wait. The
  executor therefore always re-reads the canonical wait row after
  registering; a nightly `wait-reconciler` re-signals any
  `satisfied wait + parked outcome` pair. All operations idempotent;
  **Postgres state alone is always sufficient to recover** (kill between
  DB transition and signal included).

Guards, all policy-pinned (`policy.yaml outcomes:`): max concurrent outcomes
per principal, default budget + hard budget (existing spend barrier), wall-
clock deadline, **max consecutive auto-iterations without canonical progress**
(runaway breaker), max auto-replans (V1: 2; beyond that → escalate).

**Orphan reaping:** a daily `outcome-reaper` cron fails/parks outcomes past
deadline or budget, expires stale waits, and reports in the evening brief —
no outcome may die silently.

### 5.3 Intake

- **Conversation:** the W6 turn interpreter's proposal vocabulary gains
  `outcome_spec {title, directive, success_criteria[], constraints[], budget,
  deadline}`; confirm verb (deterministic, existing machinery) creates the
  row + `outcome.created` and starts the executor. Refusal stays honest: the
  interpreter only proposes what policy allows.
- **CLI:** `josctl delegate "<directive>"` for fat-fingered-free entry and
  tests.

### 5.4 Outcome vs Commitment vs Task (semantic contract, ADR-0017)

```text
TASK       — a unit of work that should be done.
COMMITMENT — an obligation/promise/expected responsibility involving a
             person or entity (existing table; direction owes_me|i_owe).
OUTCOME    — a desired result Jehad OS has ACCEPTED RESPONSIBILITY for
             advancing over time (new; owner-confirmed, durable).
```

Relationships: an Outcome may contain tasks (assignments) and may create or
monitor commitments; a commitment may exist without an outcome; a task may
exist without an outcome; an outcome is not automatically a commitment.
**No duplicate surfacing**: the same real-world obligation must not appear
as three objects — priority/waiting/brief queries de-duplicate via explicit
links (`relationships` edges + `outcome.source` refs), with fixtures proving
coexistence (e.g., prenup outcome + attorney commitment + review task remain
three distinct, linked, non-duplicated rows).

### 5.5 Typed wait/watch predicates (versioned, validated, non-executable)

`outcome_waits.predicate` and `watches.condition` are validated against a
small versioned vocabulary — **never arbitrary jsonb execution**:

```ts
type Condition =
  | ArrivalConditionV1        // event/source arrival (gmail from-sender, thread handle, calendar)
  | AbsencePastConditionV1    // aging past a bound (commitment/reminder/outcome)
  | StateChangeConditionV1    // canonical state diff (outcome status, calendar projection)
  | ThresholdConditionV1;     // numeric bound (spend, counts)
```

Each type has a typed schema, version, validator, and matcher, with tests.
Rejected outright: arbitrary SQL, JSONPath from models, user-defined
executable expressions, eval(), any rules-engine DSL. A model may *propose*
a condition; code validates and canonicalizes it or refuses it.

## 6. Watch architecture

A Watch is durable desired-state observation — not a scheduled prompt. It is
a smaller cousin of the Outcome: condition, observation, reaction ladder,
closure.

### 6.1 Schema (migration 025_watches.sql)

```sql
watches (
  id pk, principal_id fk, ref text unique,
  source_thread_id fk interaction_threads null,         -- provenance of the ask (same rationale
  created_by text,                                      -- as outcomes, §5.1)
  subject text, condition_type text, condition jsonb,   -- TYPED predicate, §5.5 vocabulary (validated, versioned)
  mechanism text,                                        -- 'event' | 'poll' | 'event+poll'
  poll_cron text, reaction jsonb,                        -- v1: {record, notify:{max_urgency}}
  status text,                                           -- active | triggered | resolved | expired | cancelled
  last_observed_at timestamptz, last_state jsonb,
  escalation_threshold jsonb, expires_at timestamptz
)
```

Events: `watch.created · observed · triggered · resolved · expired ·
cancelled` (additive). A `watch-evaluator` workflow consumes relevant events
and runs a low-frequency sweep for `poll` watches.

### 6.2 V1 condition vocabulary (typed, small, extensible)

| Condition | Over | Example |
| --- | --- | --- |
| `arrival` | gmail metadata from-sender, thread messages from handle, calendar event | "when Acme replies" |
| `absence_past` | commitment/reminder/outcome age | "don't let this commitment die" |
| `state_change` | outcome status, calendar projection diff, watch-defined entity | "if the launch date moves" |
| `threshold` | numeric field (V1 sources: budget spend, counts) | "if spend > $X" |

Sensors emit the events already; watches only add the **desired-state
comparison**. No-change observations write nothing user-visible (a
`watch.observed` event + `last_observed_at` only).

### 6.3 Reaction ladder (attention discipline)

```text
record (canonical event) → surface in briefs → notify (notification queue,
ratified kinds/urgency) → escalate (judgment threshold) → bounded action
(OUT OF V1 — requires O-8 owner decision; would ride action_intents)
```

Watch → Delegate coupling is the W1 payoff: a watch trigger satisfies a
matching `outcome_waits` predicate (same resume router), so "watch their
reply" and "resume when they reply" are one mechanism.

Reaping: watches expire deterministically (`expires_at`, default 30d),
reported in the evening brief before expiry; nothing watches forever silently.

## 7. Workflow runtime strategy

**Decision: stay on Inngest. Do not migrate.** ADR-0008 is accepted with a
passed spike; nothing in this roadmap requires semantics Inngest lacks. The
only real change is that the `WorkflowRuntime` port finally gets consumers.

- **The port is already the seam.** `packages/adapters/src/ports/workflow-runtime.ts`
  has exactly the right surface (`start/signal/cancel/status` + the impl's
  six-state `detailedStatus` extension and `approve:` signal routing). D0 adds
  **no** new port operations: waits are modeled as `outcome_waits` rows +
  `step.waitForSignal`; approvals as `pauseForApproval`; sleeps as
  `step.sleep`. Domain code never learns Inngest's vocabulary (boundary test
  already enforces this).
- **One gap to close, not a new abstraction:** wire `createSqlRunCorrelator`
  into `apps/worker` so every workflow firing writes canonical `runs` (+
  `human_waits` for approvals). Today nothing does — this is prerequisite
  plumbing for per-outcome cost accounting and Control Room truth.
- **Resume routing** (the "world changed" half-life): canonical events already
  flow `events → outbox → workflow dispatch`. Add `outcome-resume-router`: an
  Inngest function triggered by dispatched outcome-relevant events that (1)
  CAS-transitions matching `outcome_waits` rows `waiting→satisfied`
  (idempotent under at-least-once dispatch), (2) `runtime.signal`s the parked
  executor run. Because wait state lives in Postgres, **restart survival is
  structural**, not a feature (canonical flow per `docs/workflow-runtime.md` §3).
- **Objective triggers for a future runtime evaluation** (record, don't act):
  hundreds of concurrently-parked long-lived processes; month-scale waits in
  production; heavy run signaling/query patterns; worker-versioning/replay
  pain demonstrably corrupting outcomes; managed-Inngest cost/reliability
  failure at E2. Any trigger → owner decision before any migration work
  (same disposition rule as ADR-0008's spike gate).

## 8. Worker contract

Workers are **roles with typed assignments**, not personalities. The contract
lands on the already-defined `HarnessAdapter` port
(`docs/harness-architecture.md` §5.2), giving directive §40 item 16 (delegation
through a HarnessAdapter) its first satisfied instance.

### 8.1 V1 adapter: `ModelHarnessAdapter`

The first implementation is in-process and model-bounded — no external coding
harness, no browser. It implements `start/status/cancel/artifacts` over
Inngest-backed runs and `capabilities()` from policy. `logs` returns a stub
stream (audit_log covers V1 observability). This honors cleanup §1 (no adapter
built merely to exercise an interface — this one has a real consumer) and the
not-now rule against coding-worker orchestration.

### 8.2 Roles (V1: exactly two, plus re-use of the executive as planner)

| Role | Does | Verification hook |
| --- | --- | --- |
| `research` | Bounded multi-source synthesis over granted read capabilities (canonical queries, gmail metadata, calendar, thread artifacts) + model reasoning; returns draft/answer + citations into `evidence` | verifier checks cited facts against canonical state and source-bearing artifacts |
| `verifier` | Independent pass over a builder assignment: re-derives claims from DB/source evidence, runs deterministic checks, returns verdict + evidence | is the verification hook |
| `browser`, `coding` | **Not built.** They unlock Amano web work and self-engineering respectively; both are gated waves after Delegate V1 (§18, §23). |

### 8.3 Assignment envelope (migration 026_assignments.sql)

```sql
assignments (
  id pk, outcome_id fk null (watches may dispatch too), role text,
  status text,                        -- proposed|queued|running|waiting|succeeded|failed|cancelled
  input_ref fk artifacts,             -- the bounded context package
  success_criteria jsonb,
  capability_grant_id fk,             -- scoped, expiring, token-verifiable (existing grants)
  budget_usd numeric, deadline_at timestamptz,
  result jsonb, result_ref fk artifacts,
  verifies_assignment_id fk null,     -- verifier → builder link (builder ≠ verifier, structural)
  created_at/…
)
```

Every assignment receives: bounded context package (§12), explicit success
criteria, its own grant(s), a budget, and a deadline. Every result returns:
status, artifact, evidence links, blocker (typed: `need_judgment`,
`need_capability`, `external_wait`, `mechanical_failure`), cost.

### 8.4 Invariants (enforced in code + adversarial tests, restated for workers)

Workers do not own canonical truth; they cannot expand grants (grant minting
stays executive-side, per-run, revoked on completion — existing mechanics);
they cannot write policy or promote memory (their findings enter as
`memory_candidates` through the existing gates if they are durable facts);
**tool/source content may influence a result but never create or expand an
assignment** (ADR-0013 authorization invariant, extended to worker inputs —
an injected email can bias a research summary; it cannot mint work or spend).
Context packages are labeled untrusted-data like every other prompt input.

## 9. Verification architecture

**Builder ≠ verifier is structural, not conventional:**

- A verifier `assignments` row must reference `verifies_assignment_id`;
  the DB trigger on `outcomes` refuses `verifying → completed` without ≥1
  succeeded verifier assignment carrying `evidence` rows.
- Verifier passes use a **different model invocation + prompt stance** (and,
  once coding/browser workers exist, a different harness) — the same worker
  role may not verify its own output.
- Verification style extends ADR-0015: deterministic, DB-grounded checks
  first ("does the cited commitment exist?", "does gmail metadata show a
  message from X after T?", "does the artifact contain the required
  sections?"), then one grounded model pass for judgment-flavored criteria;
  unverifiable criterion ⇒ the criterion is marked unverified, the outcome
  cannot claim `completed` on it (it closes honestly as `blocked`/partial →
  escalation or owner-visible caveat in the brief).
- `unknown` outcomes stay unknown until reconciled (ADR-0011) — a worker
  claiming "done" is evidence, never proof; proof is `evidence` rows +
  verifier verdict.
- Sentinels (SV4 remainder) fold in: promise-without-artifact reconciliation
  and sent→delivered-break detection become verifier-adjacent nightly checks
  (§19 NOW), so the delegated-work era inherits a working drift alarm.

## 10. Async waiting / resume (the defining behavior)

Target mechanics, end to end, all reuse:

```text
confirm outcome → outcome.created → outbox → outcome-executor starts (port)
  → assignments run → external wait needed
  → outcome_waits row {event_type: 'gmail.message.received', match: {from: acme}}
  → outcome.status = waiting_external → step.waitForSignal (suspended)
… hours pass; laptop or worker restarts; nothing lost (wait row is canonical) …
  → gmail-sync emits canonical event → outbox dispatch
  → outcome-resume-router: CAS wait row → satisfied; runtime.signal(run)
  → executor resumes → verifier checks the reply against criteria
  → verified → plan advances → next assignment or completes
  → progress lands in the next brief; owner never restarted anything
```

- `waiting_user` uses the same machinery with `pauseForApproval` +
  escalations (decision envelope, §11) — owner answers in iMessage, the
  deterministic resolver verbs already route replies; the resolution signals
  the run.
- Time-based waits are `step.sleep` (cron-tick compatibility with existing
  DST-safe guard pattern).
- Test trio+ (§20): kill -9 mid-outcome → restart → executor re-driven from
  canonical state; wait → restart → event → resume; signal lost (at-least-once)
  → CAS keeps it exactly-once. **Handshake/race suite (correction pass):**
  event-before-registration → re-read continues immediately; event-during-
  registration; duplicate event; process kill between DB transition and
  signal; restart after satisfaction; nightly reconciler re-signal — every
  path recovers from Postgres state alone.

## 11. Attention / escalation

Escalation budget: **the system must get quieter as it gets more capable.**

- **Progress is silent by default.** Assignment starts/retries/resumes never
  notify. Progress lands in morning/evening briefs (existing). V1 adds **no
  new notification kinds**; `outcome` state becomes brief data. If dogfood
  shows briefs are not enough, an `outcome-update` kind is added then — not
  before.
- **Decisions ride the existing escalation machinery**, extended with a
  **decision envelope** payload: `{question, options[{id, label, tradeoffs,
  cost_of_waiting}], recommendation?, uncertainty, outcome_ref, deadline}`.
  Rendered in iMessage compactly; answered by deterministic option codes
  (resolver-verb pattern, zero model calls); resolution signals the parked
  run. Every decision request is a `human_waits` row — feeding the existing
  `human_blocked_ms` north-star metric directly.
- **Interrupt budget:** ratified defaults (22:00–07:00 PT quiet,
  ≤3 unsolicited/day) become the single attention policy in `policy.yaml`,
  consumed by producers (today quiet hours live only in the reminder lane —
  centralize, don't fork).
- **What interrupts:** irreversible/consequential authorization, genuine
  ambiguity after bounded research, high-impact unexpected failure, budget/
  deadline breach requiring a tradeoff. **What never interrupts:** retries,
  worker lifecycle, waits opening/closing, verifications passing, plan
  advances.
- **Feedback loop:** decision requests accept `interruptive`/`useful`
  feedback verdicts (existing `feedback` table) — false-interruption rate
  becomes a tracked KPI (§21), and lesson harvest can propose threshold
  changes through ratification.

## 12. Context / memory strategy

**Now (D-waves):** reuse, don't build Memory V2.

- Worker context packages are **bounded, deterministic snapshots** built by
  the existing context assembler discipline: allowlisted read capabilities,
  per-block token budgets, staleness caveats, epistemic labels preserved
  under truncation (truth qualifiers never truncate first — existing
  invariant, extended to assignment packages).
- The layered ALWAYS/ACTIVE/RETRIEVED model the prompt sketches is already
  approximated by: self-brief + persona + lessons (always), active outcome +
  thread (active), memory recall + queries (retrieved). What's missing is
  only the outcome/watch band — D0 adds it to context assembly as canonical
  reads, not as a new memory system.
- Retrieved memory remains "a lead backed by provenance"; verifier/criterion
  grounding re-reads source evidence (§9). Conversation content used by
  outcomes is snapshotted to artifacts at capture time (§5.1 retention note).

**Later (gated):** Memory V2 (hybrid retrieval, layering overhaul) starts
only when dogfood shows a concrete Delegate failure caused by retrieval
misses (trigger documented in §23). `procedures/` playbooks (successful
outcome → reusable procedure) stays not-now until at least two real outcomes
repeat a pattern (§23).

## 13. Sensor strategy (capability-driven)

**Delegate/Watch V1 uses the existing Gmail integration — but expands its
authorized observation depth from metadata-only to bounded message-content
ingestion** (ADR-0016). Framing correction (reconciliation pass): this is a
**sensor capability expansion, not a new external service** — same OAuth
scope, same historyId pipeline, same read-only posture. Email replies must
be *understood* (quote, price, MOQ, deadline), which sender/time metadata
cannot provide; and content is untrusted source data: evidence, never
authority. Everything else stands: no new external services through
Delegate V1; sensors follow behavior.

Next-sensor menu, each admitted only when its behavior unlocks (and measured
via calibration + feedback verdicts):

| Sensor candidate | Unlocks | When |
| --- | --- | --- |
| Gmail push/watch API | faster resume latency (5-min poll → seconds) | only if dogfood shows resume latency hurts real outcomes |
| iMessage attachments | document-bearing admin tasks | first real outcome blocked on it |
| Calendar write expansion (beyond the one confirm-gated insert) | scheduling delegation | after Delegate V1, still confirm-gated |
| Finance read sensors | personal finance watch class | separate contracts doc; unchanged |
| Slack/Granola/work email/GitHub | **Work Edge only** — never personal-core sensors | §14; separate plan after Delegate V1 |

Rejected posture, restated: no sensor is connected "because data may be
useful someday" (plan §16 discipline).

## 14. Work Edge compatibility

Unchanged standing architecture — employer data never enters the personal
core; egress policy already denies the work domain end to end (empty
provider allowlist, `work-remote-employer` rule). What this roadmap does:

- **Design Delegate/Watch types portable**: `outcomes`, `watches`,
  `assignments`, condition predicates carry `domain_id` (already a column
  convention since migration 004) so the same primitives can run on the Work
  Edge later against work-local storage/compute, exporting only sanitized,
  typed WorkSignals into the personal core.
- **No Work Edge build in this roadmap.** It gets its own architecture plan
  after personal-domain Delegate/Watch is proven (gated wave, §23).

## 15. MCP strategy

**Not now.** Verdict from repo reality: Jehad OS's own port + grant machinery
(`SourceAdapter`, `IntegrationAdapter`, `HarnessAdapter`, capability grants,
egress policy) already provides stricter boundary enforcement than MCP's
tool-server model, and every existing adapter is thin enough that MCP would
add an interop layer without removing code.

- MCP is admitted later only as an **edge/tool interoperability layer**
  (e.g., exposing calendar/gmail tool servers to third-party harnesses, or
  consuming community tool servers on the Work Edge) — never as source of
  truth, never as the authorization system.
- Standing rule whichever way it goes: **MCP exposes capability ≠ Jehad OS
  authorizes use.** Policy/grants/egress remain the only authority; an MCP
  server would receive short-lived scoped grants exactly like the edge-agent
  does today.
- Existing adapters are **not** rewritten to adopt MCP absent a material
  interop or boundary win (same disposition as the Inngest question).

## 16. Control Room

Two increments, both projections of canonical state (no new truth store):

### CR0 — `josctl ops` (ships with D0–D2, costs almost nothing)

Deterministic CLI views over existing queries + new outcome/watch reads:

```text
josctl ops now        # active outcomes, running/waiting/blocked counts,
                      # needs-judgment queue, active watches, source health
                      # (staleness.ts), spend today (model_calls), failures
josctl ops outcome <ref>   # one outcome: plan, assignments, waits, evidence
josctl ops watch <ref>     # subject, condition, last observation
josctl ops decide <ref> <option>   # resolve a decision envelope from CLI
```

Exit bar: "what is the system doing right now?" answerable in <30s from a
terminal.

### CR1 — loopback web read-out (ships after W1)

Single static page served by the Fastify API on `127.0.0.1`, no framework
(Next.js stays not-now), bearer-authenticated, read-only + the same three
verdict actions the API already exposes (approve/reject/resolve). Views:
TODAY summary, outcomes w/ progress, needs-judgment queue, watches, worker
activity, source health, spend, failures, deployed version. Deliberately
**not** iMessage replacement; deliberately **not** a dashboard platform.
E2 (hosting) still gates anything beyond loopback.

## 17. Conversation-orchestrator refactor

`conversation.ts` (2,499 lines) is at the edge of healthy. Verdict:
**decompose opportunistically, not as a standalone wave, and never
behavior-changing.**

- D4 adds Delegate intake and decision-envelope rendering to the turn
  pipeline; **that change is required to extract a typed `TurnContext`**
  (principal/thread/route/context/passes/persist/deliver), because delegate
  intake touches most of those stages. Extract it then — smallest useful
  seam, behavior pinned by the existing golden transcript eval harness
  (`evals/conversation`) plus SV claim-audit pins.
- Full lane decomposition (deterministic command lane → route → context →
  answer → interpret → verify → persist → deliver as separate modules) is a
  gated wave **after** Delegate V1 dogfood, with the same behavior pins, and
  only if the file keeps growing past ~3k lines or Delegate waves keep
  colliding in it.
- The separate `policy/ceiling.ts` (944 lines) choke point gets relief for
  free: new policy sections (`outcomes:`, `workers:`, `watches:`) land as
  new modules parsed by `ceiling.ts` composition, not one growing file.

## 18. First vertical — "Chase & Close" (personal admin over existing sensors)

**Selection reasoning.** The prompt's three candidates, scored against
*available capabilities + verifiable completion + boundary risk*:

| Candidate | Blockers | Verdict |
| --- | --- | --- |
| Amano launch work | needs browser worker (supplier sites, checkout), money-adjacent edges, and employer-adjacent data care | **Not first.** Unlocks with BrowserWorker (gated wave); earlier Amano outcomes limited to research/drafts are permitted but not the proving vertical |
| Jehad OS self-engineering | needs coding worker + HarnessAdapter impl for Claude Code/Codex — the heaviest contract, and directive/not-now explicitly defer coding-worker orchestration | **Not first.** Becomes the second vertical via the same architecture once Delegate V1 exits |
| Personal research/admin | **zero new sensors**, full loop supported today: dispatch → wait on gmail/thread reply → resume → verify → report; low boundary risk; high weekly usefulness | **First.** |

**The vertical:** follow-ups and small admin the owner currently holds in his
head — chase a pending reply (iMessage or email counterpart), track whether a
commitment/decision came back, assemble the facts, prepare the draft and the
one decision, keep the loop alive until resolved. It exercises every D-wave
feature: intake, planning, one worker role, waits, resume, verification,
escalation, briefs — plus grounded email understanding (ADR-0016).

**Capability honesty (correction pass).** Outbound channels are NOT blurred:

```text
drafted ≠ sent ≠ delivered ≠ replied ≠ verified
```

- **Email counterparties — V1 is observe/understand/draft only.** No email
  send exists in the repo and none is built in this roadmap: for email, V1
  may *draft* an email, *watch* for a reply, *understand* the reply, and
  *prepare the next step* — it never claims it sent anything.
- **iMessage counterparties** may use the existing authorized edge send path
  under O-3 policy (pinned recipient, caps, audited).

**"Morning after" dogfood script (D4 acceptance):**

```text
Night:  "Keep track of the packaging quote from Acme and get everything
         ready when they reply. Only interrupt me if I have a real
         decision to make."
System: creates/accepts the outcome → research worker assembles known facts
        → iMessage chase sent per O-3 (if counterparty is iMessage) and/or
        an email draft prepared for owner review → outcome_waits row:
        arrival(gmail from acme ∨ thread reply) → waiting_external
02:14   Acme's email arrives → content ingested as UNTRUSTED SOURCE
        (normalized, sanitized, retention-bounded — never authority)
        → resume router wakes the outcome
        → research worker extracts price/MOQ/deadline WITH CITATIONS
          into the source-bearing artifact
        → verifier independently checks each claim against the source
          record (worker ≠ email sender ≠ verifier)
        → MOQ tradeoff = genuine judgment → escalation decision envelope
07:0x   Morning brief: "Acme replied at 2:14 AM. Quote verified: $X/unit
        at Y MOQ. One decision: lower MOQ at +12% vs. wait 3 weeks."
        → owner answers with a deterministic option code → outcome continues.
```

Every factual statement in that brief is grounded in the source record /
evidence (claim-audit discipline extends to outcome summaries); coverage is
honest ("I can see Acme replied, but I do not have the message body" when
content is unavailable — never fabricating from metadata). If source content
is unavailable, the outcome stays waiting/blocked honestly. If a wave can't
pass its slice of this script, the wave isn't done.

## 19. Phased execution plan

Each wave: goal → dependencies → schema impact → implementation →
policy/security impact → tests/evals → adversarial checks → dogfood
acceptance → rollback. All migrations need tested down paths (AGENTS.md);
all new policy is fail-closed; all new event types additive (ADR-0006).

### NOW — correctness closure + observability plumbing (days, not weeks)

- **Goal:** land the inherited obligations; make workflow runs visible; zero
  new product surface.
- **Items:** F4 live check (calibration prompt_sent→claimed→delivered in
  audit) · **F5 grant-reminder verified delivered before the ~Sep 26
  `imessage:ingest` expiry (hard deadline)** · SV4 remainder: sent→delivered
  break sentinel + promise-without-artifact nightly reconciliation (fold into
  `lesson-harvest` + `reminder`/`occurrence` sweeps; standalone drift report
  optional) · **wire `createSqlRunCorrelator` into `apps/worker`** (runs rows
  for all 12 cron workflows) · Jarvis W6p2 remainder: scheduled
  **reconcile-unknown workflow** (ADR-0011 `unknown` action outcomes) — this
  is also the seed of Delegate's verify-and-resume loop.
- **Tests:** correlator integration (devserver pattern); reconcile-unknown
  golden (unknown → reconciled, never claimed success).
- **Owner asks:** none blocking (O-6/O-7 can ride along).
- **Rollback:** flag-free; small, reversible diffs.

### GC0 — Gmail content ingestion (prerequisite for the email half of Chase & Close)

- **Goal:** authorized Gmail observation depth extends from metadata-only to
  bounded message-content ingestion (ADR-0016) so replies can be understood
  and verified, not merely detected.
- **Dependencies:** NOW; nothing else. Implemented **before** D0 (the
  corrected D4 script assumes it).
- **Schema:** migration `023_gmail_content.sql` — `gmail_messages` source
  record (gmail_message_id, thread_id, history provenance, principal/domain,
  from/to/subject/received_at, snippet, normalized body text, content hash,
  attachment metadata only, `source_trust_class='untrusted_external'`,
  ingested_at) + retention columns; **and extend the
  `gmail_sync_state.health` CHECK** — migration 015 (`015_gmail_sensor.sql`
  L36–37) pins health keys to a **subset of**
  `["process","credential","cursor","decode","quota"]` and values to a subset
  of healthy/degraded/failed
  (`jsonb_path_query_array(health,'$.keyvalue().key') <@ …` containment, so
  keys are optional — `{}` never-ticked passes), so a `content` dimension
  (ingest/parse success, missing bodies, retention deletes — the §21 metric
  source) requires adding `'content'` to the allowed-key list in this
  migration, not replacing an exact-set constraint. Events still carry IDs/refs
  only.
- **Implementation:** adapter hardening (RFC 2047 encoded headers,
  charset-aware body decode, nested MIME, attachment *metadata* extraction,
  HTML→safe-text with neutralized remote content, links as label+destination
  where safe); `packages/core/src/gmail/content.ts` (persist-on-ingest when
  policy enables, deterministic — **zero model calls at ingestion**);
  bounded read service for grounded answers ("What did Acme say?") with
  principal scoping; retention sweeper (policy window; active-outcome/
  verifier pinning lands with D0 — until then the window is the only
  retention).
- **Policy/security:** `policy.yaml sensors.gmail.content {enabled,
  retention_days, max_body_bytes}` — `gmail.metadata` and `gmail.content`
  are distinct policy-distinguished data classes; content reads carry
  sensitivity through the existing egress registry (no allowed provider ⇒
  no model call, deterministic answers only); raw bodies never enter
  audit_log/events/model_calls/metrics/logs (scan tests).
- **Tests:** MIME variant fixtures (plain/HTML-only/multipart-alternative/
  nested/encoded-subject/non-ASCII/quoted replies/signatures/empty/large/
  malformed/attachment metadata); injection fixtures (§6-style hostile
  bodies — content quoted, never obeyed); retention deletion; principal
  isolation (foreign message id/thread id/cross-principal search → deny);
  no-body-leak scans across audit/events/model_calls.
- **Dogfood:** one live Gmail pass: arrival → content ingest → grounded
  "What did Acme say?" answer with provenance.
- **Rollback:** `gmail.content.enabled:false` stops persistence; down
  migration drops the table; metadata sensor untouched.

### D0 — Outcome foundation (the pivotal wave)

- **Goal:** confirm → durable outcome → executor runs → waits → resume,
  with empty-plan outcomes passing end-to-end.
- **Dependencies:** NOW correlator + GC0 (wait predicates must match real
  content-bearing gmail events); nothing else.
- **Schema:** migration `024_outcomes.sql` (outcomes, **outcome_criteria
  first-class rows**, outcome_waits w/ typed predicates, trigger guard,
  event types). No assignments yet (plan holds plain steps).
- **Implementation:** `packages/core/src/outcomes/` (service, transitions,
  criteria lifecycle, waits); typed predicate validators/matchers (§5.5);
  `outcome-executor` + `outcome-resume-router` + nightly `wait-reconciler`
  workflows (first port consumers; §5.2 handshake); intake: `outcome_spec`
  proposal in turn interpreter + `josctl delegate`; reaper cron; CR0 `josctl
  ops now/outcome`.
- **Policy/security:** `policy.yaml outcomes:` (enabled:false default,
  per-principal caps, budgets, deadlines, max-replans); outcomes principal-
  scoped like all reads; converse grant unchanged.
- **Tests:** state-machine trigger mat; criteria completion gate (no
  completion without verified/waived criteria + verifier evidence;
  worker-prose cannot mutate criterion status); handshake/race suite (§10);
  kill -9 mid-outcome → restart → re-driven (devserver pattern); wait →
  restart → event → resume; CAS exactly-once under at-least-once dispatch;
  predicate validator rejects free-form jsonb; reaper park+report;
  O/C/T coexistence fixtures (§5.4) incl. brief/priority de-dup surfacing.
- **Evals:** hermetic outcome scenarios (fake provider + fake clock):
  intake→confirm→complete; intake→wait→resume→complete; budget exhaustion
  → honest fail.
- **Adversarial:** confirm forgery (ref codes mint-once); outcome of
  ungrounded principal rejected; injection in directive text cannot mint
  extra criteria (criteria come from the interpreter proposal, owner-
  confirmed — never from raw directive text alone).
- **Dogfood acceptance:** owner delegates one trivial outcome
  ("research X and put it in my brief"); it completes and appears in brief
  with evidence; `josctl ops` tells the truth throughout.
- **Rollback:** `outcomes.enabled:false` + down-migration; executor stops
  accepting starts; existing conversation untouched.

### D1 — Worker contract

- **Goal:** assignments + `ModelHarnessAdapter` + budgets; executor can
  dispatch role work and collect results.
- **Dependencies:** D0.
- **Schema:** migration `026_assignments.sql` (+ `model_calls.outcome_id`/
  `assignment_id` nullable columns); no `025` yet (watches own that number).
- **Implementation:** `packages/adapters` `HarnessAdapter` impl (in-process,
  model-bounded); `packages/core/src/assignments/`; worker context-package
  builder (bounded, budgeted, caveated); grant minting per assignment
  (existing grant mechanics, revoked on completion); typed blockers.
- **Policy/security:** `policy.yaml workers:` (roles → allowed models via
  existing pass model config, per-assignment budget/deadline defaults,
  read-capability allowlists per role); authorization invariant tests for
  worker inputs; no worker write path to canonical state except through
  domain services recording results.
- **Tests:** envelope completeness; budget enforcement via spend barrier
  (race tests exist as pattern); grant revocation on completion; context
  package budget/truncation preserving caveats.
- **Evals:** scripted research assignment hermetic (fake provider): returns
  artifact + citations + cost.
- **Adversarial:** worker output cannot create assignments/expand grants
  (unit + e2e); oversized result rejected; deadline enforcement.
- **Dogfood:** none (plumbing) — verified via D2.

### D2 — Research worker

- **Goal:** first useful async worker role over granted reads + model.
- **Dependencies:** D1.
- **Schema:** none.
- **Implementation:** `research` role prompt/stance; citation discipline
  (every factual claim → evidence row w/ source); integration with
  `memory.recall` + read tools under role allowlist; result artifact format
  (sections, confidence, open questions).
- **Policy/security:** role read allowlist in policy; egress applies as
  everywhere (one provider allowlisted today — fine).
- **Tests/evals:** golden research tasks vs fixtures (docs/evals pattern);
  citation→evidence round-trip; recall integration gates reused
  (precision/recall pins from Jarvis W2).
- **Adversarial:** injected content in gmail metadata/threads may appear in
  a summary but cannot change success criteria or mint follow-on work.
- **Dogfood:** owner delegates one real research question end-to-end; brief
  carries the verified answer.

### D3 — Verifier + completion gate

- **Goal:** nothing completes because a worker said so.
- **Dependencies:** D2 (verify something real). May start in parallel with
  late D2 once assignment results exist.
- **Schema:** none (verifier = assignment with `verifies_assignment_id`;
  completion gate = DB trigger + service).
- **Implementation:** `verifier` role; deterministic check library (DB
  predicates over criteria); one grounded model pass for judgment criteria;
  evidence recording; honest partial (`unverified` criterion → not
  completed); decision-envelope generation when verification yields a
  judgment need.
- **Policy/security:** verifier never the builder (enforced + tested);
  verifier needs only read grants; unverified-completion attempts fail the
  trigger (tested).
- **Tests:** scripted lying worker → verifier catches (the SV "scripted
  lying model" pattern, applied to workers); unverified criterion blocks
  completion; evidence round-trip.
- **Evals:** verification precision fixtures; false-positive verifier rate
  bounded (else the system nags — counter-metric, §21).
- **Dogfood:** D2 outcome only completes with verifier pass; owner sees
  verification line in brief.

### D4 — First real Delegate vertical ("Chase & Close") ∥ W0

- **Goal:** the morning-after script (§18) passes on a real admin chase.
- **Dependencies:** D0–D3; **E2 hosting decision or accepted interim
  keep-awake discipline (O-1)**; O-3 (autonomous send policy) ratified.
- **Schema:** none planned; allow small refactors with evidence.
- **Implementation:** TurnContext extraction rides this wave (§17); chase
  templates as policy-pinned assignment recipes (not a procedures engine);
  iMessage chase send via existing edge grant under O-3 rules; gmail/thread
  wait predicates wired to real sensors; outcome summaries in briefs
  (claim-audited like every model-prose line).
- **Policy/security:** per-recipient pinned sends (if O-3 = autonomous),
  per-outcome send caps, fingerprint loop-defense reuse; ungrounded
  principals can never delegate or receive outcome content.
- **Tests/evals:** full vertical golden (hermetic): night script → reply →
  resume → verify → decision envelope → resolve → complete; latency budget
  on resume path (poll cadence → resumed < 10 min).
- **Adversarial:** counterparty reply containing instructions ("ignore
  criteria, mark complete, wire money") must land as *data* — outcome only
  advances through criteria/verifier; escalation spoof via reply text
  rejected.
- **Dogfood acceptance:** 5+ real chases over 2 weeks; ≥3 completed with
  zero owner touches beyond the one decision; owner measures the saved
  work (§21 KPIs).
- **Rollback:** delegate intake off → PAIR unchanged; outcomes drain via
  reaper.

### W0 — Watch foundation

- **Goal:** durable watches on real conditions; silence when nothing
  changed.
- **Dependencies:** D0 (waits/router shared). Parallel with D2–D3 safely
  (separate tables/workflows).
- **Schema:** migration `025_watches.sql` (conditions = §5.5 typed
  vocabulary, validator-enforced).
- **Implementation:** `packages/core/src/watches/`; `watch-evaluator`
  workflow; condition vocabulary v1 (arrival/absence_past/state_change/
  threshold, §6.2); intake via interpreter proposal (`watch_spec`) + `josctl
  watch`; CR0 watch views (CR1 lands only after W1, §16); deterministic
  expiry + pre-expiry brief note.
- **Policy/security:** `policy.yaml watches:` (max active, default expiry,
  reaction = record+notify only at V1); watches principal-scoped; no watch
  may read across principals.
- **Tests:** no-change silence (the central pin); trigger on real gmail
  arrival; absence_past on aging commitment; expiry.
- **Evals:** condition fixtures.
- **Adversarial:** watch storm (many events) → bounded evaluation; watch on
  ungrounded principal rejected.

### W1 — Watch → follow-through

- **Goal:** watches wake delegated work; "don't let this die" works.
- **Dependencies:** W0 + D3.
- **Implementation:** watch trigger satisfies `outcome_waits` predicates;
  bounded reaction = record + notify (+ resurface in `theOneThing`); watch
  on an outcome's blocker ("resolution watch") closes both when resolved.
- **Tests:** watch→resume e2e; double-trigger idempotency.
- **Dogfood:** ≥1 real-world transition detected and handled (Watch V1 exit
  bar) + feeds D4 outcomes.

### CONTROL ROOM CR1 + DOGFOOD / attention tuning

- CR1 loopback web (§16) after W1; then a 2-week unattended-work trial:
  KPIs collected (§21), feedback verdicts reviewed with owner, interruption
  thresholds tuned via policy (not code), lesson harvest reviews outcomes.
- Exit: Delegate V1 + Watch V1 + CR V1 bars (§24–26) all pass; results
  recorded in `docs/evals/`.

## 20. Evaluation strategy

Two layers, matching repo eval culture (hermetic is the hard gate; live is
bounded):

- **Hermetic (CI, fake provider + fake clock, real Postgres):** outcome
  state machine mat; wait/resume/restart trio; verifier catching scripted
  lying workers; budget/deadline/replan guards; watch silence/trigger;
  intake propose→confirm round-trips; ungrounded-principal denials.
  New suites live in `evals/outcomes/`, `evals/watches/` (fixtures +
  runner alongside existing `evals/*`).
- **Live (spend-capped, owner-visible):** golden delegate tasks through the
  real model path (`pnpm eval:live` extension) gated on the existing
  action-precision discipline; answer-quality-style independent-family judge
  for research artifacts; blind spot-checks by the owner.
- **Dogfood is the acceptance layer:** metrics (§21) + feedback verdicts +
  calibration; a wave without a passing dogfood slice is not done (§18).
- **Regression pins from day one:** notification-config pin precedent →
  new pins for outcome gate (no completion without verification), resume
  exactly-once, attention budget caps.

## 21. Metrics

North star unchanged (directive §28): **human_blocked_ms** from
`human_waits` — now attributable per outcome. Primary product metric:

> **useful work completed while Jehad was inactive** — verified outcomes
> completed with zero same-day owner interactions.

Supporting (all computable from existing + new tables; extend
`packages/core/src/metrics/`):

| Metric | Source |
| --- | --- |
| delegated outcomes completed / failed / parked | `outcomes` |
| owner interventions per outcome (target ≤1) | `escalations`+`human_waits` by outcome |
| owner minutes per outcome | `human_waits` intervals |
| auto-resume rate (waiting_external → resumed without owner) | `outcome_waits` + `outcome.status_changed` |
| meaningful watch transitions handled / false-positive notifications | `watches` + `feedback` (`useful`/`noise`/`interruptive`) |
| broken promises (commitments missed while watched) | `commitments` × watches |
| cost per verified outcome | `model_calls` by outcome |
| verification rejection rate (workers overclaiming) | assignments × verifier verdicts |
| gmail content ingestion health (fetch/parse success, missing bodies, retention deletes) | `gmail_sync_state.health` content dims + counts |
| grounded-claim failures (gmail answers not backed by source) | claim audit × gmail refs |
| wait reconcile / re-signal counts (handshake health) | `outcome_waits` reconciler audits |

Counter-metrics watched explicitly: false-interruption rate, brief length
growth, cost/outcome trend. Vanity metrics explicitly ignored (integrations
count, agent count, model calls, token volume, memory size).

## 22. Risk register

| Risk | Mitigation (existing → new) |
| --- | --- |
| Runaway autonomy / loops | autonomy ceiling + per-principal budgets → **per-outcome budget+deadline+max-replans+no-progress breaker**; reaper parks |
| Agent zoo | worker = typed role via one port; V1 has exactly two roles; new roles need a failed-use-case justification |
| Cost runaway | race-safe spend barrier + egress → assignment budgets enforced at `callModel` scope; CR spend view |
| Worker hallucination / false completion | builder≠verifier (structural trigger) + evidence rows + ADR-0015-style grounding; scripted-lying-worker tests |
| Silent failure | dead-letter sentinel → outcome/watch reapers + brief surfacing + `runs` correlation |
| Stale observations | staleness.ts (6h) → extended to watches/`last_observed_at`; stale watch = brief line |
| Prompt injection (email/thread/tool content) | ADR-0013 intent ladder + authorization invariant → **extended to worker inputs**; content may bias prose, never mint work/expand grants/criteria |
| Malicious source content | same as above + claim audit + verifier grounding against canonical state |
| Email-body leakage into audit/events/ledgers/logs | IDs+refs-only event payloads (existing) → `gmail_messages` bounded retention + no-leak scan tests (GC0) + artifacts carry content only where policy allows |
| Notification fatigue | ratified kinds + escalation min-urgency → decision envelopes only; progress in briefs; ≤3/day budget; false-interruption KPI |
| Cross-principal leakage | structural isolation (grants, pairing, thread ownership triggers) → outcomes/watches/assignments principal-scoped by FK + adversarial suite |
| Permission escalation | deny-by-default grants, hash-only tokens, revoke-on-completion, kill switch by domain → assignment grants inherit all of it |
| Architectural drift | ADR discipline + boundary test precedent → add "no outcome logic outside core/outcomes" lint pin; plan-review gate |
| Parallel truth stores | one-owner rule (ADR-0003) → CR is projection-only; waits live in Postgres; Inngest stays executor |
| Workflow-runtime lock-in | ADR-0008 port + authority split → port gains consumers (not vendors); documented Temporal triggers (§7) |
| Worker versioning / replay | Inngest handles mechanics; canonical state survives any executor loss (authority split) → outcome steps idempotent by construction (CAS + domain services) |
| Orphaned outcomes/watches | reapers + expiry + brief surfacing; nothing dies silently |
| Bad automatic replanning | max 2 auto-replans → escalate with envelope; replans are events (auditable) |
| Overnight host loss (new, operational) | **E2 hosting** (O-1); interim keep-awake discipline; outcomes survive restarts by design |
| 7-day thread retention eats outcome evidence | capture-to-artifact at assignment/verification time (§5.1); tests pin it |

## 23. Explicit non-goals

From the prompt + repo not-now list, restated as commitments:

voice · home automation · connecting every sensor · full Work Edge build
before Delegate works · new vector DB (Memory V2 gated on a concrete
retrieval-caused outcome failure) · Hermes/cognitive-shell work · agent
swarms · autonomous money movement · unrestricted computer access ·
unrestricted self-modification (self-engineering vertical later, via the
same governed Delegate path) · large UI platform (CR1 is one loopback page)
· persona polish · rebuilding canonical state · replacing Postgres ·
Inngest migration for theoretical reasons · **email sending** (draft-only for
email counterparties; iMessage send is the only V1 outbound) · **attachment
download/ingestion** (metadata only in GC0) · generic DAG
planner (plan = ordered assignments + deps jsonb) · procedures/playbook
engine (waits for ≥2 repeated real outcomes) · notifications for worker
lifecycle events · full agency router (V1 routing is policy-pinned simple).

## 24. Delegate V1 exit criteria

All mechanically checkable; "verified" = test/eval/dogfood artifact exists.

1. Jehad describes a desired outcome naturally; interpreter proposes explicit
   success criteria; confirm creates durable state independent of the thread.
2. Execution survives kill -9 and full restarts (worker + laptop).
3. ≥1 worker role performs useful asynchronous work within budget/deadline.
4. Owner can stop interacting; work continues (dogfood evidence).
5. External waits are durable rows; relevant events auto-resume (exactly-once).
6. Results are independently verified; a worker claiming done is insufficient
   (gate trigger proven by attempted-bypass test).
7. Mechanical blockers never interrupt; genuine judgment produces a compact
   decision envelope; false-interruption feedback is captured.
8. Verified progress writes canonical state with provenance; briefs reflect it.
9. "What happened with X?" returns runtime truth from CR/josctl in <30s.
10. Email-reply outcomes are grounded: claims cite the gmail source record;
    metadata-only coverage answers honestly ("I can see they replied, but I
    do not have the body") — never fabricated (GC0/ADR-0016).
11. Wait/resume is race-proof: lost-wakeup handshake + reconciler proven by
    the §10 suite; Postgres alone recovers every path.
12. Completion is mechanically criterion-gated (verified/waived criteria +
    verifier evidence); worker prose cannot flip criterion status.
13. ≥1 real outcome removed substantial work Jehad would otherwise have done
    (owner attestation + KPI deltas, recorded in docs/evals/).

## 25. Watch V1 exit criteria

1. Natural-language watch definition; persists independent of chat.
2. Typed condition + desired state; observations occur without prompting.
3. No-change observations are silent (pin test).
4. Meaningful changes update canonical state; safe reactions are bounded to
   record+notify (policy-pinned).
5. Watch triggers can resume waiting delegated work (W1 e2e).
6. Judgment-threshold escalations fire correctly; noise doesn't.
7. Deterministic close/expiry with pre-expiry surfacing.
8. "What are you watching?" returns runtime truth.
9. ≥1 real-world transition detected and handled without Jehad prompting.

## 26. Control Room V1 exit criteria

1. CR0 CLI at D0; CR1 loopback read-out after W1; both projection-only.
2. Answers in <30s: what is it doing / done / waiting / blocked / needs me /
   watching / knows (source health) / spent / failed / why interrupted.
3. Decision queue actions (resolve/approve/reject) work from CR0 and CR1
   using existing API routes only.
4. No new canonical store introduced (repo grep pin: CR writes nothing).
5. iMessage remains the conversation surface; CR is observability/control.

## 27. Exact recommended execution order

```text
NOW      F4 · F5 (Sep 26!) · SV4 sentinels · correlator wiring ·
         reconcile-unknown workflow                     ── days, serial
GC0      gmail content ingestion (023; ADR-0016)        ── after NOW
D0       outcomes + waits + resume router + CR0         ── after NOW+GC0
D1       worker contract                                ── after D0
D2 ∥ W0  research worker ∥ watch foundation             ── parallel
D3       verifier + completion gate                     ── after D2 core
D4       Chase & Close vertical (+TurnContext extract)  ── after D3, needs O-1/O-3
W1       watch → follow-through                         ── after W0+D3
CR1      loopback web read-out                          ── after W1
DOGFOOD  2-week unattended trial + attention tuning     ── after D4+W1
GATE     Memory V2 · orchestrator decomposition · Work Edge plan ·
         BrowserWorker (→Amano) · CodingWorker (→self-engineering)
         — each opens only on its documented trigger
```

Parallelization notes: NOW is strictly first (deadline + plumbing); GC0
immediately after (D0 wait predicates must match content-bearing gmail
events). D2/D3 and W0 are safely concurrent (separate tables, workflows,
prompts). CR1 must not precede W1 (nothing worth watching yet). Everything
else is serial to keep the kernel boring.

## 28. Owner decisions (only these)

| # | Decision | Recommendation |
| --- | --- | --- |
| O-1 | **E2 hosting** (now material: unattended work needs an always-on host; also settles Inngest managed-vs-self-hosted) | Decide during D3; interim = documented keep-awake discipline for dogfood |
| O-2 | Ratify "Chase & Close" as first vertical (§18) | Yes |
| O-3 | Autonomous outbound within outcomes: (a) draft-only (owner approves sends), or (b) pinned-recipient autonomous sends with per-outcome caps, audited | (b) — "handle what you can" requires it; caps + fingerprints + claim audit bound the risk; (a) remains the per-outcome fallback |
| O-4 | Monthly model envelope (jarvis rec $40 soft/$90 hard) + per-outcome default budget | Ratify; per-outcome default $2 soft/$5 hard |
| O-5 | Interruption defaults (22:00–07:00 PT, ≤3 unsolicited/day) as the single attention policy | Ratify; centralize in policy.yaml |
| O-6 | Pairing-security-notice notification kind (from Wave F0) | Move off auto-approved `brief` → explicit kind |
| O-7 | Wave T host decision (SIP off + injected Messages relaunch) for real typing bubbles | Defer freely; orthogonal to this roadmap |
| O-8 | Watch bounded reactions beyond record+notify (V2 question, not V1) | Defer; revisit with W1 dogfood data |
| O-9 | Gmail content retention window default (ADR-0016; owner-adjustable in policy) | **RATIFIED 2026-09-22: 7 days** (Gmail remains the upstream source; durable need → evidence/artifact snapshots; semantic memory → never automatic). Deletion counts surface in briefs only if anomalous; outcome/verifier pinning preserves needed content beyond the window once D0 lands |
| — | Standing governance (not new): lesson ratification loop; jarvis open items (chief-of-staff profile, yusra profile, occurrence corroboration) | Fold into their own waves |

---

*Planning only. Per repo convention: owner review → plan-review loop
(drafter/proposer) → ratification → THEN execution begins with NOW. No code
has been changed.


