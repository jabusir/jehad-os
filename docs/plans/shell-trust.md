# The Shell Trust Bar — final reliability phase (R)

Owner directive 2026-09-26. One question governs: **what must be true before
iMessage can be trusted as the primary natural-language control plane and the
conversation layer stops being worked on?**

This is a bounded reliability phase, not a reset. Architecture is frozen
(§22, `docs/plans/intelligence-reset.md`): user message → one cognitive layer →
typed read/selector/operation → deterministic validation/authorization →
canonical state changes or is read → real result returns → the same cognitive
layer explains what actually happened.

**Governing invariant (formalized this phase):**

> Conversation may help determine what the user means.
> Canonical state determines what exists, what happened, what is happening,
> and what work is actually in progress.
>
> Jin may discuss ideas from conversation history.
> Jin may discuss ongoing work only from canonical work state.

The system may misunderstand, ask, or fail honestly. It may NOT fabricate
action, persistence, ongoing work, progress, deadlines, checkpoints, or
completion. A false negative is annoying; a false success destroys trust.
**The phase is not done until the owner stops checking the database.**

All claims below were verified against HEAD `ae7f29d` (grep-verified; file:line
in brackets). Owner ratified 2026-09-26 with five amendments (existence vs
substantive truth in R1; 5-char calendar-grade confirm tokens + `/new` never
kills a live approval in R2; accepted≠dispatched≠running in R2; retry
cost/ledger scoping in R3.3; 30+ turn dogfood sample and per-class holdout
bars in §8/§9) — all folded in. HEAD pushed to origin before execution so
plan, reviewer, builder, and rollback point refer to one tree.

---

## 1. Current-state diagnosis

Landed and holding (do not rebuild): single-author loop with typed envelopes
[`cognitive-turn.ts`]; selector-based mutations for commitments/occurrences/
reminders with never-guess semantics [`target-selector.ts`]; post-read mutation
window + injection boundary (ops only on round 0 pre-read; `opsExecuted`
never-reopen) [`cognitive-turn.ts:978-1021`]; truth ladder (verify → regen →
forced-final) on every reply incl. empty ledger and both degrade paths
[`cognitive-turn.ts:940-967,1061`]; policy-unavailable deny + canonical policy
loader + `policy.load_failed` audit [`repo-policy.ts`, `cognitive-turn.ts:349`];
self-brief/profile version consistency; all-envelope-rounds-on-fast-model;
RECOVERY LIMIT degrade guard (the 14:14 fiction fix) [`cognitive-turn.ts:291`];
real-model semantic suite 46 dev / 23 holdout — dev 93.5%, holdout 87.0%,
envelope validity 95.7–100%, zero unauthorized/false-ack in all runs.

Verified holes (each maps to a wave in §4):

**H1 — Durable work is invisible to cognition, and delegation cannot complete.**
(a) No read tool exposes outcomes/assignments; the self-brief carries counts
only ("progress rides the briefs") [`read-tools.ts:43-52`,
`system-self-brief.ts:214-222`]. "How's the research going?" is unanswerable
from canonical state, so history-echo is the only available behavior.
(b) `outcome_spec` parks, but the apply lane is structurally unreachable on the
single path: the confirm pre-pass is legacy-only (`routing !== "single"`)
[`conversation.ts:957`], in-envelope resolutions are consent-class-barred
[`operations.ts:967-976`], and the parked entry mints NO confirm token
[`operations.ts:1603-1615`]. §22.4 documents a system-issued token resolved by
a §22.10.3/4-class lane; that lane was never built. Even a perfect envelope at
14:14 could never have produced running work.

