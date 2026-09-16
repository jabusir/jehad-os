# Data Model — Jehad OS Kernel Schema v1

- **Status:** Phase 0 artifact, derived from the Phase 0 plan (final, revision 3)
- **Source of truth:** `docs/plans/phase0.md` §7 (schema v1, revised per review §23). This
  document derives; it does not design. Where this doc and the plan disagree, the plan
  wins — discrepancies are recorded in "Architectural concerns" below, never silently
  resolved here.
- **Citation convention** (same as the plan): bare `§N` = section N of the **directive**
  (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`); `plan §N` = the Phase 0 plan;
  `review §N` = the owner's external review (`docs/reviews/phase0-external-review.md`);
  `cleanup §N` = the owner's final-cleanup review (`docs/reviews/phase0-final-cleanup.md`).
- **Consumers:** M1 (remaining schema-v1 migrations) is built from this document. M0
  lands only the auth bootstrap (see "Migration phasing").

---

## 1. Scope

Schema v1 covers only what the first vertical slice needs — the directive warns against
building 38 entities upfront (§5, §32) — plus the minimal concepts review §23 requires
early to avoid architectural dead ends. Entities from §5 that are not listed below are
Phase 2+ (plan §7). Explicitly not in v1: Goal, Task, Question, Risk, Document,
Conversation, Account, Transaction, Holding, Liability, RecurringExpense, Metric,
Source, Policy (as a table), Verification, SyntheticPersona, Experiment, Opportunity.
No new tables beyond the plan's list exist in this document, and none are dropped.

Storage: PostgreSQL 16, canonical state, SQL migrations under source control
(plan §4.2, ADR-0001). Workflow *execution* state lives in Inngest behind the
`WorkflowRuntime` interface and is never canonical world state (plan §12) — no table
here duplicates it.

## 2. Table conventions

- Every table carries `id`, `created_at`, `updated_at` unless the row below states
  otherwise; the columns listed below are the **key columns beyond those**.
- Every table carries `domain_id` + `sensitivity` **where the directive requires
  provenance** (§5: source, confidence where relevant, sensitivity classification,
  domain, retention policy) — not blanket on every table (plan §7). Tables whose rows
  below list `domain_id`/`sensitivity` are the v1 provenance carriers.
- No generic jsonb "memory" table (§5; plan §7).
- Finance rows carry stricter sensitivity defaults and stricter egress policy
  (plan §10); enforcement lives in the data layer and policy engine, not in this
  schema's column lists.

## 3. Migration phasing (M0 vs M1)

- **M0** lands `principals` alone via the bootstrap migration
  `000_bootstrap_auth.sql` (cleanup §2). Invariant: the API must never exist
  unauthenticated merely because the full world-model schema has not yet landed
  (plan §9, plan §15 M0). The local bearer credential itself lives in macOS Keychain;
  only its hash is stored (review §4/§5).
- **M1** applies the remaining schema-v1 migrations (plan §7; plan §15 M1), plus the
  practiced backup/restore that must verify database rows **and** artifact content
  (review §11; see `artifacts` below).
- Migrations are forward-only in intent with a tested down path during development
  (AGENTS.md).

## 4. Schema v1 (plan §7, revised per review §23)

| Table | Key columns (beyond id/created_at/updated_at) |
| --- | --- |
| `principals` | type (user/harness/service/workflow), name, credential_hash (local bearer token; secret itself in Keychain — review §4/§5) — lands at M0 via the bootstrap migration `000_bootstrap_auth.sql` (cleanup §2); see §3 above |
| `domains` | key, name, sensitivity (personal/work/finance/…), retention_class, detachable bool, **storage_mode (local/remote/federated/opaque — review §3)** |
| `events` | type, source, occurred_at, recorded_at, idempotency_key (unique), domain_id, payload jsonb, sensitivity, run_id, **schema_version int (review §18)** |
| `outbox` | event_id (unique), status (pending/dispatched/failed), attempts, last_error, dispatched_at |
| `entities` | discriminator (person/org/project/account…), domain_id, name, external_refs jsonb, sensitivity |
| `commitments` | direction (owes_me/i_owe), counterparty_text, counterparty_entity_id (nullable link, link confidence), description, due_at, confidence, status (open/met/missed/renegotiated/void), source_event_id, may_follow_up bool — blocking expressed via `relationships`, not `blocked_by[]` (review §9) |
| `decisions` | domain_id, question, chosen, alternatives jsonb, reasons, revisit_conditions jsonb, decided_at, source_event_id — **no `assumptions` jsonb** (review §10; see §6.1) |
| `assumptions` | decision_id, statement, status (held/violated/unknown), last_checked_at — single source of truth for decision assumptions |
| `relationships` | domain_id, from_type, from_id, relation (blocked_by/concerns/affects/owns/supported_by/produced_by…), to_type, to_id, source_event_id, confidence, valid_from, valid_until, metadata — first-class edges in Postgres, no graph DB (review §9) |
| `evidence` | domain_id, source_type, source_ref, claim, observed_at, confidence, metadata — minimal primitive so decisions/assumptions/candidates link provenance instead of embedding it in JSON (review §20) |
| `memory_candidates` | proposed_class, gated_class, assertion_kind, payload jsonb, provenance jsonb, gate_result jsonb, status |
| `procedures` | id, name, version, body_ref (row is an index; bodies are files in `procedures/`) |
| `runs` | kind (workflow/harness), workflow_id, principal_id, status, intent, domain_id, budget, started_at, ended_at — **no `human_blocked_ms` column** (review §14; see §6.3) |
| `human_waits` | run_id, escalation_id, started_at, resolved_at, reason — raw intervals; human_blocked_ms is a projection/metric (review §14) |
| `artifacts` | run_id, kind (brief/extraction_output/eval_report…), **storage_backend (postgres default / file / object-later)**, content text (postgres) or file_path + sha256 (file backend; `data/artifacts/`, gitignored), domain_id, sensitivity, source_event_id — Phase 1 chooses Option A: small textual artifacts in Postgres so pg_backup covers them (review §11) |
| `action_intents` | run_id, grant_id, capability, resource, domain_id, payload jsonb, status (proposed/approved/prepared/cancelled) — intent-side states (cleanup §5) |
| `action_attempts` | intent_id, provider, idempotency_key, started_at, finished_at, outcome (executing/succeeded/failed/unknown/reconciled), provider_ref, error — execution-side states; one intent → many attempts (retries/reconciliation append, never overwrite an earlier ambiguous attempt — cleanup §5); `unknown` after e.g. response timeout until a reconciliation workflow resolves it (review §6) |
| `capability_grants` | principal_id, run_id, capability, resource, domain_id, expires_at, revoked_at, token_hash (opaque random capability token presented by the caller — verifiable possession, review §5) |
| `audit_log` | actor (principal/run/user/system), action, inputs_ref, outputs_ref, grant_id, action_intent_id, action_attempt_id (nullable — audit references intents/attempts; a pre-effect entry proves intent, never completion), reversible bool, occurred_at |
| `escalations` | run_id, reason (enum, §28 causes: ambiguous_requirements / approval_required / missing_credentials / architecture_decision / missing_external_information / system_failure), urgency, consequence_of_waiting, blocked_run_ids[], est_human_minutes, status (pending/batched/resolved) |
| `model_calls` | run_id, provider, model, prompt_version, in_tokens, out_tokens, cost_usd, latency_ms, result_status — each call implies the egress-policy check passed (denials raise + audit before any dispatch) |

Count: 21 tables, exactly as plan §7 / review §23 — the review's "Keep" list (14:
domains, events, outbox, entities, commitments, decisions, memory_candidates,
procedures/index, runs, artifacts, capability_grants, audit_log, escalations,
model_calls) + "Normalize" (assumptions) + "Add early" (principals — split off to M0,
relationships, human_waits, action_intents, action_attempts, evidence). No additions,
no removals.

## 5. Per-table notes (all derived from plan §7 unless cited otherwise)

### 5.1 `principals` — M0 bootstrap

Principal types: `user | harness | service | workflow` (plan §9). One local bearer
credential per principal; the row stores only `credential_hash` (review §4/§5, plan §9).
Network location is never identity — loopback binding is defense-in-depth only
(review §4). Grants are issued to a principal/run, not assumed from the caller.

### 5.2 `domains` — storage modes

`storage_mode` values and their exact semantics (review §3; cleanup §3; plan §10):

- **local** — canonical domain data may live in Jehad OS PostgreSQL. v1:
  `personal`, `finance`, `research`, `learning`, `creative`, and current-startup work
  *if authorized* (plan §10; A16 — all six v1 domains are `storage_mode=local`).
- **remote** — canonical state remains in the remote environment; Jehad OS interacts
  only through a `DomainBackend` adapter and may receive policy-allowed responses.
- **federated** — a deliberately defined, sanitized subset of metadata may cross the
  boundary while sensitive details stay remote (e.g. "2 decisions need review",
  "1 approval pending", "adapter healthy").
- **opaque** — zero domain-content export by default. Personal Jehad OS may know only
  that the domain/capability exists, plus adapter availability/health and capability
  availability *if policy permits*. It must not assume counts, titles, summaries,
  deadlines, project names, or decision metadata may cross. No semantic payload crosses
  unless the domain's policy is explicitly changed.

The work domain is `detachable=true`: exportable + deletable as a unit, excluded from
personal semantic promotion (plan §6.2 gate 2), never crossing into another domain's
context package (plan §10). Concrete remote/federated/opaque backends are Phase 2+;
Phase 1 proves the invariant with a fake adapter at M4 (plan §10, plan §15 M4, A16).

### 5.3 `events` / `outbox` — envelope and dispatch

`events` stores the event envelope verbatim; `schema_version int` carries the payload
schema version (review §18). `idempotency_key` is unique by constraint; duplicate
delivery is a 200-noop (plan §15 M2). The outbox row tracks at-least-once dispatch
(state machine pending → dispatched / failed, with attempts, last_error,
dispatched_at). Full envelope, naming, catalog, and compatibility contract:
see `docs/event-model.md` (plan §8).

### 5.4 `entities` — no auto-merge

`discriminator` selects person/org/project/account/…. `external_refs jsonb` holds
logical references to external systems (never contact-routing identifiers — PII stays
in protected runtime state and is referenced by logical ID, review §12). Commitments
keep the counterparty as text with an optional, confidence-scored entity link; entity
resolution never auto-merges (T9, plan §11).

### 5.5 `commitments` — counterparty text first, blocking via relationships

`counterparty_text` is always present; `counterparty_entity_id` is a nullable link
with link confidence (T9). `may_follow_up bool` gates automated follow-up (§7).
Blocking/dependency between items is expressed as `relationships` edges
(`blocked_by`, …), **not** as a `blocked_by[]` array on the commitment (review §9).
Status enum: open/met/missed/renegotiated/void. "Silently stalled" is derived state,
not a stored status (review §17; plan §13).

### 5.6 `decisions` + `assumptions` — one canonical representation

`decisions` has **no `assumptions` jsonb** — the `assumptions` table (decision_id,
statement, status held/violated/unknown, last_checked_at) is the single source of
truth for decision assumptions (review §10). A `decisions.assumptions` projection may
exist later as a read model, never as independently editable canonical state
(review §10). `revisit_conditions` and `alternatives` remain jsonb in v1 and
normalize (get their own tables) only when they need first-class evidence links
(review §10). Assumption monitoring (which decision depends on it, what changed,
evidence, impact) is Watch-mode behavior over these rows (§8.1).

### 5.7 `relationships` — first-class edges

Polymorphic edge table (`from_type/from_id`, `relation`, `to_type/to_id`) with
provenance (`source_event_id`), `confidence`, temporal validity (`valid_from`,
`valid_until`), and `metadata`. Relation vocabulary in v1: blocked_by, concerns,
affects, owns, supported_by, produced_by, … (extensible). No graph database — the
leverage query ("what should I decide next to unlock the most downstream work?") is
computed deterministically from these edges (review §9; plan §13; §5, §43).

### 5.8 `evidence` — minimal provenance primitive

Minimal so decisions, assumptions, and memory candidates link provenance instead of
embedding it in JSON (review §20). Intended link shapes (as relationships edges):
`decision → supported_by → evidence`, `assumption → supported_by → evidence`,
`memory_candidate → derived_from → evidence`. The first slice may barely use it; it
exists to avoid a later migration out of embedded JSON provenance (review §20).

### 5.9 `memory_candidates` — pipeline records

One row per proposed memory: classifier output (`proposed_class`), post-gate class
(`gated_class`), truth provenance (`assertion_kind`), the proposal payload, full
provenance, and the gate's decision record (`gate_result`). Semantics and gates:
`docs/memory-architecture.md` (plan §6.2).

### 5.10 `procedures` — index rows only

The row is an index entry (`name`, `version`, `body_ref`); procedure bodies are files
in top-level `procedures/` (markdown/YAML/JSON), loaded via the typed schema/loader in
`packages/core` (review §16; A17; plan §4.2). Harnesses may cache read-only copies;
Jehad OS `procedures/` in git is canonical (plan §5).

### 5.11 `runs` + `human_waits` — waits are raw intervals

`runs.kind`: workflow/harness. `budget` is enforced per `model_calls` row (T7,
plan §11). **`human_blocked_ms` is NOT a column on `runs`** (review §14): the §28
north-star metric is derived from `human_waits` raw intervals (run_id, escalation_id,
started_at, resolved_at, reason), which supports multiple waits per run, cause
analysis by escalation reason, percentile metrics, and repeated-bottleneck
identification (review §14; plan §14).

### 5.12 `artifacts` — storage_backend, Phase 1 = Option A

`storage_backend` selects: **postgres (Phase 1 default, Option A)** — small textual
artifacts stored as `content` text so pg_backup covers them; **file** —
`file_path` + `sha256` under `data/artifacts/` (gitignored), with backup/restore
including the artifact directory; **object** — later. M1's practiced restore verifies
database rows **and** artifact content (review §11; T16; plan §15 M1). Encryption at
rest for sensitive artifact files is noted for E2 (plan §15 M1).

### 5.13 `action_intents` / `action_attempts` — one canonical owner per state

Every external side effect is modeled as intent → attempts (ADR-0011; review §6;
cleanup §5). Each state has exactly one canonical owner:

- `ActionIntent.status` owns proposed → approved → prepared | cancelled.
- `ActionAttempt.outcome` owns executing → succeeded | failed | unknown → reconciled.

Combined lifecycle: intent proposed → approved → prepared → attempt executing →
attempt outcome (+ reconciled). One intent may have **many** attempts — retries and
reconciliation append; the history of an earlier ambiguous attempt is never
overwritten. Provider idempotency keys are used where available. `unknown` is the
honest state after e.g. a response timeout, until a reconciliation workflow confirms
via `provider_ref` (review §6; T13). Phase 1 exercises this with a fake provider
adapter — no real external actions until E3/E4 (plan §9, plan §15 M4).

### 5.14 `capability_grants` — token_hash, not trust

Deny by default; a run acts only through grants issued at dispatch (plan §9).
Possession is proven by an opaque random capability token (claims: principal, run_id,
capability, resource, domain, expires_at, nonce) presented by the caller — the
canonical row stores only `token_hash`. Tokens are short-lived, scope-limited,
revocable, auditable, non-escalatable, unusable outside the granted resource/domain.
Exact signing/rotation machinery is Phase 2+; the token primitive ships in Phase 1 so
grants are never "just database metadata" trusted from a caller-supplied id
(review §5; ADR-0007 extended). Grants are revoked on run end (plan §9).

### 5.15 `audit_log` — references intents/attempts, never fakes completion

`actor` is a principal/run/user/system. Audit references `action_intent_id` and
(nullable) `action_attempt_id`; a pre-effect entry proves intent, never completion
(review §6; cleanup §5). After a lost response the honest state is `unknown` on the
attempt until reconciliation — the audit log must never claim success it cannot prove
(review §25 test; T13). `reversible bool` supports "can it be undone?" (plan §14).

### 5.16 `escalations` — six-reason enum

`reason` enum matches the §28 human-blocked-time causes exactly:
ambiguous_requirements / approval_required / missing_credentials /
architecture_decision / missing_external_information / system_failure. Status
pending/batched/resolved; batching is the default — attention is the scarce resource
(§10; plan §3).

### 5.17 `model_calls` — implies egress check passed

Cost/latency ledger per run (provider, model, prompt_version, in_tokens, out_tokens,
cost_usd, latency_ms, result_status). A row existing implies the model-egress policy
check passed for that call — denials raise and audit **before** any dispatch, so a
denied call never produces a `model_calls` row (plan §9; ADR-0012; T12). Budget caps
(A13) are enforced against these rows.

## 6. Explicitly removed / forbidden columns

1. `decisions.assumptions` jsonb — REMOVED; canonical home is the `assumptions`
   table (review §10; plan §21 record).
2. `blocked_by[]` on commitments — REMOVED; blocking is a `relationships` edge
   (review §9; plan §21 record).
3. `runs.human_blocked_ms` — REMOVED as a column; derived from `human_waits`
   (review §14; plan §21 record).
4. No generic jsonb "memory" table, ever (§5; plan §7).

## 7. Temporal-validity policy (review §19)

`valid_from` / `valid_until` / `observed_at` are added per-entity **only where
temporal validity actually matters** — employment, recurring expenses, holdings,
ownership, policies, relationship state. In v1, `relationships` (valid_from,
valid_until) and `evidence` (observed_at) carry them; no blanket column spraying.
A fact can be learned today, effective since last week, and superseded tomorrow —
the event envelope already separates `occurred_at`/`recorded_at` (review §19), and
semantic tables adopt effective-time columns only when their entity demands it.

## 8. ADR references

- ADR-0005 (schema v1 scope, revised) — this document.
- ADR-0009 (authentication, principals) — §5.1.
- ADR-0007 extended (capability tokens) — §5.14.
- ADR-0011 (action intent/attempt/outcome) — §5.13.
- ADR-0010 (DomainBackend storage modes) — §5.2.
- ADR-0012 (model-egress policy) — §5.17.

## 9. Architectural concerns (flagged, not resolved)

1. **`escalations.blocked_run_ids[]` vs review §9's no-arrays rule.** Review §9
   removed `blocked_by[]` from commitments in favor of `relationships` edges, but
   plan §7 retains a `blocked_run_ids[]` array on `escalations`. The plan is canonical
   here (reproduced verbatim), but M1 should confirm whether escalation→blocked-run
   links should also be `relationships` edges for graph queries (the leverage query
   walks edges, not this array). No change made.
2. **`memory_candidates` lacks an explicit `domain_id` column** in plan §7, yet
   promotion gate 2 performs a domain check (plan §6.2). Presumably domain context
   lives in `payload`/`provenance` jsonb, but the M1 implementer must decide where
   the gate reads it from. Reproduced as-is; flagged for M1.
3. **Column types are only partially specified.** Plan §7 gives types for some
   columns (`schema_version int`, `payload jsonb`, `detachable bool`,
   `may_follow_up bool`, `reversible bool`, `blocked_run_ids[]`, enums where listed)
   and bare names for the rest. M1 migrations must choose boring, explicit Postgres
   types for the untyped names (e.g. timestamptz for *_at, text for names, numeric
   for cost_usd) without semantic drift from this table.
4. **camelCase envelope vs snake_case columns.** The event envelope (plan §8) uses
   camelCase (`schemaVersion`, `occurredAt`); `events` columns are snake_case
   (`schema_version`, `occurred_at`). The envelope is stored verbatim in `events`
   while the columns are the relational projection — M1/M2 must define the mapping
   once, in one place. Noted, not designed here.
