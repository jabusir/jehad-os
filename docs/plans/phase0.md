# Jehad OS — Phase 0 Plan: Architecture & Kernel Definition

- **Status:** final (revision 3) — revision 2 integrated the project owner's
  external review (`.review/phase0/external-review.md`, disposition: approve
  with revisions; all REQUIRED §2–§15 and RECOMMENDED §16–§20 items
  incorporated — integration record plan §21); revision 3 (2026-09-16)
  integrates the owner's final-cleanup review
  (`~/Downloads/PHASE0_REV2_FINAL_CLEANUP 2.md`, disposition: architecture
  approved; 4 REQUIRED consistency fixes + 2 recommended clarifications +
  2 roadmap notes — record in plan §21). E1–E5 answered (plan §19). Plan
  re-review re-closed 2026-09-16 — exit criterion 1 satisfied.
- **Date:** 2026-09-16 (revision 3 — final-cleanup integration)
- **Driver:** `~/Downloads/JEHAD_OS_BUILD_DIRECTIVE(1).md` (the north star). Citation
  convention: bare `§N` = section N of the **directive**; `plan §N` = this plan's
  own sections; `review §N` = the external review
  (`.review/phase0/external-review.md`); `cleanup §N` = the owner's
  final-cleanup review (`docs/reviews/phase0-final-cleanup.md`, archived from
  `~/Downloads/PHASE0_REV2_FINAL_CLEANUP 2.md`). PII-scrub-verified copies of
  both reviews are archived under `docs/reviews/` when this revision syncs
  to canonical — `.review/` is never committed (AGENTS.md), so the in-repo
  copies are what make the `review §N` / `cleanup §N` citations resolvable.
- **Related:** `/Users/Shared/tito` (household edge node: OpenClaw + Home Assistant,
  plan `~/Downloads/home-ai-agent.md`)
- **Repo:** `~/Projects/jehad-os` (this repo)

Phase 0's deliverable is not code — it is a set of architecture decisions specific
enough that Phase 1 (kernel) can be built without further design guessing, plus the
smallest credible implementation sequence. This document is the master plan; the
`docs/` artifacts required by §41 are produced from it as the first implementation
step (see plan §15). Per review §27: build the smallest kernel that preserves the
correct long-term boundaries; preserve interface + invariant now, defer concrete
implementation where Phase-1 complexity would be high.

---

## 1. Objective and Phase 0 exit criteria

Phase 0 is done when all of the following are true:

1. This plan is reviewed and finalized. *(reopened 2026-09-16 for
   external-review integration; re-closed on plan re-review 2026-09-16)*
2. The §41 artifact set exists in `docs/` (vision, architecture, domain-boundaries,
   threat-model, data-model, event-model, policy-model, memory-architecture,
   harness-architecture, workflow-runtime, evals, roadmap) — each derived from the
   corresponding section of this plan (as revised), each reviewed against the
   directive and the external review.
3. ADRs exist for every decision marked **[ADR]** in this document
   (ADR-0001..0012; ADR-0008 rewritten per review §2).
4. Toolchain bootstrap (M0) is done: Node 22, pnpm, PostgreSQL 16 running locally,
   **plus the local authentication primitive (review §4)**.
5. Kernel schema v1 (M1, revised per plan §7 / review §23) is migrated into a live
   local database, with a practiced backup/restore that covers artifacts
   (review §11).
6. The escalation list (plan §19) has Jehad's answers or is explicitly deferred
   with a safe default. *(closed 2026-09-16: E1–E5 answered by the owner's
   external review §21 — dispositions recorded in plan §19)*

Non-goals for Phase 0: no autonomous actions, no external integrations, no UI,
no cloud deployment.

---

## 2. Current-state assessment (facts, verified 2026-09-16; re-checked during
plan review — plan §2.1 machine facts confirmed live, one correction: Homebrew absent)

### 2.1 Machine and runtime (this Mac; not the Mac Mini)