**H2 — The 14:14 phantom-research failure chain.** Degrade path shipped
"Confirmed: multi-week research project" with an empty ledger; the park never
happened (H1b); later turns echoed that fiction from history
["history establishes WHICH project" drifted into "history establishes THAT
the project exists"]. Prompt-level RECOVERY LIMIT covers only the degrade
path; a clean-envelope turn can still narrate fictional ongoing work, because
the verifier sees only the per-turn ledger [`truth-verifier.ts:106-125`] and
§22.9's scope note explicitly accepts zero-ledger fabrication as residual.
This phase's product bar revokes that acceptance.

**H3 — Three §22.9 fail-open holes ship possibly-false success.**
(a) `contradicted_unresolved` ships the still-lying text — and at HEAD it is
the ORIGINAL draft: the caller strips only the `regenerated:` prefix
[`cognitive-turn.ts:1053-1068`], so the forced-final attempt's text is
discarded into the audit's `verified` string
[`cognitive-turn.ts:1132-1145`]. A false success the user actually receives.
(b) BOTH verifier failure modes ship the draft: dispatch failure →
`verifier-unavailable`, and an unparseable verdict parses to `null`, which
the fail-open contract [`truth-verifier.ts:64-71`] and the ladder
[`cognitive-turn.ts:1113`] treat as `consistent` — the possibly-lying draft
ships AND audits green (poisoning the `verified` signal the R6 audit joins
on). This terminal is reachable with the primary reply intact: envelope
rounds dispatch `fast` (gpt-4.1), verification dispatches `standard`
(sonnet-4.5) — independent model legs; either can 429/5xx while the other
succeeds. (c) Production `callModel` has no provider retry:
transient 429/5xx turns into an availability notice (eval runner retries;
production doesn't) — the largest live source of degrade-class turns.

**H4 — Read/brief gaps the owner already hit.** (a) Undated open commitments
carry no age anywhere: `commitments.waiting` lists titles but no created-at
age [`read-tools.ts:533-562`], and the brief renderer never listed undated
opens (§24 F6, still open) — the "had no idea they were still open" loop.
(b) Read truncation is signaled but un-continuable (no cursor) — coverage
honesty is the answer, pagination is a non-goal. (c) Semantic suite has no
multi-turn cases at all [`semantic-corpus.ts:85-96`, single `user` field] —
delegation confirm, referent chains ("mark that one done"), /new survival,
and progress queries are untested end-to-end.

**H5 — Observability residue.** launchd stderr redirect was suspected stale
(api.log untouched since 09-23) — at build time this was DISPROVEN: the api
process holds live fds 1/2 on api.log (`lsof`); the api is quiet by nature,
and any `[repo-policy]` marker or crash trace will land there. The real gap
was "what models are actually running" having no daily trace — closed by
R3.4's `gateway.models_resolved` audit, not by plist surgery.

## 2. Root causes verified in code

1. The durable-work subsystem was built backend-first (outcomes/assignments/
   reaper/evidence are complete and DB-trigger-guarded) with the conversational
   surface never connected: one aggregate count, no read, no apply lane.
2. §22.9 scoped truth to per-turn action claims at a time when no canonical
   work view existed for a verifier to consult; work-existence claims were
   structurally unjudgeable, and both fail-open terminals predate the
   false-success=0 bar.
3. The confirm-token lane for consequential parks (§22.4 "system-issued token")
   was specified but never implemented; the legacy affirmative lane was
   correctly excluded from single routing, leaving a dead end.
4. The eval suite measures single turns; every cross-turn behavior (park→apply,
   history-echo, referents) is invisible to it — which is exactly why H1b/H2
   survived 2448 passing tests.

## 3. Final-state invariants (this phase's definition of done)

I1. Every user-visible claim of action is backed by that turn's ledger
    (shipped behavior; already held by suite — keep at zero).
I2. Every user-visible claim of ongoing work/progress/deadline/checkpoint is
    backed by canonical outcome/assignment state visible to the verifier.
    Empty canonical work + "research continues" = contradiction, on every
    path including degrade.
I3. `delegate:`-class turns end in exactly one of: canonical work created,
    canonical work parked-with-token (reply claims "staged, confirm X", never
    "underway"), or honest failure. No third outcome.
I4. No possibly-lying text ships: unresolved contradiction → deterministic
    §22.10.6 availability notice (amends §22.9's ship-flagged terminal).
I5. Reads: questions about existing personal data resolve through canonical
    reads; read content claims are eval-judged against seeded canonical state.
I6. The loop the owner asked for: undated open commitments surface by title
    and age in `commitments.waiting` and in the daily brief until closed.
I7. The wrong-model/wrong-policy class stays closed (goal-1/2 work; R3.4
    closes the wrong-pin leg) and becomes observable (`models_resolved`
    audit; stderr markers land; launchd redirect fixed).

## 4. Minimal implementation waves

Each item: problem → root cause → fix → why it generalizes → security →
tests → rollback → exit signal. Five build waves (R1–R5) + dogfood (R6).

### R1 — Work truth (closes H1a, H2 core)

1. **`work.status` read tool** [`read-tools.ts`]. Problem: no canonical work
   view. Fix: principal-scoped read returning bounded active outcomes: ref,
   title, status, deadline labeled `max lifetime (reaper bound) — not a
   promise`, criteria verified/total, latest assignment status + artifact
   title/date, `waiting_on`; plus completed-in-last-24h (ref, title, artifact
   summary). Owner amendment 1: the payload carries an explicit
   `coverage` field like every other read tool AND accepts an optional
   `ref` arg to fetch one outcome's full detail — a bounded snapshot must
   never let "not returned" become "doesn't exist". Root cause H1a.
   Generalizes: any future work type joins one projection. Security:
   read-only, policy-gated like other reads; principal-scoped by
   outcomes.principal_id. Tests: read-tool unit + integration (incl.
   coverage + ref drill-down). Rollback: remove from catalog (additive).
   Exit: corpus status_query cases pass. **No checkpoint concept is
   invented** (§6 of the directive: absent from schema; progress = status +
   criteria + artifacts — stated honestly).
2. **Verifier WORK STATE section** [`truth-verifier.ts` +
   `cognitive-turn.ts`]. Problem: existence/progress claims unjudgeable.
   Fix: the same bounded canonical work snapshot enters BOTH the
   verification prompt AND the regeneration/forced-final prompts (the regen
   prompt at HEAD carries ledger+finding only — told to "keep everything the
   ledger does not contradict", a blind regen re-narrates the fiction from
     the draft); prompt rule: work-existence/progress/deadline claims are
    judged against the snapshot — the snapshot is the ONLY sanctioned
     source: thread history, memory, external read data, and the user's own
     assertions may establish that an IDEA was discussed, never that WORK
     exists; empty snapshot + any such claim =
     contradicts; ledger `parked/queued` ≠ "underway/started". Owner
   amendment 1 (existence vs substantive truth): canonical state PROVES
   existence-class facts — an assignment is running, a worker produced an
   artifact, criterion 2 is verified. It does NOT make every sentence in a
   stored artifact true. Substantive progress claims ("we found three
   viable verticals") require verified criteria/evidence in the snapshot;
   otherwise the truthful form is "the research assignment completed and
   produced an artifact — its findings aren't verified yet", never adoption
   of the artifact's claims as fact. Generalizes: kills the whole class,
   not the 14:14 phrasing. Security: snapshot is control-plane-owned data
   (injection-safe source). Tests: scripted verifier cases (fictional
   project vs empty state; parked-claimed-underway; real outcome claimed
   correctly; artifact-exists-but-claims-unverified). Rollback: revert.
   Exit: phantom_work_holdout case green.
3. **Prompt invariant + self-brief line** [`cognitive-turn.ts:273-278`,
   `system-self-brief.ts`]. Fix: base prompt gains the §invariant two-liner
   ("ideas from history; ongoing work only from canonical work state") and
   the rule that status/progress questions generically require the
   `work.status` read rather than history; the self-brief work line lists
   bounded titles+refs and points at `work.status`. Rollback: prompt-only.

### R2 — Delegation loop closure (closes H1b; §22.4 as documented)

1. **Park mints a confirm token** [`operations.ts`, `threads.ts`]. Fix:
     outcome_spec park returns a confirm token reusing the calendar
     action's exact machinery — 5-char Crockford base32
     (`CONFIRM_TOKEN_LENGTH` [`calendar-actions.ts:390-410`], 32⁵ space) +
     `normalizeConfirmToken` glyph normalization (I/L→1, O→0, U→V); NO
     weaker 3-char variant (owner amendment 2: a 32³ space is what forced
     elaborate brute-force handling). Parked entry stores `confirmToken` +
     the existing 24h `expiresAt`; the ledger result and the model's offer
     quote it. `/new` semantics (owner amendment 2, one rule): `/new`
     clears CONVERSATIONAL context — never a live consequential approval;
     the parked offer and its token stay resolvable until 24h expiry.
     Lookup scope: the active thread, then the principal's closed threads
     within the token TTL (parks live in thread metadata, which survives
     thread closure [`threads.ts:110-114`]). Three resolution classes,
     reusing the existing review-command semantics exactly
     [`review-commands.ts:584-586,610-629,731-734`]: found-and-live →
     apply; found-but-expired → honest expired notice, NO bad-ref count (an
     orphaned token is not an attack); found-nowhere → honest
     unknown-token reply that COUNTS toward the brute lockout
     (principal-scoped rolling-1h count, policy cap, one cool-down notice +
     owner alert then silent drop — same machinery, audited under its own
     action so calendar tokens and outcome tokens are readable separately).
     One clock: the parked entry already stamps `expiresAt` at 24h
     (`PENDING_PROPOSAL_TTL_MS` [`threads.ts:466`]) — the token's lifetime
     IS that clock. Tests cover three legs: time-expiry; post-`/new`
     still-live token → resolves and applies; never-valid (bad-ref count
     advances). Security: token is authority-bearing, unpredictable,
     principal-scoped, single-use, lockout on brute (existing machinery,
     32⁵ space).
2. **Shared deterministic confirm lane** [`conversation.ts:1120` — the
    existing §22.10.4 token lane, already routing-agnostic (comment: "runs on
    BOTH routing paths"), today calendar-only]. Fix: extend it to resolve
     outcome-spec confirm tokens: `confirm|cancel <TOKEN>` (exact grammar +
     normalizeConfirmToken + lookup — active thread first, then the
     principal's closed threads within the token TTL, R2.1's three
     resolution classes; bare verb only when exactly one live consequential
    park across BOTH kinds jointly — calendar actions + outcome-spec parks
    counted together, same sole-live rule as review-commands L712-716)
    resolves via existing `applyOutcomeSpec` + `outcomeDispatcher` seam,
    replies in the authority-notice class. Owner amendment 3 (accepted ≠
    dispatched ≠ running — the drafted≠sent≠delivered lesson): the confirm
    reply narrates the OBSERVED canonical result, never an assumption —
    `applyOutcomeSpec` returns outcome state AND dispatch result; the lane's
    reply distinguishes `accepted + executor started`, `accepted but
    dispatch failed (the executor scanner retries; nothing is running yet)`,
    `waiting_user`, etc. Canonical creation alone never authorizes
    "underway". Failure tests: applyOutcomeSpec succeeds while
    `outcomeDispatcher` throws/times out → reply states
    accepted-but-dispatch-failed, outcome row exists, nothing claimed
    running. No NL interpretation: the system answers its own issued token,
    and the lane matches the authenticated inbound user text only — external
    data (gmail/calendar reads) can neither mint nor resolve a token.
    Mutation window untouched (deterministic lane, no envelope). Tests:
    scripted e2e delegate → park+token → `confirm TOKEN` → outcome accepted
    + executor observed; dispatcher-failure leg; never-valid token →
    bad-ref count advances toward lockout; expiry → honest expired notice
    with lockout count unchanged; post-/new resolution; bare-verb
    ambiguity. Rollback: lane is additive; pre-R2 parks (none live today —
    verify at build time) expire at TTL. Exit: I3 holds in corpus +
    dogfood. **`delegate:` needs no special syntax** — the op fires from
    plain language; the token is the system's own confirmation surface.

### R3 — Failure-semantics hardening (closes H3)

1. **Unresolved contradiction → notice, not the lie** [`cognitive-turn.ts`].
   Fix: ladder terminal ships `NOTICE_TURN_COMPLETION` (ledger-conditional
   §22.10.6 class) instead of the contradicting text; audit retains verdict +
   draft for ✗-harvest. Amends §22.9 terminal — justified by I4 (deterministic
   authority notice replacing a turn is the sanctioned exception class).
   Tests: scripted double-contradiction → notice + audit row. Rollback: revert.
2. **Verifier fail-closed (both fail-opens)** [`truth-verifier.ts`,
    `cognitive-turn.ts`]. Unparseable verdict or dispatch failure, after
    retries → `NOTICE_TURN_COMPLETION` (same §22.10.6 class as R3.1), never
    the unverified draft: the envelope leg (`fast`) and verifier leg
    (`standard`) fail independently (per-model 429/5xx through the same
    gateway), so this terminal is reachable exactly when an unverified,
    possibly-lying draft exists — I4 applies. Ladder: one retry on
    `standard`, one on `answer_fallback` (small plumbing: `passModelsFor`
     exposes the fallback). Audit distinguishes `verifier_unavailable` vs
     `verifier_unparseable` as audit DETAIL under `verified:
     "availability-notice"` — the two new values must NOT become `verified`
     values, or R6 F3's sanctioned set flags every verifier flake as a
     trust violation and resets the dogfood streak (kills the
     audited-green null; keeps F3's join key exact). The §22.9
    fail-open contract comments amend with the ladder terminals. Tests:
    scripted unparseable-verdict and dispatch-fail → notice + audit rows.
    Rollback: revert. Notice-frequency risk bounded by R3.3.
3. **Provider retry in `callModel`** [`model/call-model.ts`]: 2 retries on
    429/5xx with backoff, policy-flag `gateway.provider_retry`. Owner
    amendment 4 (cost/ledger semantics): this phase the flag scopes retries
    to INTERACTIVE cognition/verifier calls only (the cognitive loop's
    `dispatchModel` and verify-ladder calls pass an explicit retry opt-in)
    — worker/assignment execution stays single-shot with its own budget
    police, so retry can never silently multiply worker spend. Every
    retried attempt remains an individual `model_calls` row (per-call cost
    observability) and stays inside the unchanged per-principal
    rolling-hour/day budget ceilings — budget math is enforced per call,
    so retries can extend but never exceed a ceiling. Kills the top source
    of availability notices. Tests: unit + hermetic integration.
4. **Wrong-pin leg of I7** [`repo-policy.ts`, `cognitive-turn.ts`]. A
    policy that LOADS with absent/incomplete `gateway.passes` silently routes
    every envelope round to the principal pin (gpt-4o-mini — retired from
    answer_fast as a blind-spot class) via `passModelsFor`
    [`cognitive-turn.ts:470-476`]; the loader validates nothing about
    `passes`. Fix: `routing: single` requires a complete `passes` block —
    fail-closed like every other policy gap; first cognitive turn per
    principal-day audits `gateway.models_resolved {fast, standard}`.
    Tests: loader validation + audit row. Rollback: additive.
5. **launchd stderr fix** (ops, LaunchAgents plists): `[repo-policy]` /
    crash markers land in a live log. Rollback: plist revert.

### R4 — Stale-work visibility (closes H4a, the owner's loop)

1. `commitments.waiting` open entries carry `openDays` (deterministic age)
   [`read-tools.ts`]; brief renderer lists undated opens by title + age until
   closed (§24 F6) [`briefs/render.ts`]. Tests: read payload + brief render.
   Rollback: additive fields.
2. Teach gmail.search→gmail.read drill-down and calendar.next in the catalog
   copy (prompt-only; already in catalog shapes).

### R5 — Eval expansion to the phase bar (closes H4c; directive §7)

1. **Multi-turn corpus support** [`semantic-corpus.ts`, `semantic-live.ts`]:
    cases become turn sequences with intermediate expectations. Runner
    mechanics (without these R5.1 is unspecifiable): the per-case world
    persists across a case's turns (full reset between cases only — today
    every case resets and runs one `runCognitiveTurn`
    [`semantic-live.ts:296-341`]); `delegate_confirm` turn 2 carries the
    RUNTIME-minted token via a `{{confirm_token}}` template hook resolved from
    turn 1's parked entry; a separate static case pins the bare-verb
    sole-live confirm. New behaviors:
   `delegate_confirm` (2-turn: delegate → staged+code; confirm → outcome
   accepted), `status_query` (how's the research going — real seeded
   outcome; the case PINS `reads: [work.status]` so a reply answered from
   history fails even when coincidentally true; and the phantom variant:
   history mentions a project, canonical state
   empty, reply must not confirm it — the 14:14 regression, canonical form),
   `referent_chain` (list → "mark the second one done"), `new_thread_survival`
   (/new; canonical state intact; referents honestly degrade to
   not_found/clarify), `gmail_read_chain`, `calendar_next`.
 2. **Per-axis metrics** in the runner report, separated as the directive
    requires: envelope validity / read selection / op type / args+selector /
    missed-op / false-positive mutation / false-success / unauthorized /
    canonical effect / truthful acknowledgment / work-claim accuracy. The
    judge never fail-opens: today a null verdict passes and a judge throw
    auto-passes (`semantic-live.ts:490,495` — "same as production", which
    R3.2 ends) — a judge that can silently pass cannot certify a hard-zero
    bar. Parse failure or throw → one retry → the case is marked
    `judge_unavailable`, reported in the run header, excluded from the axis
    denominator visibly; a holdout run with any `judge_unavailable` on
    work-claim cases cannot certify the 100% axis. Judge additionally
    scores read-content claims against seeded canonical state (closes the
    "answer from memory" gap behaviorally, I5).
 3. **Holdout v2**: owner-authored phrasing (drafter may format, never
    phrase — one hand authoring dev and holdout is the overfit vector);
    refreshed only AFTER R1–R4 land (it must exercise
    `status_query`/`delegate_confirm`/phantom-work, which do not exist
    before); FROZEN before the final dev-bar run and before dogfood; any
    prompt-builder change after freeze voids the freeze (re-run + owner
    re-review). Disjoint from dev; the owner may append unseen
    phrases (overfitting guard is corpus structure + judge, never prompt
   stuffing — the prompt gains zero case-specific text; pinned by a NEW
   structure test asserting no corpus phrasing appears in any prompt
   builder).
4. **Envelope-model re-probe** (only if dev plateaus <95% after R1–R4):
   re-run the strict-JSON probe (`eval:bakeoff:probe`) across candidate
   models; a swap is a policy.yaml pin change only. No new orchestration.

### R6 — Live dogfood + exit (directive §8)

Protocol in §8 below. Daily audit report — `scripts/dogfood-audit.mts`
(repo tooling, zero model calls, deterministic joins): shipped replies ×
`cognitive.turn` audits × canonical deltas, run each dogfood morning over
the prior day. Flag classes: F1 ledger `applied/parked/queued` with no
matching canonical delta in the turn window; F2 canonical delta with no
ledger entry and no non-conversational writer provenance; F3 shipped reply
whose audit `verified` is outside the sanctioned set ({consistent,
regenerated, degraded-recovered, degraded-nonjson, availability-notice} —
post-R3.1/R3.2 anything else shipping is a bug); F4 machinery-vocabulary
regex over outbound replies (audit-side only; the deleted runtime scan
stays dead); F5 any `policy.load_failed` / `cognitive.turn_failed` /
`cognitive.degrade_nonjson` row; F6 cross-principal delta. "Trust flag"
(§8) = exactly F1–F6; zero flags required.

## 5. Files / modules touched

`read-tools.ts` (+work.status, openDays), `truth-verifier.ts` (+WORK STATE,
fail-closed contract), `cognitive-turn.ts` (prompt invariant, snapshot into
verify, notice terminals, models_resolved audit),
`queries/system-self-brief.ts`, `operations.ts` + `threads.ts` (confirmCode),
`conversation.ts` (shared confirm lane), `model/call-model.ts` (retry),
`policy/repo-policy.ts` (passes validation), `briefs/render.ts` (undated
opens), `evals/conversation/*` (corpus, contract test, runner axes),
`scripts/dogfood-audit.mts` (new, repo tooling), `policy.yaml` (retry flag;
passes requirement; any model pin), LaunchAgents
plists (stderr), this doc + `intelligence-reset.md` (§22.9/§22.10 amendments
recorded). No new packages, no new orchestration layer, no new frameworks.

## 6. Delete / change / retain

- **Change**: §22.9 ladder terminals (ship-flagged AND both verifier
  fail-opens → availability notice; the fail-open contract comments in
  `truth-verifier.ts` amend); §22.10 lane 4 generalizes (calendar CODE →
  any consequential park code); self-brief work line; confirm pre-pass
  stays legacy-only (untouched); `gateway.passes` becomes required under
  `routing: single` (fail-closed loader validation).
- **Retain**: everything the wave landed (selectors, window, verify-all,
  policy loader, RECOVERY LIMIT, fast-model envelopes); legacy lanes stay in
  tree behind `routing: legacy` as the rollback lever.
- **Delete**: nothing mid-phase. §22.11's deletion list (legacy interpret
  lanes) executes only AFTER phase exit, as the exit reward — deleting it now
  removes the rollback path while the shell is unproven.

## 7. Eval strategy

Scripted suites keep proving orchestration + invariants (they stay green
throughout). The semantic suite proves the directive's contract on real
models: real prompt, real models, unseen natural language, expected
read/op/effect/judgment; dev split for iteration, holdout for truth; splits
disjoint (structure-tested today); per-axis report (R5.2); no eval phrase
ever enters a prompt (the prompt-overfit pin is NEW in R5.3 — today's
contract tests cover split disjointness + paraphrase density only). Bars in
§9.

## 8. Live dogfood protocol (exit gate)

Three-or-more consecutive days of normal, unscripted owner use; **≥30
meaningful turns across the window** (owner amendment 5 — 15 was too small a
sample for the final go/no-go), with EVERY critical class exercised at least
twice: ordinary reads (to-dos, calendar, gmail), writes (reminder create,
task batch), completion/change (done/missed, reminder reply), delegation +
confirm, progress query, pending resolution (offer apply/decline), ordinary
chat. Each morning: run the daily audit report (R6); review every shipped
reply's claims against ledger + canonical state. Machinery vocabulary in
replies (except real confirm tokens) counts as a flag. `/new` during the
window must leave canonical state intact (parks stay resolvable per R2.1).
A day with zero trust flags (F1–F6) counts; a short day (<5 interactions or
missing a class due that day) extends the window — it neither counts nor
resets; a flagged day resets the streak to zero. Three consecutive flag-free
days at ≥30 total turns (with the §9 suite bars already met) = exit.
Notice-rate arithmetic (§9) is computed over ALL conversational turns in
the window — at the 30-turn floor the <5% bar is meaningful, not a
single-notice tripwire.

## 9. Exit criteria (exact bar)

Hard zeros, all measured over the full suite + the dogfood window: fabricated
execution (false success) · fabricated/phantom durable work · fabricated
progress · unauthorized mutation · cross-principal mutation ·
external-data-induced mutation. Semantic bars (owner amendment 5): **common
control operations — reminder creation, task/commitment transitions, reads,
delegation — ≥98% on BOTH dev and holdout splits**; overall holdout ≥95%
across all behaviors; envelope validity ≥97%; work-claim accuracy 100%
(this class admits no partial credit). Misses that end in honest
clarification or honest failure are tracked separately and never count as
trust violations — a truthful refusal beats a false success. Ops: stderr
live, zero `policy.load_failed` in the window, availability-notice rate <5%
of ALL conversational turns in the dogfood window. Exit also requires: the
owner affirms — beyond running the audit report, I opened the database zero
times and felt no need to.

## 10. Non-goals (frozen for this phase)

Watch · D4/Chase & Close · BrowserWorker · CodingWorker · Work Edge · finance
sensors · Control Room UI · Memory V2 · personas · sensor expansion ·
self-engineering · any product work. Also out: pagination/cursor infra,
inventing a checkpoint schema (§6: absent — status/criteria/artifacts suffice
for this phase), commitment principal-scoping schema change (single-world-
model residual, documented), occurrence window beyond today+tomorrow,
§22.11 mass deletion, phrase-specific deterministic handlers, accumulating
transcript examples into prompts, general-intelligence improvements.

## 11. Risks / rollback

- **98% may not be reachable on gpt-4.1 envelopes** → R5.4 re-probe; if the
  best strict-JSON model still leaves holdout <90% with zeros intact, that is
  the go/no-go decision point (not a reason to widen scope).
- **R3.1 changes §22.9 semantics** (notice replaces flagged ship): the
  authority-notice class is the sanctioned exception; revert is one commit.
  R3.2's fail-close raises notice frequency when the standard leg flakes —
  bounded by R3.3 retry + the fallback-model leg; the <5% ops bar measures
  it. If it breaches, the answer is provider work, not re-opening the
  fail-open.
- **Confirm codes add a step to delegation** (by design: money spends). If
  dogfood shows the owner reflexively trusts the park and resents the code,
  the answer is owner deliberation at exit, not silent immediate-apply.
- **Verifier scope growth** (work state) could over-flag offers/plans: pinned
  by scripted cases for the offers boundary; tune before holdout freeze.
- Rollback levers unchanged: `routing: legacy` (60s TTL), per-item reverts
  (all additive or prompt-level), retry behind a policy flag.

## 12. Go/no-go after this phase

**Go** (exit met): freeze the conversation layer; execute the §22.11 deletion
list; resume the frozen roadmap. **Conditional** (zeros hold, holdout 90–95%):
owner decides whether honest-miss rate is acceptable for a control plane or
one more bounded pass on the top miss classes is warranted. **No-go**
(any hard-zero broken after fixes, or holdout <90% after re-probe): the
custom conversational executive is not trustworthy as the primary control
plane — surface the option set (simpler interaction surface, different model
 class, or narrower automation) with the evidence.
