# Jehad OS — Architecture

- **Status:** Phase 0 artifact (directive §41), derived from the Phase 0 plan,
  `docs/plans/phase0.md`, revision 3 (2026-09-16, final).
- **Sources:** plan §3 (product guardrails), plan §4 (proposed architecture:
  shape and monorepo layout), plan §5 (responsibility boundaries).
- **Citation convention (per the plan header):** bare `§N` = section N of the
  build directive (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`);
  `plan §N` = section N of the Phase 0 plan; `review §N` = the owner's
  external review (`docs/reviews/phase0-external-review.md`); `cleanup §N` =
  the owner's final-cleanup review (`docs/reviews/phase0-final-cleanup.md`).

This document defines the shape of the Jehad OS control plane: the guardrails
that bind every other decision, the system topology, the repository layout,
and the ownership boundaries that decide which component is authoritative for
each concern. It is derived from the plan — it introduces no new architecture
decisions. Sibling artifacts (see §7) cover domains, events, policy, memory,
harnesses, workflows, and evals in depth.

## 1. What Jehad OS is

Jehad OS is a durable personal AI **control plane**: it maintains structured
state about the user's world, detects what changed, decides what can proceed
autonomously, executes bounded work safely, verifies results independently,
remembers durable decisions, and surfaces only the smallest amount of human
judgment required. The durable product is the control plane and operating
model — not the integrations (§2).

Phase 0's deliverable is not code; it is architecture decisions specific
enough that Phase 1 (kernel) can be built without further design guessing
(plan §1). The governing rule for what to build now: **preserve interface +
invariant now, defer concrete implementation where Phase-1 complexity would be
high** (review §27).

## 2. Product guardrails (plan §3)

Binding constraints on all architecture, from §2 and §42:

- Not a chatbot, dashboard, agent zoo, or wrapper around any harness.
- No model or harness owns state.
- No duplicated ownership of memory, scheduling, policy, approvals, or
  workflow state.
- Employer data stays in a detachable work domain — and, per review §3, must
  be capable of **never entering personal storage at all**
  (remote/opaque domain modes, plan §10).
- No dangerous permissions to make demos work.
- Boring, durable, reversible infrastructure.
- Attention is the scarce resource — batch escalations.

## 3. Architecture shape (plan §4.1)

A single TypeScript monorepo holding the control plane. One deployable API
service, one worker process, one PostgreSQL. No microservices, no k8s, no
queue broker beyond Postgres (workflow execution state excepted — that lives
in Inngest, behind the `WorkflowRuntime` interface, per revised ADR-0008).
Verticals arrive as modules inside the same kernel, not as separate services.

**Worker-shape caveat (cleanup §6):** `apps/worker` is documented as
register/serving workflow functions and runtime integration *required by the
selected Inngest deployment model* — not a baked-in always-on queue-daemon
assumption. No process-topology assumptions are made in `packages/core`; the
M3 spike determines the concrete dev/runtime shape (plan §12, plan §15 M3).

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

### 3.1 Reading the diagram

- **Surfaces.** Phase 1 surface is the CLI (`josctl`) only (plan §17 A6). The
  Phase-2 chat surface attaches via the OpenClaw channel and cannot attach
  without executing the E4 standing gate (plan §15, plan §19). Web comes
  later; the control plane stays surface-agnostic (plan §14, cleanup §7).
- **API.** Fastify: events in, state queries out, approvals. Every call is an
  authenticated principal from day one — local bearer credential minted at M0
  (plan §9, review §4).
- **Core.** World model (PostgreSQL), event log + outbox, memory promotion,
  policy/capability + model-egress, audit + actions, review queue,
  principal/auth. Workflow *semantics* live in the core behind
  `WorkflowRuntime`; workflow *execution* is Inngest, implemented in
  `packages/workflow/inngest` (plan §12).
- **Left edge.** The OpenClaw edge node (the separate `tito` repo) attaches
  only under grants: scoped, expiring, token-verifiable (plan §9). Grant scope
  is read/delivery-only first (plan §19 E4); see
  `docs/harness-architecture.md`.
- **Right edge.** Remote/opaque domains: an `EmployerDomainAdapter` (a
  `DomainBackend`) fronts employer-approved infrastructure, and employer
  content stays there (plan §10, review §3).

**[ADR-0001]** Monorepo, single service, Postgres-only persistence (Inngest
owns workflow-execution state only, not world state — plan §12).

**[ADR-0002]** TypeScript strict; no harness/vendor SDK imports in
`packages/core`.

## 4. Adapter ports

Domain code imports interfaces only from `packages/adapters` — never a
workflow-vendor, model-provider, or harness SDK (AGENTS.md hard rule;
plan §4.2). The ports named in the diagram are:

| Port | Role | Notes |
| --- | --- | --- |
| `SourceAdapter` | normalized event ingress from authorized sources | CLI capture adapter is the Phase-1 implementation (plan §13, M2) |
| `IntegrationAdapter` | external systems / actions (read, watch, prepare, execute) | interface defined Phase 1; first concrete implementation Phase 2 at E3 (cleanup §1) |
| `HarnessAdapter` | delegate work to a harness (start/resume/status/cancel/artifacts) | interface defined Phase 1; first concrete implementation Phase 3 (cleanup §1); see `docs/harness-architecture.md` |
| `ModelProvider` | model calls, egress-gated | OpenRouter first, behind `ModelEgressPolicy` (plan §9, plan §17 A5) |
| `WorkflowRuntime` | workflow semantics (start/signal/cancel/status) | Inngest implementation in `packages/workflow/inngest`; executor only, never canonical state (plan §12) |
| `DomainBackend` | domain query/context/capabilities/health across storage modes | local/remote/federated/opaque (plan §10, review §3) |
| `Principal` / auth | authenticated callers: `user \| harness \| service \| workflow` | one local bearer credential per principal (plan §9, review §4) |

Phase discipline (plan §15, cleanup §1): all six minimal abstractions
(`DomainBackend`, `HarnessAdapter`, `IntegrationAdapter`, `WorkflowRuntime`,
`Principal`, `CapabilityGrant`) are **defined** in Phase 1; concrete adapters
are implemented only when needed — first `IntegrationAdapter` at Phase 2
(E3, first authorized source), first `HarnessAdapter` at Phase 3 (delegation).
No unused concrete adapter is built merely to exercise an interface
(review §22/§27, plan §16).

**Inngest boundary (plan §12, ADR-0008).** Jehad OS PostgreSQL remains
authoritative for world state, domain state, evidence, audit, permissions,
decisions, commitments, and events. Inngest owns workflow
execution/checkpoint state **only** — it is an executor, never a source of
truth. The canonical event ledger is never duplicated inside Inngest. The
M3 spike gates final acceptance of ADR-0008; full detail in
`docs/workflow-runtime.md`.

## 5. Monorepo layout (plan §4.2)

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

The `apps/worker` annotation is the cleanup §6 resolution: the boundary that
matters is `WorkflowRuntime` → Inngest implementation, not a permanently
owned traditional worker daemon (cleanup §6; see §3 above).

## 6. Responsibility boundaries (plan §5)

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

### 6.1 The one-owner rule

Rule enforced in code review (plan §5): **if two components can both do a
thing, one is authoritative and the other calls it through a port.**
**[ADR-0003]**

This is the mechanical expression of guardrail "no duplicated ownership"
(§2 above, §42) and applies to every row of the table: where a second
component can perform a capability (OpenClaw automations vs global workflows;
tito cron vs the scheduler; a harness's cached procedures copy vs
`procedures/`; Inngest's execution state vs the world model), exactly one
side is canonical and the other reaches it through the port — never a
parallel implementation.

### 6.2 Reading selected rows

- **Workflows split in two.** Semantics (what a workflow means, when it runs,
  what it may do) are Jehad OS's, behind `WorkflowRuntime`; execution/
  checkpoint state is Inngest's, replaceable behind the same interface
  (plan §12).
- **Schedules split by locality.** Business-domain schedules live only in the
  Jehad OS scheduler; only schedules that are *truly local* to the edge stay
  in OpenClaw (tito). This prevents the double-firing threat T8 (plan §11).
- **Identity is a principal, not a location.** Every caller — including
  harnesses — authenticates as a principal; loopback binding is
  defense-in-depth, not an identity boundary (plan §9, review §4).
- **High-risk execution stays human.** Money and contracts sit behind a human
  approval gate (later a hardened path); no autonomous agent owns them
  (§18.10, plan §9 autonomy ceiling).

Harness-specific rows are expanded in `docs/harness-architecture.md`.

## 7. Cross-cutting invariants recorded with this architecture

Two boundaries from adjacent plan sections constrain this architecture and
are recorded here so the shape is not misread:

- **Inngest is workflow execution only, never canonical state** (plan §12,
  cleanup §6). No topology assumptions in `packages/core`; the M3 spike
  decides the concrete dev/runtime shape. Detail: `docs/workflow-runtime.md`.
- **Cross-domain composition is policy-mediated aggregation** (plan §10,
  cleanup §4). Raw cross-domain data access is denied by default; composition
  happens only through an explicit, policy-gated, least-data,
  provenance-preserving aggregation layer (conceptually
  `CrossDomainQueryPolicy.mayRead(principal, sourceDomain, requestedFields,
  purpose)`); raw arbitrary cross-domain joins are forbidden. No federation
  engine is built in Phase 1 — the invariant is recorded now. Detail:
  `docs/domain-boundaries.md`.

## 8. Related artifacts

| Artifact | Covers |
| --- | --- |
| `docs/harness-architecture.md` | harnesses as replaceable peripherals; OpenClaw grants (E4); HarnessAdapter phasing |
| `docs/domain-boundaries.md` | domain storage modes (local/remote/federated/opaque), DomainBackend |
| `docs/workflow-runtime.md` | Inngest-first behind WorkflowRuntime; the M3 spike |
| `docs/data-model.md`, `docs/event-model.md`, `docs/policy-model.md`, `docs/memory-architecture.md` | schema v1, event contract, capability/egress policy, memory classes + promotion |
| `docs/threat-model.md` | T1–T16, including harness and workflow-runtime threats |
| `docs/adr/` | ADR-0001..0012 (ADR-0008 accepted — spike confirmed 2026-09-17) |