- macOS 26.6.2. **No Node, npm, pnpm, bun, Docker, or PostgreSQL installed.**
  Python 3.9.6 (system only). **Homebrew absent** (re-verified 2026-09-16 during
  plan review: not on PATH; no `/opt/homebrew/bin/brew` or `/usr/local/bin/brew` —
  corrects this section's earlier "Homebrew present" claim). Installing Homebrew
  is M0 step 0. → Greenfield toolchain; M0 exists for this reason.
- **OpenClaw 2026.9.4 installed and live** under this user: gateway LaunchAgent on
  port 18789, one agent (`main`), default model `anthropic/claude-opus-5` (key not
  yet switched; tito plan intends OpenRouter). `~/.openclaw/` has credentials,
  service env, exec-approvals, mac-control token.
- **No Hermes anywhere on this machine.** The directive's cognitive-shell candidate
  is absent — see assumption A7 and disagreement D2.

### 2.2 Existing repo: `/Users/Shared/tito` (the future edge node)

- Phase 0 scaffold of the household agent plan (`home-ai-agent.md`): OpenClaw
  workspace (SOUL.md, skills, memory, events), Home Assistant container config,
  build log with claims C1–C11 / open questions Q1–Q13.
- Real progress, honest ledger: C2 PASS (daemon install), C1/C3/C4 PARTIAL,
  C5–C11 UNVERIFIED. Currently blocked on FileVault-off for the dedicated `tito`
  macOS user migration.
- Owners recorded: Jehad (primary user) and Yusra (household member — a person
  record, not a system user). iMessage channel planned on a dedicated Apple ID;
  Google Calendar is the household calendar (Q5); Brave Search + OpenRouter with
  $20/$50 caps (Q7). *(PII removed from this doc per review §12: contact-routing
  identifiers (phone, addresses, account IDs) live in protected runtime state
  (Keychain / OpenClaw config) and are referenced by logical ID — never in
  design documentation.)*
- **Relevance to Jehad OS:** tito is exactly the directive's §11.7 edge/integration
  harness (channels, devices, local actions). Its facts (owners, calendar provider,
  search budget) carry over as world-model seed data. Its plan does **not** cover
  the control plane — no event canonicalization, no policy engine, no memory
  promotion, no workflow runtime. Those live here.

### 2.3 Gaps the kernel must fill (nothing exists yet)

Event log with idempotency; canonical world model; capability/permission system;
audit trail; memory-promotion pipeline; durable workflows with human-approval
waits; model-provider abstraction; review/attention queue; human-blocked-time
metric. All are Phase 1 scope (plan §15).

---

## 3. Product guardrails (from §2, §42 — binding constraints on this plan)

Not a chatbot, dashboard, agent zoo, or wrapper around any harness. No model or
harness owns state. No duplicated ownership of memory, scheduling, policy,
approvals, or workflow state. Employer data stays in a detachable work domain —
and, per review §3, must be capable of **never entering personal storage at all**
(remote/opaque domain modes). No dangerous permissions to make demos work. Boring,
durable, reversible infrastructure. Attention is the scarce resource — batch
escalations.

---

## 4. Proposed architecture

### 4.1 Shape

A single TypeScript monorepo holding the control plane. One deployable API service,
one worker process, one PostgreSQL. No microservices, no k8s, no queue broker
beyond Postgres (workflow execution state excepted — that lives in Inngest,
behind the `WorkflowRuntime` interface, per revised ADR-0008). Verticals arrive
as modules inside the same kernel, not as separate services.

```text
   Surfaces (Phase 1: CLI; Phase 2: chat via OpenClaw channel; web later)
        │  authenticated principal (local bearer credential, M0)
        ▼
   Jehad OS API  (Fastify: events in, state queries out, approvals)
        │
┌────────────────────────────────────────────────────────────┐
│ Jehad OS core (this repo)                                  │
│                                                            │
│  world model (pg)   event log + outbox   memory promotion  │
│  policy/capability  audit + actions      review queue      │
│  + model-egress     principal/auth                          │
│  workflow semantics behind WorkflowRuntime                 │
│    (execution: Inngest, packages/workflow/inngest)         │
│                                                            │
│  adapter ports: SourceAdapter · IntegrationAdapter ·       │
│   HarnessAdapter · ModelProvider (egress-gated) ·          │
│   WorkflowRuntime · DomainBackend · Principal/auth         │
└────────────┬───────────────────────────────┬───────────────┘
             │ grants (scoped, expiring,     │ remote/opaque domains:
             │ token-verifiable)             │ EmployerDomainAdapter →
       OpenClaw edge (tito repo)             │ employer-approved infra
       channels, HA, local actions           │ (content stays there)
```

### 4.2 Monorepo layout

```text
apps/
  api/            Fastify service (HTTP + auth + CLI host)
  worker/         registers/serves workflow functions + runtime integration
                  required by the selected Inngest deployment model — NOT a
                  baked-in always-on queue-daemon assumption; the M3 spike
                  determines the concrete dev/runtime shape (cleanup §6)
packages/
  core/           domain model, policy, memory, events — pure TS, no SDK imports
  adapters/       port interfaces + implementations (model providers first)
  workflow/       inngest implementation of WorkflowRuntime (the port
                  interface lives in packages/adapters with the other ports,
                  per the AGENTS.md rule that domain code imports interfaces
                  only from packages/adapters)
  db/             migrations, query helpers, provenance mixins
procedures/       procedural memory as data (markdown/YAML/JSON) — typed
                  loader + schema live in packages/core (review §16)
docs/
  plans/ adr/     (this doc + ADR-0001..0012)
infra/
  dev/            local postgres setup scripts (brew; no Docker required)
data/             gitignored; artifact files only if storage_backend=file
                  (Phase 1 default is postgres — plan §7)
```

**[ADR-0001]** Monorepo, single service, Postgres-only persistence (Inngest owns
workflow-execution state only, not world state — plan §12).
**[ADR-0002]** TypeScript strict; no harness/vendor SDK imports in `packages/core`.

---

## 5. Responsibility boundaries (who owns what)

| Concern | Canonical owner | Explicitly NOT owner |
| --- | --- | --- |
| Structured truth (semantic memory) | Jehad OS + PostgreSQL | any harness, any model |
| Episodic history (events, artifacts) | Jehad OS event log + artifact store | harness chat logs |
| Working memory (session state) | active cognitive harness | Jehad OS (does not persist sessions) |
| Procedural memory (playbooks/skills) | `procedures/` (versioned content in git; typed loader/schema in `packages/core`); harnesses may cache read-only copies | harness-private skill stores |
| Policy / approvals / capability grants | Jehad OS policy engine | OpenClaw, coding harnesses |
| Identity / authentication | Jehad OS principals (local bearer credential; one credential per principal) | network location ("same machine" ≠ identity — review §4) |
| Audit trail | Jehad OS | everywhere else |
| Durable global workflows (semantics) | Jehad OS behind `WorkflowRuntime` | OpenClaw automations (local-only) |
| Workflow execution/checkpoint state | Inngest (executor only; replaceable behind the interface) | Inngest is NOT a source of truth for world state |
| Business-domain schedules | Jehad OS scheduler | cron on any harness |
| Local edge schedules (true local) | OpenClaw (tito) | Jehad OS |
| Channel ingress/egress, devices | OpenClaw edge node under Jehad OS grants | Jehad OS (no direct iMessage/HA coupling) |
| Coding/review execution | Claude Code / Codex via HarnessAdapter (Phase 3+) | Jehad OS (dispatches only) |
| Model calls | ModelProvider port behind model-egress policy; vendors swappable per workflow | domain code |
| Employer-domain storage/compute | employer infrastructure via DomainBackend (remote/opaque modes) | personal Postgres, personal model providers |
| High-risk execution (money, contracts) | human approval gate + (later) hardened path | any autonomous agent |

Rule enforced in code review: if two components can both do a thing, one is
authoritative and the other calls it through a port. **[ADR-0003]**

---

## 6. Memory architecture

### 6.1 Four classes (per §3.5)

| Class | Lives in | Lifetime | Examples |
| --- | --- | --- | --- |
| Working | harness session / workflow step state | task-scoped | current hypothesis, scratchpad |
| Episodic | `events` + `artifacts` (append-only, provenance) | years | conversations, runs, incidents |
| Semantic | world-model tables (commitments, decisions, people…) | until superseded | "Jehad owes X a migration plan by Fri" |
| Procedural | `procedures/` in git (markdown/YAML/JSON; loader in core) | versioned | "how we triage a failed workflow" |

### 6.2 Promotion pipeline (nothing auto-canonical; truth semantics per review §8)

```text
harness/model proposes MemoryCandidate
  → classifier assigns: discard | working | episodic | semantic | preference
    commitment | decision | assumption | procedural | policy
    + assertion_kind: observed | user_declared | externally_sourced |
                      model_inferred | computed
  → gate applies, in order:
      1. provenance attached (source event/run, model, prompt version)
      2. domain check (work-domain content blocked from personal semantic store;
         abstract method-level learning allowed, employer specifics are not;
         federated domains may contribute policy-sanitized metadata only —
         counts like "2 work decisions need review", never content — while
         opaque domains contribute no semantic payload at all by default —
         cleanup §3)
      3. sensitivity/retention classification + model-egress check (plan §9):
         the data's domain/sensitivity must permit the provider being asked
      4. confidence + conflict check (existing contradicting fact → both kept,
         conflict recorded, review queue if material)
      5. write to the matching store — semantic writes are proposals that land
         in review queue unless (a) assertion_kind=user_declared AND the class
         is something a person can canonically establish by stating it —
         preference, intent, commitment, personal decision, self-declared plan,
         or (b) class is episodic. A user-declared claim about the external
         world ("Company X has 3M customers") is stored as a user-supplied
         claim (evidence-linkable), NEVER auto-promoted to verified semantic
         fact — "Jehad said X" is not "X is true" until independently
         supported (evidence primitive, plan §7)
```

Promotion rules are data (config), not model judgment. First correction-scope
taxonomy (§29) ships as an enum on the candidate. **[ADR-0004]** (extended:
assertion-kind/truth semantics).

---

## 7. World model / database proposal (schema v1, revised per review §23)

Schema v1 covers only what the first slice needs (directive warning: don't build
38 entities upfront), plus the minimal concepts review §23 requires early to
avoid architectural dead ends. Entities from §5 not listed here are Phase 2+.

| Table | Key columns (beyond id/created_at/updated_at) |
| --- | --- |
| `principals` | type (user/harness/service/workflow), name, credential_hash (local bearer token; secret itself in Keychain — review §4/§5) — *lands at M0 via the bootstrap migration `000_bootstrap_auth.sql` (cleanup §2): the API must never exist unauthenticated merely because the full world-model schema has not yet landed; M1 applies the remaining schema-v1 migrations* |
| `domains` | key, name, sensitivity (personal/work/finance/…), retention_class, detachable bool, **storage_mode (local/remote/federated/opaque — review §3)** |
| `events` | type, source, occurred_at, recorded_at, idempotency_key (unique), domain_id, payload jsonb, sensitivity, run_id, **schema_version int (review §18)** |
| `outbox` | event_id (unique), status (pending/dispatched/failed), attempts, last_error, dispatched_at |
| `entities` | discriminator (person/org/project/account…), domain_id, name, external_refs jsonb, sensitivity |
| `commitments` | direction (owes_me/i_owe), counterparty_text, counterparty_entity_id (nullable link, link confidence), description, due_at, confidence, status (open/met/missed/renegotiated/void), source_event_id, may_follow_up bool — *blocking expressed via `relationships`, not `blocked_by[]` (review §9)* |
| `decisions` | domain_id, question, chosen, alternatives jsonb, reasons, revisit_conditions jsonb *(assumptions jsonb REMOVED — canonical home is the `assumptions` table; revisit_conditions/alternatives normalize when they need first-class evidence — review §10)* , decided_at, source_event_id |
| `assumptions` | decision_id, statement, status (held/violated/unknown), last_checked_at — *single source of truth for decision assumptions* |
| `relationships` | domain_id, from_type, from_id, relation (blocked_by/concerns/affects/owns/supported_by/produced_by…), to_type, to_id, source_event_id, confidence, valid_from, valid_until, metadata — *first-class edges in Postgres, no graph DB (review §9)* |
| `evidence` | domain_id, source_type, source_ref, claim, observed_at, confidence, metadata — *minimal primitive so decisions/assumptions/candidates can link provenance instead of embedding it in JSON (review §20)* |
| `memory_candidates` | proposed_class, gated_class, assertion_kind, payload jsonb, provenance jsonb, gate_result jsonb, status |
| `procedures` | id, name, version, body_ref (row is an index; bodies are files in `procedures/`) |
| `runs` | kind (workflow/harness), workflow_id, principal_id, status, intent, domain_id, budget, started_at, ended_at — *(human_blocked_ms REMOVED as a column: derived from `human_waits`, review §14)* |
| `human_waits` | run_id, escalation_id, started_at, resolved_at, reason — *raw intervals; human_blocked_ms is a projection/metric (review §14)* |
| `artifacts` | run_id, kind (brief/extraction_output/eval_report…), **storage_backend (postgres default / file / object-later), content text (postgres) or file_path + sha256 (file backend; `data/artifacts/`, gitignored)**, domain_id, sensitivity, source_event_id — *Phase 1 chooses Option A: small textual artifacts in Postgres so pg_backup covers them (review §11)* |
| `action_intents` | run_id, grant_id, capability, resource, domain_id, payload jsonb, status (proposed/approved/prepared/**cancelled**) — *what we intend to do; owns the intent-side states (cleanup §5)* |
| `action_attempts` | intent_id, provider, idempotency_key, started_at, finished_at, outcome (**executing**/succeeded/failed/**unknown**/reconciled), provider_ref, error — *owns the execution-side states; one intent → many attempts (retries/reconciliation append, never overwrite an earlier ambiguous attempt — cleanup §5); `unknown` after e.g. response timeout until a reconciliation workflow resolves it (review §6)* |
| `capability_grants` | principal_id, run_id, capability, resource, domain_id, expires_at, revoked_at, token_hash (opaque random capability token presented by the caller — verifiable possession, review §5) |
| `audit_log` | actor (principal/run/user/system), action, inputs_ref, outputs_ref, grant_id, action_intent_id, action_attempt_id (nullable — audit references intents/attempts; a pre-effect entry proves intent, never completion), reversible bool, occurred_at |
| `escalations` | run_id, reason (enum, §28 causes: ambiguous_requirements / approval_required / missing_credentials / architecture_decision / missing_external_information / system_failure), urgency, consequence_of_waiting, blocked_run_ids[], est_human_minutes, status (pending/batched/resolved) |
| `model_calls` | run_id, provider, model, prompt_version, in_tokens, out_tokens, cost_usd, latency_ms, result_status — *each call implies the egress-policy check passed (denials raise + audit before any dispatch)* |

Every table: `domain_id` + `sensitivity` where the directive requires provenance
(§5). No generic jsonb "memory" table. Temporal-validity policy (review §19):
`valid_from`/`valid_until`/`observed_at` are added per-entity only where
temporal validity actually matters (employment, recurring expenses, holdings,
ownership, policies, relationship state) — `relationships` and `evidence` carry
them in v1; no blanket column spraying. **[ADR-0005: schema v1 scope, revised]**

---

## 8. Event model

Envelope (stored verbatim in `events`, plus outbox for dispatch):

```json
{
  "id": "uuid-v7",
  "type": "commitment.detected",
  "schemaVersion": 1,
  "source": "cli.capture | openclaw.channel | adapter:<id> | internal",
  "occurredAt": "…", "recordedAt": "…",
  "domainId": "personal",
  "idempotencyKey": "sha256(source + external id)",
  "sensitivity": "normal",
  "payload": { },
  "runId": null
}
```

Naming: `<noun>.<verb_past>` (directive uses subject.verb; we invert to noun-first
for grouping — see D4, blessed by review §21). Catalog v1: `capture.recorded`,
`commitment.detected`, `commitment.due`, `commitment.overdue`,
`decision.recorded`, `assumption.changed`, `memory.proposed`,
`memory.promoted`, `run.started`, `run.completed`, `run.failed`,
`verification.failed`, `escalation.raised`, `escalation.resolved`,
`grant.issued`, `grant.revoked`, `brief.generated`.

Rules: immutable once accepted; unique `idempotency_key` enforced by constraint;
every source defines its external id — adapter retries reuse it, distinct
real-world occurrences get a new one (CLI mints a fresh uuid per
`capture`/`decide` invocation, so identical words captured twice are two
events, never a dedupe); handlers idempotent (safe to replay); outbox dispatch
is at-least-once. **Compatibility contract (review §18):** event names are
immutable once released; every payload declares `schemaVersion`; consumers
tolerate additive fields; breaking payload changes require a new schema version
(or new event type) — enforced from the first event, before OpenClaw / remote
work domains / multiple workers consume the stream. **[ADR-0006]**

**Future observation layer (design note — architecture now, wiring later;
cleanup §8).** No real sources are wired in Phase 1, but the SourceAdapter /
event design must stay sufficient for the eventual source universe: Calendar,
Email, Slack, Granola/meeting notes, iMessage/messaging, GitHub, Linear,
financial accounts, voice/manual capture, public web/research, home/device
events. Product model: `authorized source → SourceAdapter → normalized
observation/event → extraction/policy → world-model update → watcher/workflow
→ action or attention item`. Observation mechanisms: push/webhook, poll/cursor,
explicit user capture, derived state change. Rule: a connector is built only
when the system knows what useful state it intends to derive from it — never
ingest merely because a connector exists.

---

## 9. Capability & permission model (revised per review §4–§7)

**Authentication (ADR-0009).** The API requires an authenticated principal on
every call from day one (M0). Chosen mechanism: a random local **bearer
credential stored in macOS Keychain** (`josctl` and future harnesses each get
their own credential; separate credentials per principal — review §4). M0
ships a minimal bootstrap migration (`000_bootstrap_auth.sql` — principals
only) so auth never waits on the full M1 schema (cleanup §2). Unix-domain
socket + filesystem perms was the alternative; bearer wins for the later OpenClaw
path. Loopback binding (127.0.0.1) is retained as defense-in-depth but is a
network boundary, **not** an identity boundary — a compromised browser, local
process, agent, or package on this Mac gets nothing by default. Principal types:
`user | harness | service | workflow`.

**Grants with verifiable possession (ADR-0007 extended; review §5).** Deny by
default. A run acts only through `capability_grants` issued at dispatch to a
principal/run: `{capability: "read_events" | "write_entity:<type>" |
"call_model:<provider>" | "send_channel:<id>" | "spend_budget:<usd>" | "act:<provider>"`,
resource, domainId, expiresAt}. Possession is proven by an **opaque random
capability token** (claims: principal, run_id, capability, resource, domain,
expires_at, nonce) — short-lived, scope-limited, revocable, auditable,
non-escalatable, unusable outside the granted resource/domain; the canonical
grant row stores only a token hash. Exact signing/rotation machinery is Phase 2+;
the token primitive itself ships in Phase 1 so grants are never "just database
metadata" trusted from a caller-supplied id.

