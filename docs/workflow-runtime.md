# Jehad OS — Workflow Runtime (Phase 0 Artifact: ADR-0008, Inngest First, Behind the Interface)

- **Status:** Phase-0 architecture artifact, derived from plan §12 (plan revision 3,
  2026-09-16). Incorporates review §2 (REQUIRED Inngest revision) and cleanup §6
  (execution-not-necessarily-daemon clarification); observability content from
  plan §14. Source of truth: `docs/plans/phase0.md` §12 — this doc derives, it
  does not re-decide.
- **Date:** 2026-09-16
- **Citation convention** (per plan header): bare `§N` = the directive
  (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`); `plan §N` = the Phase 0 plan;
  `review §N` = the external review (`docs/reviews/phase0-external-review.md`);
  `cleanup §N` = the final-cleanup review
  (`docs/reviews/phase0-final-cleanup.md`).
- **Related plan sections:** plan §4 (shape, layout), §5 (ownership table),
  §7 (`runs`), §8 (events/outbox), §13 (slice acceptance items 13/18), §15 (M3),
  §16 (not-now list), §17–§19 (A11, D1, E2, remaining owner decision).

---

## 1. Purpose and scope

Define the durable workflow runtime for the Jehad OS kernel: which system executes
workflows, what each side owns, the port boundary that keeps the executor
replaceable, the `apps/worker` responsibility, the M3 spike that gates final
acceptance of ADR-0008, and the workflow-related slice of observability. The
kernel needs durable workflows with human-approval waits from the first slice
(plan §2.3, §13); this doc records how they run without the kernel growing a
second brain.

---

## 2. ADR-0008 — Use Inngest as the initial durable workflow runtime behind the `WorkflowRuntime` boundary

**Status: accepted, pending M3 spike confirmation.**

ADR-0008 ships with the Phase-0 docs in this status (satisfying plan §1 exit
criterion 3: ADR-0008 rewritten per review §2). It is finalized — or returned to
the owner — only after the M3 spike (plan §12, §19; section 6 below).

**Supersedes:** the earlier pg-backed-first workflow recommendation (old plan
disagreement D1). The owner's external review rejected building a bespoke
durable-workflow engine (review §2), and the old rationale — Inngest/Trigger.dev
self-hosting requires Docker/Kubernetes — was factually stale for Inngest
(plan §12; plan §18 D1: challenge withdrawn per review §2/E5).

### 2.1 Context

- §11.9 requires a durable workflow runtime capable of: checkpointing, retries,
  idempotency, long sleeps without holding a process, waiting for external
  events, waiting for human approval, cancellation, resumability, scheduled
  execution, child workflows, event-driven triggers, observability — and directs
  that the selected product be treated as replaceable infrastructure behind a
  `WorkflowRuntime` interface, with no provider-specific workflow primitives
  scattered through domain code (§11.9).
- Review §2 assessed current Inngest as supporting: local development from a
  single CLI command; self-hosting from a single binary/service; SQLite by
  default for simple self-hosting persistence with optional PostgreSQL; durable
  step checkpointing; retries; event waits; human approval patterns; timers;
  concurrency / throttling / rate limiting; execution observability.
- Phase-1 needs (plan §15 M3): persisted workflow steps, signals, approval
  waits, cron, worker crash recovery, resume. Review §2's judgment on that list:
  it is "no longer a simple job queue. It is the beginning of a bespoke workflow
  engine."

### 2.2 Decision

1. Inngest is the initial durable workflow runtime, used strictly behind the
   `WorkflowRuntime` port (section 4).
2. Local development runs on the Inngest dev server — a single CLI command; no
   Docker/K8s required (plan §12; review §2).
3. The authority split (§2.3) is binding: Inngest is an executor, never a source
   of truth.
4. Managed-vs-self-hosted deployment is deferred to escalation E2
   (plan §12; §17 A11; §19 E2).
5. Final acceptance is gated on the M3 spike (section 6). If the spike fails an
   *actual* requirement, the fallback choice returns to the owner with the
   specific blocker before any bespoke runtime work begins (plan §12; §19).
   "Postgres is already installed" is never a reason to write our own engine
   (plan §12; review §2).

### 2.3 Authority split (canonical)

Plan §12: "Jehad OS PostgreSQL remains authoritative for world state, domain
state, evidence, audit, permissions, decisions, commitments, events. Inngest
owns workflow execution/checkpoint state only — it is an executor, never a
source of truth. Do not duplicate the canonical event ledger inside Inngest."

| State | Canonical owner | Notes |
| --- | --- | --- |
| World state, domain state, evidence, audit, permissions, decisions, commitments, events | Jehad OS PostgreSQL | plan §12; plan §5 ownership table |
| Workflow execution / checkpoint state (step progress, retries, queues, timers, run internals) | Inngest | executor only; replaceable behind the interface; never a source of truth (plan §5, §12) |
| Canonical event ledger | Jehad OS `events` + `outbox` (plan §7, §8) | never duplicated inside Inngest — conceptually or physically (review §2; plan §12) |
| Semantic record of a run (`kind`, `workflow_id`, `principal_id`, `status`, `intent`, `domain_id`, `budget`, timestamps) | Jehad OS `runs` table (plan §7) | linked to executor-side state via `workflow_id`; "what runs exist / ran" is answered here, not from the executor |
| Business-domain schedules (what should run when) | Jehad OS scheduler semantics (plan §5; T8) | the cron *mechanism* is exercised through the runtime adapter at M3 (plan §15); scheduling ownership never leaves Jehad OS |
| Working memory (workflow step state) | executor / harness session scope | task-scoped, not canonical (plan §6.1) |

Rules that follow from the split:

- Workflow functions read and write Jehad OS state exclusively through domain
  services (section 3). No canonical row is ever created by talking to Inngest,
  and no Inngest-stored state is ever treated as world state.
- If a question can be answered from canonical state, it is answered from
  Postgres. Inngest's own console/history is operational tooling for the
  executor, not a Jehad OS system of record.
- Reconciliation of §3's guardrail ("no duplicated ownership of … workflow
  state") with plan §5: Jehad OS owns durable global workflow *semantics*
  (behind `WorkflowRuntime`); Inngest owns execution mechanics as executor only
  (plan §5 rows: "Durable global workflows (semantics) — Jehad OS behind
  WorkflowRuntime" vs "Workflow execution/checkpoint state — Inngest (executor
  only; replaceable behind the interface)"). One authoritative owner per
  concern; the other side calls through a port (plan §5 rule, ADR-0003).
- Durability consequence, derived from plan §8: canonical truth survives
  executor-state loss. Outbox dispatch is at-least-once and handlers are
  idempotent, so losing Inngest's checkpoint state can cost in-flight
  executions but never corrupts canonical state — in-flight work is re-driven
  from the outbox/events, and completed mutations already live in Postgres.

### 2.4 Consequences

- Positive: checkpointing, retries, timers, event waits, human-approval waits,
  and execution observability arrive as product features instead of kernel
  engineering (review §2); Postgres remains the single backup domain for
  everything canonical (plan §7/M1 backup story is unaffected by this ADR).
- Accepted costs: a second runtime component to operate; a port boundary to
  keep honest (M3 acceptance enforces it — plan §15 M3); residual spike risk,
  contained by the section-6 gate.

---

## 3. Dispatch flow

Canonical flow (plan §12; review §2, verbatim):

```text
Jehad OS event → workflow dispatch → Inngest execution
  → Jehad OS state mutation through domain services only
```

Expanded to the kernel's mechanics:

```text
Jehad OS event
  (events row: idempotent, schemaVersion — plan §8)
    ↓
workflow dispatch
  (outbox, at-least-once; handlers idempotent — plan §7/§8)
    ↓
Inngest execution
  (steps, signals, approval waits, cron, crash-resume —
   executor/checkpoint state only, plan §5/§12)
    ↓
Jehad OS state mutation through domain services only
  (extraction via ModelProvider after egress-policy check →
   memory-promotion gate → commitments/decisions/relationships (+audit) —
   plan §13; model_calls / human_waits written along the way — plan §7/§14)
```

Properties:

- Every state change of consequence still flows through the event log with
  provenance (AGENTS.md hard rule; plan §8). Dispatch from the outbox means the
  workflow runtime is downstream of the ledger — never a side channel around it.
- The only writer of Jehad OS state in this flow is Jehad OS domain services,
  invoked from workflow functions. This is what makes the executor swappable:
  remove Inngest entirely and canonical state remains complete and consistent.
- External side effects attempted from workflows are modeled as
  `action_intents` → `action_attempts` with honest `unknown` outcomes and
  reconciliation workflows (plan §9) — reconciliation itself being a workflow
  behind this same runtime.
- Acceptance wiring (plan §13): item 13 "survives worker kill -9" and item 18
  "pause-for-approval/resume" exercise exactly this flow end to end at M3/M6.

---

## 4. The WorkflowRuntime boundary

Interface retained from §11.9 (plan §12); boundary sketch per review §2:

```ts
interface WorkflowRuntime {
  start<TInput>(
    workflow: WorkflowName,
    input: TInput
  ): Promise<WorkflowHandle>;

  signal(
    handle: WorkflowHandle,
    signal: WorkflowSignal
  ): Promise<void>;

  cancel(handle: WorkflowHandle): Promise<void>;

  status(handle: WorkflowHandle): Promise<WorkflowStatus>;
}
```

- Surface, fixed: `start(workflow, input) → WorkflowHandle ·
  signal(handle, signal) · cancel(handle) · status(handle) → WorkflowStatus`
  (plan §12, from §11.9). Directive §11.9/§34 sketch the first parameter as
  `WorkflowDefinition<T>`; review §2's sketch refines it to a `WorkflowName`
  plus typed input. The plan embeds the review's revision, so the name-based
  form is used here; exact typing of `WorkflowHandle`, `WorkflowStatus`, and
  the signal vocabulary is settled in the M3 adapter work, not invented in this
  doc. (Recorded as a benign variance, not a contradiction.)
- Placement: the port interface lives in `packages/adapters` with the other
  ports (plan §4.2, §12) — domain code imports interfaces only from
  `packages/adapters` (AGENTS.md hard rule). The implementation lives in
  `packages/workflow/inngest` (plan §4.2, §12; review §2).
- Import rule: no Inngest imports in `packages/core` (AGENTS.md; plan §4.2
  ADR-0002: no harness/vendor SDK imports in core). M3 acceptance sharpens it:
  *no Inngest imports outside `packages/workflow`* (plan §15 M3). `apps/worker`
  satisfies this by consuming the registration surface exported by
  `packages/workflow/inngest` rather than importing the Inngest SDK directly
  (assumption recorded in §13 below).
- Adapter scope at M3: steps, signals, approval waits, cron (plan §15 M3),
  covering the §11.9 capability list the kernel actually exercises in Phase 1 —
  child workflows and other capabilities are not built ahead of need
  (plan §15 minimal-abstractions rule; review §22/§27).

---

## 5. `apps/worker`: responsibility and process topology (cleanup §6)

- Documented responsibility (plan §4.2): `apps/worker` "registers/serves
  workflow functions + runtime integration required by the selected Inngest
  deployment model — NOT a baked-in always-on queue-daemon assumption; the M3
  spike determines the concrete dev/runtime shape (cleanup §6)."
- Inngest is workflow *execution*, not necessarily a traditional long-running
  worker daemon (plan §12; cleanup §6). The boundary that matters is:

  ```text
  WorkflowRuntime → Inngest implementation
  ```

  not "Jehad OS must permanently own a traditional worker daemon" (cleanup §6).
- No process-topology assumptions in `packages/core` (plan §12; cleanup §6).
  Whether the concrete shape is dev-server plus app-embedded serving, a
  separate worker process, or another mode is an output of the M3 spike, not an
  input to the architecture.
- Cleanup §6 permitted renaming to `apps/workflows/`; the plan keeps
  `apps/worker/` with the revised responsibility text (plan §4.2). The name is
  not architectural; the responsibility sentence is.

---

## 6. The M3 spike — ADR gate for ADR-0008

First task of M3, before the adapter work (plan §12; plan §15 M3: "spike result
recorded in ADR-0008 before proceeding"). Protocol, to be proven with the
Inngest dev server (plan §12; review §2):

```text
start workflow
→ persist step
→ terminate app/worker
→ restart
→ resume
→ wait for external signal
→ signal
→ complete
```

Disposition rules (plan §12; plan §19):

- **Passes cleanly → finalize ADR-0008.** Status moves from "accepted, pending
  M3 spike confirmation" to "accepted"; record the spike result in ADR-0008;
  proceed with the `packages/workflow/inngest` adapter (plan §15 M3).
- **Fails an actual requirement → return to the owner.** Stop; bring the
  specific blocker to the owner before considering any hand-built runtime
  (plan §12; plan §19: this is the one remaining decision explicitly requiring
  Jehad). Never a silent pivot to another engine.
- **Never:** write a bespoke engine because "Postgres is already installed"
  (plan §12; review §2).

Related M3 acceptance criteria exercising the same durability properties
(plan §15 M3; plan §13 items 13/18): kill -9 mid-workflow → worker restart
resumes; approval pause survives restart; no Inngest imports outside
`packages/workflow`.

---

## 7. What we are explicitly not building

- No bespoke durable-workflow engine — only on a demonstrated Inngest blocker,
  with owner sign-off (plan §16 not-now list; plan §12).
- The bespoke-engine feature list below is exactly what we are choosing *not*
  to rebuild (plan §12; review §2 lists them as the hidden future requirements
  of a hand-rolled engine): retry policy · backoff · leases · dead-letter
  behavior · poison jobs · workflow versioning · timer correctness ·
  cancellation semantics · concurrency · fan-out/fan-in · step idempotency ·
  side-effect replay semantics · workflow migration · run introspection ·
  execution history.
- No duplicated event ledger, scheduler, policy engine, memory, or approvals
  inside the runtime (plan §5; §3 guardrails) — the runtime executes; it does
  not own.
- No queue broker beyond Postgres except this runtime's execution state
  (plan §4.1: "no queue broker beyond Postgres (workflow execution state
  excepted — that lives in Inngest, behind the `WorkflowRuntime` interface, per
  revised ADR-0008)").

---

## 8. Observability — workflow-related slice (plan §14)

- Structured JSON logs (pino) with `run_id`/`workflow_id` correlation
  (plan §14): correlation ids tie executor-side executions to canonical
  `runs` rows in Postgres.
- `runs` is the canonical semantic record of a workflow run (plan §7);
  `model_calls` is the cost + latency ledger per run; `human_waits` stores raw
  wait intervals — approval-wait workflows write these rows through domain
  services — and `human_blocked_ms` (the §28 north-star metric) is derived from
  `human_waits`, never stored on `runs` (plan §14; review §14).
- Weekly metrics rollup job rendered by `josctl metrics`; no dashboards until a
  user asks for one (plan §14). Inngest's execution console is operational
  tooling for the executor, not a Jehad OS observability surface.
- Cleanup §7 invariant, workflow slice: future surfaces must be able to answer
  *what is running / completed / failed / waiting / needs me* — the existing
  schema (`events`, `runs`, `artifacts`, `audit_log`, `model_calls`,
  `capability_grants`, `action_intents`/`attempts`, `escalations`,
  memory/evidence) preserves those answers, and `WorkflowStatus` + `runs` keep
  the kernel surface-agnostic (plan §14). No UI work in Phase 1.

---

## 9. Threat-model touchpoints (plan §11)

- **T7 — workflow runtime compromise / runaway spend:** budget field on runs,
  enforced per `model_call`; kill switch = revoke grants by domain (plan §11).
  The executor holding no canonical state limits blast radius: a compromised
  runtime cannot silently rewrite truth it does not own.
- **T8 — multiple schedulers double-firing:** business schedules live only in
  Jehad OS (plan §5 ownership table); the runtime's cron mechanism serves Jehad
  OS scheduler semantics only. True-local edge schedules stay on OpenClaw
  (plan §5; A8).

---

## 10. Deployment decision — deferred to E2

- Managed-vs-self-hosted Inngest is decided at escalation E2, together with
  cloud hosting — a standing gate that must land before Phase 2 (plan §12;
  plan §17 A11; plan §19 E2: E2 "also decides Inngest managed vs
  self-hosted").
- Until E2: local development on the Inngest dev server; no cloud dependency;
  no Docker/K8s required (plan §12; AGENTS.md stack). Build cloud-compatible
  in the meantime — no Mac-specific behavior in `packages/core`; deployment
  concerns behind configuration (plan §17 A2/E2 disposition).
- Review §2's self-hosting facts (single binary/service; SQLite default
  persistence; optional PostgreSQL) are inputs to the E2 decision, not
  commitments.

---

## 11. Replacement path

If Inngest later fails a demonstrated requirement, the replacement lands behind
the same `WorkflowRuntime` interface — the upgrade path is unchanged in spirit
(plan §12). Because the authority split (§2.3) keeps all canonical state in
Postgres and all mutations behind domain services, an executor swap never
migrates canonical state: none lives in the executor.

---

## 12. Non-goals (Phase 0 / Phase 1)

- Bespoke durable-workflow engine (§7 above; plan §16).
- Kafka / k8s / microservices / additional queue brokers (plan §16; §3).
- Workflow UI, dashboards, or Inngest-console integrations (plan §14, §16).
- Managed/cloud deployment of the runtime (deferred to E2 — §10).
- Wiring real sources into workflows beyond the CLI capture path (plan §13;
  sources arrive at E3; plan §16).

---

## 13. Assumptions and open items (labeled, not silent — AGENTS.md)

- **W1** Exact typing of `WorkflowHandle` / `WorkflowStatus` /
  `WorkflowSignal` (and the `WorkflowName` registry) settles at M3; only the
  four-operation surface is fixed now (§11.9; plan §12; review §2).
- **W2** Reading of M3's "no Inngest imports outside `packages/workflow`":
  `apps/worker` registers functions via exports from `packages/workflow/inngest`
  and does not import the Inngest SDK directly. Flagged so the M3 review can
  confirm or relax it.
- **W3** Spike environment is the Inngest dev server on the local greenfield
  machine (plan §2.1 — nothing installed yet; M0 bootstrap precedes M3).
- **W4** Open decision requiring the owner: if the M3 spike fails an actual
  requirement, the fallback choice returns to the owner before any bespoke
  runtime work begins (plan §19).

---

## 14. Verification record

Re-checked against plan §12 (revision 3) and review §2 before commit: decision
status, authority-split wording, dispatch flow, interface shape and placement,
import rules, spike protocol and disposition rules, declined feature list,
`apps/worker` responsibility (also cleanup §6), managed-vs-self-hosted
deferral, replacement path — all traceable; no contradictions found. One benign
variance documented in §4 (parameter typing) and two labeled readings in §2.3
and W2.
