# Jehad OS — Harness Architecture

- **Status:** Phase 0 artifact (directive §41), derived from the Phase 0 plan,
  `docs/plans/phase0.md`, revision 3 (2026-09-16, final).
- **Sources:** plan §5 (responsibility boundaries — harness rows), plan §17
  A7 (cognitive shell deferred), plan §18 D2 (Hermes demoted to unevaluated
  option), plan §19 E4 (OpenClaw grant scope), plan §11 T6 (harness memory is
  cache-only), plan §15 (port phasing), cleanup §1 (define the port now,
  implement the adapter only when needed).
- **Citation convention (per the plan header):** bare `§N` = section N of the
  build directive (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`);
  `plan §N` = section N of the Phase 0 plan; `review §N` = the owner's
  external review (`docs/reviews/phase0-external-review.md`); `cleanup §N` =
  the owner's final-cleanup review (`docs/reviews/phase0-final-cleanup.md`).

This document defines how Jehad OS relates to agent/runtime harnesses: which
slots exist, who occupies them, what harnesses may and may not own, and how
they attach. It is derived from the plan — it introduces no new architecture
decisions.

## 1. Principle: control plane vs harnesses

Jehad OS distinguishes the **control plane** (this repo: world model, policy,
events, memory promotion, audit, workflow runtime, review queue) from the
**harnesses** used to perform or mediate work. A harness is a replaceable
execution or interaction environment (§11.5). Examples: OpenClaw, Claude
Code, Codex, browser/computer-use runtimes, local model runners, future
employer-internal agent systems — and, as an unevaluated option, Hermes.

None of these may become the authoritative Jehad OS database, global policy
engine, or irreplaceable orchestration layer (§11.5, §42). In this repo's
terms: **harnesses are replaceable peripherals behind adapter interfaces —
never the system of record** (AGENTS.md). The operating model must survive
the loss of any particular integration or harness (§37); if a better harness
replaces any incumbent, Jehad OS requires only a new adapter (§11.5).

## 2. Harness slots (Phase 0 stance)

| Slot | Occupant (Phase 0 stance) | When it attaches |
| --- | --- | --- |
| Edge / integration harness | OpenClaw — the `tito` repo edge node (channels, Home Assistant, local actions) | Phase 2 chat/delivery surface, only after the E4 standing gate is executed (plan §15, plan §19) |
| Coding / review harnesses | Claude Code / Codex, via `HarnessAdapter` | Phase 3+ (delegation) |
| Cognitive shell | A **swappable slot with no committed occupant.** Hermes is an unevaluated option, not a design input. First occupant of the slot: chat via the OpenClaw channel (E4), as a plain integration — not a commitment to Hermes (plan §17 A7, plan §18 D2) | Deferred; nothing to install or architect around during the kernel stage |

The directive's reference topology (§11.5) shows Hermes as the interaction
shell; that diagram is explicitly a **reference architecture, not a
dependency mandate** (§11.5). The plan supersedes it on this point, with the
owner's blessing: Hermes is absent from this machine, non-essential to the
kernel, and demoted from "strong candidate" to "unevaluated option" — do not
install or architect around it during the kernel stage (plan §2.1, plan §17
A7, plan §18 D2, review §21 E5-D2). The slot and interface are preserved; the
occupant is not chosen.

## 3. OpenClaw edge boundary

### 3.1 Good responsibilities (§11.7, plan §2.2)

- messaging/channel ingress and egress
- device nodes and home/network integrations
- local-machine actions
- browser/tool execution where appropriate
- local/edge schedules that are **truly local**
- bounded external actions through Jehad OS-issued capability grants

OpenClaw is exactly the directive's §11.7 edge/integration harness. Its repo
(`tito`) does not cover the control plane — event canonicalization, policy
engine, memory promotion, and workflow runtime live in Jehad OS (plan §2.2).

### 3.2 Explicitly not authoritative (§11.7, plan §5)

OpenClaw must not become authoritative for: global workflow lifecycle,
canonical memory, financial truth, cross-domain policy, global scheduling,
approval state, or audit truth. Per the ownership table (plan §5): channel
ingress/egress and devices are OpenClaw's *under Jehad OS grants* — Jehad OS
has no direct iMessage/Home Assistant coupling; durable global workflow
semantics belong to Jehad OS behind `WorkflowRuntime` (OpenClaw automations
are local-only); business-domain schedules belong to the Jehad OS scheduler,
only truly-local schedules stay on the edge (prevents double-firing, threat
T8, plan §11).

### 3.3 Grant scope: read/delivery-only first (plan §19 E4, a standing gate)

The owner-approved initial OpenClaw capability set via Jehad OS is
**READ / DELIVERY ONLY**:

- receive channel messages
- deliver approved notifications
- query explicitly exposed Jehad OS read endpoints

Explicitly excluded: no generic shell privilege via Jehad OS; no
unrestricted external actions. Capabilities expand only after policy/audit
tests exist (plan §19 E4).

Mechanics (plan §9): policy evaluation happens **only** in Jehad OS; edge
harnesses receive time-boxed, single-purpose grants and cannot escalate them
— the API rejects actions outside the grant, full stop (§40 item 19 test).
Grants are scoped, expiring, and token-verifiable; they are revoked on run
end. Any OpenClaw action that originates from untrusted input passes through
Jehad OS policy and capability checks before a privileged action occurs
(§11.7; prompt-injection threat T1, plan §11).

### 3.4 Schedules

Local edge schedules that are truly local stay in OpenClaw (tito); all
business-domain schedules live only in the Jehad OS scheduler (plan §5, plan
§17 A8). Two schedulers firing the same work is threat T8 (plan §11); the
ownership split is the mitigation.

## 4. Harnesses and memory

The four-class memory model is defined in `docs/memory-architecture.md`
(plan §6). The harness-relevant boundaries from the ownership table
(plan §5):

| Memory class | Relationship to harnesses |
| --- | --- |
| Working (session state) | **Owned by the active cognitive harness**; Jehad OS does not persist sessions |
| Episodic (events, artifacts) | Owned by the Jehad OS event log + artifact store; **harness chat logs are explicitly not the owner** |
| Semantic (structured truth) | Owned by Jehad OS + PostgreSQL; **any harness and any model are explicitly not the owner** |
| Procedural (playbooks/skills) | Canonical home is `procedures/` (versioned content in git; typed loader/schema in `packages/core`); **harnesses may cache read-only copies**; harness-private skill stores are explicitly not the owner (review §16) |

**Harness memory is cache-only (T6, plan §11).** OpenClaw's memory is a
cache, documented in the tito repo's AGENTS.md; canonical queries go through
the Jehad OS API. This generalizes: no harness maintains a second conflicting
world model (§11.6). Durable learning re-enters the kernel only as a
`MemoryCandidate` proposal through the promotion gate — provenance, domain,
sensitivity/egress, and confidence/conflict checks apply before anything
becomes canonical (plan §6.2). A harness convenience copy (context, skills,
history retrieval) is fine; a competing source of truth is not.

## 5. The HarnessAdapter port

### 5.1 Phasing (cleanup §1, plan §15)

- **Phase 1:** the `HarnessAdapter` interface is **defined**, alongside the
  other ports (`DomainBackend`, `IntegrationAdapter`, `WorkflowRuntime`,
  `Principal`, `CapabilityGrant`), in `packages/adapters`.
- **Phase 3:** the **first concrete HarnessAdapter implementation** lands,
  with delegation (coding/review execution via Claude Code / Codex).

The rule: **define the port now; implement the adapter only when needed.**
No Claude Code, Codex, Hermes, OpenClaw-action, or Gmail adapter is built
merely to exercise the interfaces (plan §15, plan §16, cleanup §1). This is
the review §22/§27 principle — preserve interface + invariant now, defer
concrete implementation — applied to harnesses.

### 5.2 Reference shape (§11.5, §34)

The directive sketches a capability-oriented interface (direction only; the
concrete interface is fixed in Phase 1):

```ts
interface HarnessAdapter {
  id: string;
  capabilities(): Promise<CapabilityDescriptor[]>;
  start(task: AgentTask): Promise<RunHandle>;
  resume(runId: string, input: ResumeInput): Promise<RunHandle>;
  status(runId: string): Promise<RunStatus>;
  cancel(runId: string): Promise<void>;
  artifacts(runId: string): Promise<Artifact[]>;
  logs(runId: string): AsyncIterable<RunEvent>;
}
```

### 5.3 Routing

Jehad OS routes work by **capability, policy, risk, cost, data locality, and
available context** — never hard-coded business logic around one harness
(§11.5). Directionally (§11.5, adjusted by plan §18 D2): coding
implementation → Claude Code / Codex; local device/browser/channel action →
OpenClaw; personal cognitive interaction → the swappable cognitive-shell slot
(unevaluated; chat first arrives via the OpenClaw channel, E4); future
employer work → employer-approved internal harness via the domain boundary
(plan §10).

Coding/review execution is Claude Code / Codex via `HarnessAdapter`
(Phase 3+); **Jehad OS dispatches only** (plan §5). The program-level proof
that delegation flows through a `HarnessAdapter` rather than direct provider
coupling is directive §40 item 16 — scheduled with Phase 3, not Phase 1
(plan §13, plan §15).

## 6. Harness identity and authentication

Harnesses are principals. Principal types: `user | harness | service |
workflow` (plan §9). From day one (M0) the API requires an authenticated
principal on every call and rejects unauthenticated requests (review §4,
cleanup §2); each harness gets its own local bearer credential stored in
macOS Keychain (plan §9, plan §17 A15). Loopback binding is retained as
defense-in-depth but is a network boundary, **not** an identity boundary
(review §4). Harness identities and transport hardening arrive with the first
non-loopback caller at E4 (plan §17 A15).

## 7. Ownership summary (harness rows of plan §5)

| Concern | Canonical owner | Explicitly NOT owner |
| --- | --- | --- |
| Working memory (session state) | active cognitive harness | Jehad OS (does not persist sessions) |
| Procedural memory (playbooks/skills) | `procedures/` (git; typed loader/schema in `packages/core`); harnesses may cache read-only copies | harness-private skill stores |
| Episodic history (events, artifacts) | Jehad OS event log + artifact store | harness chat logs |
| Structured truth (semantic memory) | Jehad OS + PostgreSQL | any harness, any model |
| Durable global workflows (semantics) | Jehad OS behind `WorkflowRuntime` | OpenClaw automations (local-only) |
| Business-domain schedules | Jehad OS scheduler | cron on any harness |
| Local edge schedules (true local) | OpenClaw (tito) | Jehad OS |
| Channel ingress/egress, devices | OpenClaw edge node under Jehad OS grants | Jehad OS (no direct iMessage/HA coupling) |
| Coding/review execution | Claude Code / Codex via HarnessAdapter (Phase 3+) | Jehad OS (dispatches only) |
| Policy / approvals / capability grants | Jehad OS policy engine | OpenClaw, coding harnesses |
| High-risk execution (money, contracts) | human approval gate + (later) hardened path | any autonomous agent |

If two components can both do a thing, one is authoritative and the other
calls it through a port **[ADR-0003]** (plan §5; see
`docs/architecture.md` §6.1).

## 8. Replacement and graceful degradation

The system must remain useful if Hermes is unavailable or replaced, OpenClaw
is unavailable or replaced, or Claude Code / Codex is unavailable (§37). No
single connector is foundational to the entire product (§2, §37); incomplete
state is shown honestly rather than pretending the world model is complete
(§37).
Program-level acceptance includes: canonical state survives
replacement/restart of the active cognitive harness (§40 item 17), delegated
work executes through a `HarnessAdapter` rather than direct provider coupling
(§40 item 16), and an edge/integration harness cannot bypass Jehad OS policy
for a privileged action (§40 item 19) — all scheduled for Phase 3 / E3 / E4,
not Phase 1 (plan §13, plan §15, plan §18 D5).

## 9. Related artifacts

| Artifact | Covers |
| --- | --- |
| `docs/architecture.md` | overall shape, monorepo layout, full ownership table, the one-owner rule |
| `docs/policy-model.md` | principals, capability grants w/ token possession, autonomy ceiling, action intent/attempt/outcome |
| `docs/memory-architecture.md` | four memory classes, promotion gate, truth semantics |
| `docs/workflow-runtime.md` | WorkflowRuntime boundary; why harnesses do not own global workflows |
| `docs/domain-boundaries.md` | DomainBackend storage modes constraining future employer-internal harnesses |