**Autonomy ceiling.** Per action type, from versioned `policy.yaml` (§35
pattern): v1 ships `read: autonomous · propose: autonomous · write_canonical:
gated · external_side_effect: approval_required · money_and_contracts:
prohibited`.

**External actions: intent / attempt / outcome (ADR-0011; review §6, cleanup
§5).** Every external side effect is modeled as `action_intents` →
`action_attempts`. Each state has exactly one canonical owner:
`ActionIntent.status` owns proposed → approved → prepared | cancelled;
`ActionAttempt.outcome` owns executing → succeeded | failed | **unknown** →
reconciled. Combined lifecycle: intent proposed → approved → prepared →
attempt executing → attempt outcome (+ reconciled). One intent may have many
attempts (retries/reconciliation append — an earlier ambiguous attempt's
history is never overwritten). Provider idempotency keys are used where
available. Audit references these records; a pre-effect audit entry records
intent, never completion — after a lost response the honest state is `unknown`
until a reconciliation workflow confirms via provider refs. Designed now
because Finance eventually enters this control plane. Phase 1 exercises this
with a fake provider adapter (no real external actions until E3/E4).

**Model/data egress policy (ADR-0012; review §7).** `call_model` alone is too
coarse. The question is: may *this data* (domain × sensitivity) leave for *this
provider/model*? `ModelEgressPolicy {domainId, sensitivity, allowedProviders,
allowedModels?, allowRemote, requireRedaction}` — e.g. `personal.normal` →
OpenRouter allowed; `finance.sensitive` → selected providers only;
`work.remote-employer` → personal model providers forbidden; `secret` → never
in model context. Context building calls policy **before** provider dispatch;
denial raises and is audited before any model call. Never rely on prompts
saying "don't expose this."

