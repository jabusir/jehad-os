# ADR-0017 — Outcome execution semantics: first-class criteria, typed predicates, wait/resume handshake, and the Outcome/Commitment/Task contract

- **Status:** ratified by owner (2026-09-22). Accepted 2026-09-22 via reconciliation pass on
  `docs/plans/delegate-watch-roadmap.md`).
- **Complements:** ADR-0008 (WorkflowRuntime authority split), ADR-0011
  (action intent/attempt/unknown), ADR-0013 (authorization invariant),
  ADR-0015 (verification style). No prior ADR is superseded; this decides
  four correctness questions inside the (unbuilt) Outcome system before D0
  implements it.
- **Related:** roadmap §5 (outcome architecture), §6 (watch architecture),
  §10 (async waiting/resume), §24 (Delegate V1 exit bar).

## 1. Decisions

### 1.1 Success criteria are first-class rows

Outcome success criteria live in an `outcome_criteria` table (ordinal,
criterion text, typed `verification_method` spec, status, evidence ref,
verifier assignment ref, timestamps) — **not** in an opaque jsonb blob.
Rationale: verification state is lifecycle-bearing and must be mechanically
queryable and trigger-guarded.

- Criterion status vocabulary: `pending | verified | unverified | failed |
  waived_by_owner`.
- The completion gate is mechanical: an outcome cannot enter `completed`
  unless every required criterion is `verified` or `waived_by_owner` **and**
  the §9 verifier evidence exists (DB trigger, migration-002 pattern).
- Worker prose can never mutate criterion status: only a succeeded verifier
  assignment (builder ≠ verifier) or an explicit owner waiver can.

### 1.2 Wait and watch predicates are typed, versioned, validated, non-executable

`outcome_waits.predicate` and `watches.condition` validate against a small
versioned vocabulary (`ArrivalConditionV1 | AbsencePastConditionV1 |
StateChangeConditionV1 | ThresholdConditionV1` — roadmap §5.5), each with a
typed schema, validator, and matcher. Rejected: arbitrary SQL, model-supplied
JSONPath, user-defined executable expressions, eval(), rules-engine DSLs.
Models may propose conditions; code validates and canonicalizes or refuses.

### 1.3 The wait/resume lost-wakeup handshake

CAS on the canonical wait row prevents double satisfaction but cannot prove
wake delivery: the resume router may satisfy-and-signal before the executor
has registered its runtime `waitForSignal`. Structural fix (Postgres remains
authoritative; the runtime is only an executor per ADR-0008):

```text
insert canonical wait row (status=waiting)
→ executor registers runtime wait
→ executor RE-READS the canonical wait row
→ satisfied → continue immediately; else remain suspended
```

Plus a nightly `wait-reconciler`: any `satisfied` wait whose outcome is still
parked is safely re-signaled (idempotent). Required test matrix:
event-before-registration, event-during-registration, duplicate event, lost
signal, kill between DB transition and signal, restart after satisfaction —
every path must recover from Postgres state alone.

### 1.4 Outcome / Commitment / Task semantic contract

```text
TASK       — a unit of work that should be done.
COMMITMENT — an obligation/promise involving a person or entity (existing
             table; unchanged).
OUTCOME    — a desired result Jehad OS has accepted responsibility for
             advancing over time (new; owner-confirmed; durable).
```

An outcome may contain tasks (assignments) and may create or monitor
commitments; commitments and tasks may exist without an outcome; an outcome
is not automatically a commitment. The same real-world obligation must not
be duplicated across the three: priority/waiting/brief queries de-duplicate
via explicit links, with coexistence fixtures (prenup outcome + attorney
commitment + review task).

## 2. Consequences

- Positive: completion becomes mechanically checkable and adversarially
  testable; waits cannot silently lose wakeups; the three work-objects stay
  distinct without triple-surfacing; predicate surface stays closed to
  injection.
- Costs: one more table + trigger per outcome wave; validator code for the
  predicate vocabulary; the reconciler as one more cron. All land with D0
  (roadmap §19), not before.

## 3. Non-goals

No generic DAG planner; no rules engine; no auto-promotion of outcomes into
commitments; no change to ADR-0011 action semantics or ADR-0008 runtime
authority.