Policy evaluation happens **only** in Jehad OS. Edge harnesses (OpenClaw)
receive time-boxed, single-purpose grants and cannot escalate them — the API
rejects actions outside the grant, full stop (§40 item 19 test). Grants are
revoked on run end. **[ADR-0007]** (extended), **[ADR-0009..0012]**.

---

## 10. Domain boundaries & data isolation (revised per review §3)

A domain is **not synonymous with a row-level partition in the personal
PostgreSQL database.** Each domain declares a `storage_mode`:

- **local** — canonical domain data may live in Jehad OS PostgreSQL. v1:
  `personal`, `finance`, `research`, `learning`, `creative`, and
  current-startup work *if authorized*.
- **remote** — canonical state remains in the remote environment; Jehad OS
  interacts only through a `DomainBackend` adapter and may receive responses
  allowed by policy.
- **federated** — a deliberately defined, sanitized subset of metadata may
  cross the boundary while sensitive details stay remote (e.g. "2 decisions
  need review", "1 approval pending", "adapter healthy") — cleanup §3.
- **opaque** — **zero domain-content export by default** (cleanup §3). Personal
  Jehad OS may know only that the domain/capability exists, plus adapter
  availability/health and capability availability *if policy permits*. It must
  not assume counts, titles, summaries, deadlines, project names, or decision
  metadata may cross the boundary (e.g. a future employer's domain). No
  semantic payload crosses unless the domain's policy is explicitly changed.

```ts
interface DomainBackend {
  id: string;
  mode: "local" | "remote" | "federated" | "opaque";
  query(request: DomainQuery, ctx: DomainAccessContext): Promise<DomainQueryResult>;
  context(request: ContextRequest, ctx: DomainAccessContext): Promise<ContextPacket>;
  capabilities(): Promise<DomainCapability[]>;
  health(): Promise<DomainHealth>;
}
```

Interface and invariant are established now; concrete remote backends are NOT
implemented in Phase 1 (review §22/§27 — minimal abstraction only). A fake
adapter in M4 proves the invariant per cleanup §3: a fake **federated** domain
exports only its policy-defined sanitized metadata ("2 work decisions need
review", no content); a fake **opaque** domain exports no semantic payload at
all — personal Postgres receives nothing but existence/health.
That is the faithful implementation of "data stays where it belongs;
intelligence comes to the data," and it is what a future employer may require
(managed machines, employer-approved models, no personal-DB copies, no personal
device access).

Within local domains, `domain_id` remains enforced on every read/write path in
the data layer (not by model discipline). Work domain: `detachable=true`,
excluded from personal semantic promotion (plan §6.2 gate 2), exportable +
deletable as a unit, never crosses into another domain's context package.
Finance rows carry stricter sensitivity defaults (and stricter egress policy,
plan §9). **Cross-domain composition (cleanup §4): raw cross-domain data
access is denied by default; composition is allowed only through an explicit,
policy-mediated aggregation layer** (`CrossDomainQueryPolicy.mayRead(principal,
sourceDomain, requestedFields, purpose)` conceptually) that requests the
*minimum necessary projection* from each domain — e.g. a future "what needs my
attention today" view may combine personal commitments-due + finance
attention-items + research watches as counts/items without granting any domain
unrestricted access to another; for remote/federated/opaque domains the
`DomainBackend` controls what projection may leave the boundary. Invariant:
cross-domain composition is explicit, policy-gated, least-data,
provenance-preserving; raw arbitrary cross-domain joins are forbidden. The
goal is controlled composition, not "never compose" — no federation engine is
built in Phase 1 (personal domain only); the invariant is recorded now.
Context-package design, memory-promotion rules, and the future HarnessAdapter
all consult the DomainBackend boundary. **[ADR-0010: DomainBackend storage modes]**

---

## 11. Threat model (top set; full matrix lands in `docs/threat-model.md`)

| # | Threat | Vector | Mitigation (v1) |
| --- | --- | --- | --- |
| T1 | Prompt injection via ingested content | email/web/channel text reaching a model with tools | Untrusted text is data, never instructions: extraction-only prompts, no tool grants for untrusted-source runs, injection fixtures in evals (§40 item 15) |
| T2 | Edge harness bypassing policy | OpenClaw executing privileged action directly | Privileged actions exist only behind Jehad OS API + grant; test §40 item 19 |
| T3 | Cross-domain leakage (employer → personal memory) | semantic promotion of work content | domain gate in promotion pipeline; abstract-learning allowlist |
| T4 | Secret leakage into prompts/logs/events | config drift, logging payloads | secrets from env/Keychain only; redaction at logger; events store references not bodies where sensitive; egress policy `secret → never in model context` |
| T5 | Duplicate/replayed events | adapters retrying | idempotency keys, at-least-once + handlers idempotent |
| T6 | Conflicting state across harness memories | OpenClaw memory vs canonical | OpenClaw memory is cache-only (documented in tito AGENTS.md); canonical queries go through API |
| T7 | Workflow runtime compromise / runaway spend | compromised package, loop bug | budget field on runs, enforced per model_call; kill switch (revoke grants by domain) |
| T8 | Multiple schedulers double-firing | tito cron + Jehad OS cron | ownership table (plan §5); business schedules only in Jehad OS |
| T9 | Mistaken entity resolution | extraction merges two people | commitments keep counterparty as text + optional entity link with confidence; never auto-merge |
| T10 | Stale context packages | delegated work uses outdated state | packages carry event watermark; verifier checks freshness (Phase 3) |
| T11 | Local unauthenticated API access (review §24) | malicious local process / browser / harness on this Mac | local identity credential per principal; deny all unauthenticated calls (plan §9); loopback is not identity |
| T12 | Model egress violation (review §24) | sensitive domain content sent to unauthorized provider/model | provider/domain/sensitivity egress policy enforced before context leaves the control plane (plan §9) |
| T13 | External action ambiguity (review §24) | network timeout after non-idempotent side effect | action intent/attempt/outcome states incl. `unknown`; provider idempotency keys; reconciliation workflow (plan §9) |
| T14 | False semantic canonization (review §24) | user statement or model inference promoted as objective fact | assertion_kind provenance; external claims remain claims until evidence supports them (plan §6.2) |
| T15 | Employer perimeter violation (review §24) | proprietary employer state stored in personal Postgres or sent to personal model providers | remote/opaque DomainBackend modes (plan §10); egress policy forbidding personal providers for work-remote (plan §9) |
| T16 | Artifact backup gap (review §24) | Postgres restored but filesystem artifacts lost | Phase 1 stores small artifacts in Postgres (single backup domain); restore verification covers rows + artifact content (plan §7, M1) |

---

## 12. Durable workflow runtime — Inngest first, behind the interface (revised per review §2)

**Supersedes the earlier pg-backed-first recommendation (old D1): the owner
review rejected building a bespoke durable-workflow engine.**

**[ADR-0008] Use Inngest as the initial durable workflow runtime behind the
`WorkflowRuntime` boundary.**

- Local development via the Inngest dev server (single CLI command; no
  Docker/K8s required — the premise that self-hosting demands them is outdated).
- **Jehad OS PostgreSQL remains authoritative** for world state, domain state,
  evidence, audit, permissions, decisions, commitments, events. **Inngest owns
  workflow execution/checkpoint state only** — it is an executor, never a source
  of truth. Do not duplicate the canonical event ledger inside Inngest.
- Managed vs self-hosted deployment is deferred to E2.
- All workflow-provider usage stays behind the `WorkflowRuntime` interface —
  no Inngest primitives scattered through `packages/core`; the interface lives
  in `packages/adapters` with the other ports, and the implementation in
  `packages/workflow/inngest`. Inngest is workflow *execution*, not necessarily
  a traditional long-running worker daemon: no process-topology assumptions in
  `packages/core`; the M3 spike determines the concrete dev/runtime shape
  (cleanup §6).

```text
Jehad OS event → workflow dispatch → Inngest execution
  → Jehad OS state mutation through domain services only
```

Interface (from §11.9, retained): `start(workflow, input) → WorkflowHandle ·
signal(handle, signal) · cancel(handle) · status(handle) → WorkflowStatus`.

**ADR-gating spike — first task of M3 (Kernel Phase 1; review §2 requires it
before ADR-0008 is finalized):** ADR-0008 ships with the Phase-0 docs in
status *accepted, pending spike confirmation* (satisfying exit criterion 3);
it is finalized — or returned to the owner — only after the spike:
prove, with the Inngest dev server — start workflow → persist step → terminate
app/worker → restart → resume → wait for external signal → signal → complete.
If this works cleanly, proceed with Inngest. If the spike fails an *actual*
requirement, return to the owner with the specific blocker before considering
any hand-built runtime; "Postgres is already installed" is never a reason to
write our own engine. The bespoke-engine feature list (retry policy, backoff,
leases, dead-letter, poison jobs, workflow versioning, timer correctness,
cancellation, concurrency, fan-out/fan-in, step idempotency, side-effect
replay, migration, introspection, history) is exactly what we are choosing
*not* to rebuild.

Future upgrade path is unchanged in spirit: if Inngest later fails a
demonstrated requirement, the replacement lands behind the same interface.

---

## 13. First vertical slice

**Personal Operations / Chief of Staff (directive §32, Phase 2)**, seeded without external
OAuth so no integration blocks the kernel:

- Ingest: `josctl capture "I'll send Jehad the migration plan Friday"` (CLI
  SourceAdapter) + `josctl decide "…"`. Real sources (Google Calendar — known
  from tito Q5 — then Gmail, per the E3 disposition) attach after authorization
  escalation E3.
- Extract: model-provider workflow detects commitments (who owes whom, due,
  confidence) → memory-promotion gate (with truth semantics, plan §6.2) →
  `commitments`/`decisions` rows.
- Query: `what am i waiting for / what waits on me / what changed / what is
  blocked (incl. overdue and silently stalled)` over structured state only —
  the four §40 item-5 questions, with §7's overdue/stalled variants. "Silently
  stalled" is **derived state**, not a stored status (review §17):
  `open ∧ no meaningful progress event for N days ∧ not explicitly waiting ∧
  not deferred`, with a configurable per-type threshold. Plus the leverage
  query: `what should I decide next to unlock the most downstream work?` —
  computed from the `relationships` graph (downstream unlock count, blocker
  propagation), deterministically — never LLM-guessed (review §25).
- Brief: scheduled workflow renders a delta-oriented morning brief (§31 shape)
  to stdout; iMessage delivery via OpenClaw when the edge grant exists.
- Close: scheduled evening workflow renders the §31 end-of-day state update
  (decisions made, new commitments, completed, waiting, new risks, tomorrow's
  highest-leverage unlock) to stdout, suppressed when nothing meaningful
  changed — reuses the same queries/artifact path as the morning brief.
- Review queue: escalations + semantic-promotion approvals, batched.

Sequence:

```text
CLI capture (authenticated) → POST /events → events row (idempotent, schemaVersion)
  → outbox → workflow dispatch → Inngest execution → extract (ModelProvider,
    after egress-policy check) → memory_candidates
  → promotion gate (truth semantics) → commitments/decisions/relationships (+audit)
  → cron brief workflow → queries (incl. leverage) → brief artifact (postgres) → review queue
```

Acceptance criteria (map to §40 + review §25): 2 normalize ✓ · 3 extraction
usable ✓ · 4 decision ledger ✓ · 5 four queries ✓ · 6 delta brief ✓ ·
7 leverage-ordered queue ✓ (now graph-backed) · 10 audit ✓ · 11 one capability
denial demo ✓ · 12 human-blocked time ✓ (from `human_waits` intervals) ·
13 survives worker kill -9 ✓ · 18 pause-for-approval/resume ✓ · 15 injection
fixture ✓ · 20 promotion pipeline ✓ · 14 domain isolation (a work-domain
capture whose semantic promotion is blocked by gate plan §6.2/2 while its
episodic event persists) ✓ · **plus review-§25 tests:** unauthenticated
localhost request → rejected (M2) · fake federated domain exports only
policy-approved sanitized metadata; fake opaque domain exports no semantic
payload at all — personal DB clean (M4, cleanup §3) · finance/work-sensitive
context +
unauthorized provider → denied before model call (M4/M5) · action attempt
timeout → outcome `unknown`, audit never claims success (M4, fake provider) ·
user claim "Company X has 3M customers" → persisted as claim/episode, never
silently promoted to verified fact (M5) · dependency leverage: Decision A
blocks B/C/D, E blocks F → query returns A (M6) · backup → destroy → restore
→ database + artifact both verifiably restored (M1). Items needing external
sources/harnesses (1, 8, 9, 16, 17, 19) land with E3/E4 and Phase 3.

Evals (built with the slice — no CI provider until E2, per A14). Live-model
evals run at milestone acceptance, hermetic checks on every test run:

- **Live-model evals** — run via a separate `pnpm eval` target against a pinned
  model config; require `OPENROUTER_API_KEY` in local `.env` (gitignored, per
  the AGENTS.md secrets rule; spend recorded in `model_calls` against the A13
  caps), emit an `eval_report` artifact (M5/M6 acceptance evidence), and run at
  milestone acceptance, not on every test run.
- **Labeled bootstrap evals** — sufficient to leave autonomy level 0, NOT
  sufficient evidence for broad autonomy (review §13):
  - Commitment extraction on a 25-item golden set **extended with a hard-case
    subset**: quoted speech, hypotheticals, jokes, forwarded emails, negation,
    changed/renegotiated commitments, "maybe"/"should"/"we could", third-party
    promises ("John said yesterday he'd send it Friday" must NOT become Jehad
    owes John), historical commitments, email signatures, prompt-injection
    text. Bootstrap gate ≥0.8 F1 overall; reported **per-field**: precision,
    recall, false-positive rate, due-date accuracy, direction accuracy,
    counterparty accuracy, confidence calibration. Precision is prioritized
    for anything action-driving: ≥0.9 precision on the bootstrap set before
    any propose→act automation (plan-chosen default; flag to Jehad if it
    blocks a milestone).
  - Promotion classification (≥0.9 bootstrap accuracy) across seven classes:
    preference · objective claim · decision · commitment · inference ·
    episodic-only · discard — including the claim-vs-fact distinction (T14).
- **Hermetic checks** stay in `pnpm test`: injection-resistance fixtures
  (5/5 blocked from side effects — the policy/capability gate denies before
  any model call), egress-denial test, action-timeout→unknown test, and the
  brief determinism smoke test.

`pnpm eval` is added to the AGENTS.md command table when the target lands (M5).

---

## 14. Observability strategy

- Structured JSON logs (pino) with `run_id`/`workflow_id` correlation.
- `model_calls` = cost + latency ledger per run; `human_waits` = raw wait
  intervals; **`human_blocked_ms` (the §28 north-star metric) is derived from
  `human_waits`, not stored on `runs`** (review §14) — enabling multiple waits
  per run, cause analysis by escalation reason, percentile metrics, and
  identifying repeated decision bottlenecks.
- Weekly metrics rollup job (autonomous_completion_rate, interruptions_per_day,
  false_escalation_rate, blocked-time percentiles by cause) rendered by
  `josctl metrics` — no dashboards until a user asks for one.
- Failure triage procedure v1 in `procedures/`.
- **Interaction-surface future (invariant, NOT Phase-1 scope — cleanup §7).**
  The CLI is the first surface, not the permanent product surface. Future
  Jehad OS supports multiple surfaces over the same authoritative control
  plane — conversational shell, desktop/web control center, command palette,
  mobile messaging, CLI, voice, passive notifications/briefings — carrying
  five core verbs: **ASK · TELL · DELEGATE · REVIEW · INSPECT**. Whatever the
  surface, future interfaces must be able to expose: what is running /
  completed / failed / waiting / needs me; what the system believes and why
  (which source, which model/harness, which capability, which external action,
  what it cost, whether it can be undone, what is stored). The existing schema
  (events, runs, artifacts, audit_log, model_calls, capability_grants,
  action_intents/attempts, escalations, memory/evidence) already provides
  these primitives — the kernel must not assume away the answers. No UI work
  in Phase 1 (§16); this is an observability/product invariant, satisfied by
  keeping the control plane surface-agnostic.

---

## 15. Implementation plan (Phase 0 execution → Phase 1 kernel; order per review §22)

| Step | Deliverable | Acceptance criteria |
| --- | --- | --- |
| Docs | **Sync this revision to `docs/plans/phase0.md`, keeping it current (review §27: "Revise phase0.md and the Phase-0 docs"; `.review/` is never committed, so this sync is what makes the artifacts' `plan §N` citations resolve in-repo)** + §41 artifact set + ADR-0001..0012 (ADR-0008 rewritten; 0009–0012 new) + PII-scrub-verified archives of both owner reviews at `docs/reviews/phase0-external-review.md` and `docs/reviews/phase0-final-cleanup.md` — **before any code** (this plan is their source; directive §41) | `docs/plans/phase0.md` content equals the latest revision (status header final, rev 3); every artifact references this plan section (as revised); ADRs complete; both review copies archived with the PII check re-run at archive time |
| M0 | Toolchain: Homebrew install (absent per plan §2.1 — step 0), Node 22 (brew), pnpm, PostgreSQL 16 (brew, no Docker), repo scaffold (.gitignore `data/`), CI-less test runner, **auth primitive: bootstrap migration `000_bootstrap_auth.sql` (principals table only — cleanup §2) + local bearer credential minted into Keychain; API rejects unauthenticated calls (review §4). Invariant: the API never exists unauthenticated because the full schema hasn't landed** | `pnpm build && pnpm test` green; `psql` db `jehad` reachable; unauthenticated API request → 401 |
| M1 | Remaining schema v1 migrations (plan §7 revised; auth bootstrap already landed at M0 — ownership unambiguous per cleanup §2) + db package + backup/restore | migrate up/down clean on fresh db; schema diff reviewed vs plan; nightly backup + one practiced restore that verifies **database rows AND artifact content** (Option A: artifacts in Postgres — review §11); encryption-at-rest for sensitive artifact files noted for E2 |
| M2 | Event ingest API (schema-versioned envelope) + idempotency + outbox + CLI capture adapter (SourceAdapter port), authenticated | duplicate event 200-noop; replay of outbox is safe; unauthenticated request rejected |
| M3 | **Inngest spike first** (plan §12: start → persist step → kill → restart → resume → signal wait → signal → complete; spike result recorded in ADR-0008 before proceeding) then WorkflowRuntime adapter (`packages/workflow/inngest`): steps, signals, approval waits, cron | kill -9 mid-workflow → worker restart resumes; approval pause survives restart; no Inngest imports outside `packages/workflow` |
| M4 | Policy engine + principals + capability grants w/ token possession + audit_log + action intent/attempt/outcome semantics + `policy.yaml` v1 + ModelEgressPolicy + injection fixtures + fake DomainBackend isolation test | grant-less action 403 + audited; token outside its scope rejected; injection eval 5/5; egress: finance context + unauthorized provider → denied before model call; action timeout → outcome `unknown`, audit never claims success; fake federated domain exports only policy-approved metadata and fake opaque domain exports no semantic payload — personal DB clean (cleanup §3) |
| M5 | ModelProvider port + OpenRouter impl (egress-gated) + extraction workflow + memory-promotion pipeline (assertion-kind truth semantics) + evidence links | bootstrap extraction eval ≥0.8 F1 with per-field metrics reported (incl. FPR, due-date/direction/counterparty accuracy, calibration); promotion 7-class ≥0.9; claim-not-fact test passes; all writes carry provenance |
| M6 | Vertical slice: queries (four + derived-stalled + graph-backed leverage), morning brief + evening close, review queue, human_waits | plan §13 acceptance checklist passes end-to-end incl. dependency-leverage query (A blocks B/C/D → A); demo recorded in build log |

Alongside M1–M4, introduce **only the minimal abstractions** (interface +
invariant, no unused concrete adapters — review §22/§27): DomainBackend ·
HarnessAdapter · IntegrationAdapter · WorkflowRuntime · Principal ·
CapabilityGrant. **Define the port now; implement the adapter only when
needed (cleanup §1): all six interfaces are DEFINED in Phase 1; the first
concrete IntegrationAdapter lands in Phase 2 (E3, first authorized source);
the first concrete HarnessAdapter in Phase 3 (delegation).** No Claude Code,
Codex, Hermes, OpenClaw-action, or Gmail adapter is built merely to exercise
the interfaces.

Phase boundary and terminology (review §15): Docs + M0 + M1 close Phase 0
(they are plan §1 exit criteria 2–5; criterion 1 closes with re-review of this
revision, criterion 6 closed 2026-09-16 via the owner review); M2–M6 constitute
**"Kernel Phase 1 acceptance"** — the term **"Jehad OS v1"** is reserved for
the directive §40 program-level maturity milestone and must never be used for
Phase-1 completion. After M6: Phase 1 exit review against the §40 subset in
plan §13, then escalate E2 (hosting — also the Inngest managed-vs-self-hosted
decision), E3 (sources), and E4 (OpenClaw grant scope — the Phase-2 chat
surface in plan §4.1 cannot attach without executing this standing gate)
before Phase 2. Phase ladder: Phase 0 kernel
architecture → Phase 1 kernel + personal-ops seed slice → Phase 2 authorized
personal integrations → Phase 3 delegation/harness execution → … → Product v1
(§40). Phasing note: M6 folds the directive's Phase 2 seed slice (§32) into
this plan's Phase 1 by seeding captures via CLI; "Phase 2" hereafter means
re-running that slice against authorized sources. The directive's remaining
Phase-1 build-list items — basic Pair/Delegate/Watch routing primitives (§9
agency router) — are deferred to Phase 3 with delegation, matching the
item-8/9/16 deferrals in plan §13 (only cron-watch and CLI capture are
exercised before then). The **HarnessAdapter and IntegrationAdapter
interfaces** are defined in Phase 1 alongside the other ports (cleanup §1);
their first concrete implementations are deferred — HarnessAdapter to Phase 3
(delegation), IntegrationAdapter to E3/first authorized source (its Phase-1
read path is covered by the SourceAdapter port). Transport auth is NO LONGER
deferred (A15 revised — the primitive ships at M0; harness identities and
hardening arrive with the first non-loopback caller at E4).

---

## 16. Not-now list (scope guard per review §26: correct boundaries, not new verticals)

Money movement of any kind · contract signing · Gmail/Calendar OAuth (until E3) ·
web UI / dashboards / mobile · Next.js · pgvector/semantic retrieval (no
episodic volume yet) · synthetic customers · research engine · finance
vertical · wardrobe/home twins · voice capture · multi-user (Yusra is a person
record, not a user) · agent personalities · k8s/microservices/Kafka · graph
database (the `relationships` table in Postgres suffices) · generalized
ontology · complex cloud deployment · full Hermes integration · coding-worker
orchestration · **any bespoke durable-workflow engine (only on a demonstrated
Inngest blocker, with owner sign-off)** · any concrete remote DomainBackend
(interface + fake adapter only until a real employer boundary exists) ·
concrete HarnessAdapter / IntegrationAdapter implementations ahead of their
phase (interfaces ship in Phase 1; implementations at Phase 3 / E3 —
cleanup §1) · sophisticated cross-domain federation/query engine (the
policy-mediated aggregation invariant is recorded; the engine is not Phase 1 —
cleanup §4).

---

## 17. Assumptions (chosen, not asked — flag any wrong one)

A1 Kernel lives in a new repo `~/Projects/jehad-os`; tito stays the edge repo.
*(blessed by owner review, E1)*
A2 Local-first development; cloud deployment deferred to E2 (directive §3.3
honored at deployment, not before). E2 disposition adds: build cloud-compatible
assumptions — no Mac-specific behavior in `packages/core`; backup/restore
defined now; deployment concerns behind configuration.
A3 Single user (Jehad) at the API boundary for v1 — but every caller still
authenticates as a principal (review §4).
A4 Node/TS/Postgres per §33 defaults; Fastify over Next.js for the API (no UI yet).
A5 OpenRouter is the first ModelProvider (tito already chose it, Q7 caps) —
always behind the egress policy (ADR-0012).
A6 CLI (`josctl`) is the only Phase 1 surface.
A7 Hermes not installed → cognitive shell is deferred; chat arrives via OpenClaw
channel (E4) as a plain integration, not a commitment to Hermes. *(blessed, E5/D2)*
A8 tito keeps running its own local schedules; ownership table (plan §5) governs.
A9 iMessage/Google creds live in OpenClaw/keychain, never in this repo.
A10 The Mac Mini (tito host) is unrelated to kernel hosting.
A11 **(revised per review §2/E5-D1)** Inngest is the initial durable workflow
runtime behind the `WorkflowRuntime` interface, gated on the M3 spike;
managed-vs-self-hosted is decided at E2. No bespoke engine absent a
demonstrated, owner-confirmed blocker.
A12 English-first extraction; Arabic/Islamic-content handling deferred with the
learning vertical.
A13 `$20/$50` monthly model caps from tito Q7 apply kernel-wide initially.
A14 No CI provider yet; `pnpm test` locally until E2.
A15 **(replaced per review §4)** Local authentication ships in Phase 1 (M0):
per-principal bearer credential in Keychain; loopback binding retained as
defense-in-depth, not identity. Harness identities + transport hardening at E4.
A16 All six v1 domains are `storage_mode=local`; remote/opaque DomainBackend
modes are proven with a fake adapter only (M4) until a real employer boundary
exists.
A17 Procedural memory is data (markdown/YAML/JSON in top-level `procedures/`),
loaded via a typed schema/loader in `packages/core` — not coupled to compiled
application code (review §16).

## 18. Disagreements with the directive / recommended changes

D1 **Workflow runtime — SUPERSEDED (review §2/E5):** the pg-backed-first
challenge is withdrawn; ADR-0008 now reads "Inngest first, behind the
interface," gated on the M3 spike. The old rationale (self-hosting requires
Docker/K8s) was factually stale for Inngest.
D2 **Hermes:** *(blessed by owner)* absent from this machine and non-essential
to the kernel; treat "cognitive shell" as a swappable slot (first occupant:
chat via OpenClaw channel), demote Hermes from "strong candidate" to
"unevaluated option." Do not install or architect around it during the kernel
stage.
D3 **UI:** *(blessed)* CLI-first; §30's web surfaces deferred past Phase 2 — the
review queue works fine in a terminal for a single user, and UI polish is
explicitly not success (§40).
D4 **Event naming:** *(blessed)* noun-first (`commitment.detected`),
grouping-friendly, regret-free vs subject-first — now with the compatibility
contract: immutable names, `schemaVersion` per payload, additive-only within a
version (plan §8).
D5 **§40 breadth:** *(blessed, terminology sharpened)* the 20 success criteria
are a program, not a milestone; this plan schedules the subset above (plan
§13) and defers the rest with named gates. Terminology: "Kernel Phase 1
acceptance" for M2–M6; "Jehad OS v1" reserved for §40 program-level
acceptance — Phase-1 completion never implies product v1 (review §15).

## 19. Escalations needing Jehad — answered by the owner's external review (2026-09-16, review §21)

E1 Repo split (A1): **YES — approved.** `~/Projects/jehad-os` = core/control
plane; `/Users/Shared/tito` = OpenClaw/HA edge project. Do not merge; the
separation reinforces the architecture. *(closed)*
E2 Cloud hosting target (cost, data residency, backups) before Phase 2:
**DEFER — approved, with constraints:** cloud-compatible assumptions now (no
Mac-specific behavior in core; deployment behind configuration; backup/restore
defined at M1). E2 must land before personal cloud integrations become
operationally important; it also decides Inngest managed vs self-hosted. *(standing gate)*
E3 Authorizing first personal sources: **NONE UNTIL EXPLICIT AUTHORIZATION —
approved.** Eventual order confirmed: Google Calendar → Gmail — Calendar first
because it is lower-volume and structurally easier for the first live
ingestion path (review §21/E3). Source authorization never blocks kernel
development. *(standing gate)*
E4 OpenClaw grant scope: **READ / DELIVERY ONLY FIRST — approved.** Receive
channel messages, deliver approved notifications, query explicitly exposed
read endpoints. No generic shell privilege via Jehad OS; no unrestricted
external actions; capabilities expand only after policy/audit tests exist.
*(standing gate)*
E5 D1–D5 challenges: **resolved** — D1 not blessed, revised to
Inngest-first per review §2 (see plan §12); D2 blessed; D3 blessed; D4 blessed
+ versioning rules; D5 blessed + renamed milestones. *(closed)*

Remaining decision requiring Jehad: if the M3 Inngest spike fails an actual
requirement, the fallback choice returns to the owner before any bespoke
runtime work begins.

## 20. Artifact map (plan section → §41 doc)

vision ← plan §3 · architecture ← plan §4–5 · domain-boundaries ← plan §10
(incl. DomainBackend storage modes) · threat-model ← plan §11 (incl. T11–T16) ·
data-model ← plan §7 (revised schema) · event-model ← plan §8 (incl.
compatibility contract) · policy-model ← plan §9 (incl. principals, tokens,
egress policy, action semantics) · memory-architecture ← plan §6 (incl. truth
semantics, procedures-as-data) · harness-architecture ← plan §5 + A7/D2 ·
workflow-runtime ← plan §12 (Inngest-first) · evals ← plan §13 (bootstrap
labels, per-field metrics, hard cases) · roadmap ← plan §15–16.

---

## 21. External-review integration record (2026-09-16)

Source: `.review/phase0/external-review.md` (owner; disposition: approve with
revisions). Rule applied (review §27): preserve interface + invariant now,
defer concrete implementation where Phase-1 complexity is high. No scope growth
(review §26).

| Review item | Disposition | Where |
| --- | --- | --- |
| §2 REQUIRED Inngest-first runtime | accepted; ADR-0008 rewritten; M3 spike gates it | plan §12, §15 M3, A11, D1 |
| §3 REQUIRED DomainBackend / physical employer boundary | accepted; storage modes + interface now, concrete remote backends deferred (fake-adapter test M4) | plan §10, §4, §16, A16 |
| §4 REQUIRED local authentication in Phase 1 | accepted; Keychain bearer credential per principal at M0 | plan §9, §15 M0/M2, A15 |
| §5 REQUIRED verifiable grant possession | accepted; capability token (hash stored; claims listed); machinery Phase 2+ | plan §9, §7 `capability_grants` |
| §6 REQUIRED action intent/attempt/outcome | accepted; two tables + state machine incl. `unknown`; fake provider in Phase 1 | plan §9, §7, M4 |
| §7 REQUIRED model/data egress policy | accepted; ModelEgressPolicy enforced pre-dispatch | plan §9, ADR-0012, T12 |
| §8 REQUIRED truth semantics in promotion | accepted; assertion_kind; user-declared external claims stay claims | plan §6.2, T14, M5 test |
| §9 REQUIRED first-class relationships | accepted; `relationships` table in PG; `blocked_by[]` removed | plan §7, §13 leverage query |
| §10 REQUIRED normalized assumptions | accepted; `decisions.assumptions` jsonb removed | plan §7 |
| §11 REQUIRED artifact durability | accepted; **Option A** — small artifacts in Postgres for Phase 1; `storage_backend` column; restore verifies rows + content | plan §7, M1, T16 |
| §12 REQUIRED remove PII from docs | accepted; phone/location removed; logical-ID rule stated | plan §2.2 |
| §13 REQUIRED better evals | accepted; per-field metrics, hard-case subset, 7-class promotion, bootstrap labeling, precision-first action gate | plan §13 |
| §14 REQUIRED human-blocked-time semantics | accepted; `human_waits` raw intervals; metric derived | plan §7, §14 |
| §15 REQUIRED Phase-1 vs product-v1 terminology | accepted; "Kernel Phase 1 acceptance" vs "Jehad OS v1" | plan §15, D5 |
| §16 REC procedures as data | **accepted** | plan §4.2, §5, §6.1, A17 |
| §17 REC derived "silently stalled" | **accepted** (no stored status) | plan §13 |
| §18 REC event schema versioning | **accepted** | plan §8 |
| §19 REC temporal validity | **accepted, minimal** (relationships/evidence carry it now; per-entity later) | plan §7 |
| §20 REC evidence primitive | **accepted, minimal** | plan §7, §6.2 |
| §21 E1–E5 dispositions | all recorded | plan §19 |
| §22 build order / §23 schema / §24 T11–T16 / §25 tests / §26 scope guard | incorporated | plan §15, §7, §11, §13/§15, §16 |

Final-cleanup review (`docs/reviews/phase0-final-cleanup.md`, archived from
`~/Downloads/PHASE0_REV2_FINAL_CLEANUP 2.md`; disposition: architecture
approved, apply cleanup before implementation):

| Cleanup item | Disposition | Where |
| --- | --- | --- |
| §1 REQUIRED HarnessAdapter/IntegrationAdapter phase consistency | accepted; interfaces defined Phase 1, first concrete implementations Phase 3 / E3 — "define the port now, implement the adapter only when needed" | plan §15 (abstractions + phasing note), §16 |
| §2 REQUIRED M0 auth bootstrap migration | accepted; `000_bootstrap_auth.sql` (principals only) at M0; M1 applies remaining schema; API never exists unauthenticated | plan §7 `principals`, §9, §15 M0/M1 |
| §3 REQUIRED strict `opaque` semantics | accepted; opaque = zero domain-content export by default (existence/health/capability only, policy-permitting); "2 work decisions need review" moved to federated | plan §10, §6.2 gate 2, §13/§15 M4 tests |
| §4 REQUIRED policy-mediated cross-domain composition | accepted; audit-only rule replaced — raw access denied by default, composition via explicit least-data policy-gated aggregation (`CrossDomainQueryPolicy` concept); engine NOT built in Phase 1 | plan §10, §16 |
| §5 REC action state ownership | accepted; `ActionIntent.status` (proposed/approved/prepared/cancelled) vs `ActionAttempt.outcome` (executing/succeeded/failed/unknown/reconciled) — one canonical owner per state; one intent → many attempts, history never overwritten | plan §7, §9 |
| §6 REC Inngest = execution, not necessarily worker daemon | accepted; `apps/worker` documents responsibility as register/serve workflow functions per selected deployment model; no topology assumptions in core; M3 spike decides shape | plan §4.2, §12 |
| §7 interaction/observability future | accepted (invariant note); multi-surface future (ASK/TELL/DELEGATE/REVIEW/INSPECT), visibility questions preserved by schema; no Phase-1 UI | plan §14 |
| §8 future observation/sensor layer | accepted (design note); source universe + `authorized source → SourceAdapter → … → attention item` model; connector only when derivable state is known | plan §8 |

Rejected changes: none — every REQUIRED and RECOMMENDED item of both reviews
was incorporated.
