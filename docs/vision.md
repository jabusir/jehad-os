# Jehad OS — Vision

- **Status:** derived Phase-0 artifact (§41 set), produced from
  `docs/plans/phase0.md` revision 3 (final, 2026-09-16).
- **Sources:** plan §1 (objective and exit criteria), plan §2 (current-state
  assessment), plan §3 (product guardrails), plan §14 (interaction-surface
  future invariant).
- **Citation convention:** bare `§N` = the build directive
  (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`); `plan §N` = the Phase 0 plan
  (`docs/plans/phase0.md`); `review §N` = the owner's external review
  (`docs/reviews/phase0-external-review.md`); `cleanup §N` = the owner's
  final-cleanup review (`docs/reviews/phase0-final-cleanup.md`).

## 1. What Jehad OS is

Jehad OS is a durable personal AI control plane that reduces the amount of
human attention required to operate work, finances, research, personal
administration, learning, and long-running projects (directive mission). It
maintains structured state about the user's world, detects what changed,
decides what can proceed autonomously, executes bounded work safely, verifies
results independently, remembers durable decisions, and surfaces only the
smallest amount of human judgment required. The durable product is the
**control plane and operating model**, not the integrations (§2).

Phase 0's deliverable is not code — it is a set of architecture decisions
specific enough that Phase 1 (kernel) can be built without further design
guessing, plus the smallest credible implementation sequence (plan §1). Per
review §27: build the smallest kernel that preserves the correct long-term
boundaries — preserve interface + invariant now, defer concrete implementation
where Phase-1 complexity would be high.

## 2. Phase 0 objective and exit criteria (plan §1)

Phase 0 is done when all of the following are true:

1. The plan is reviewed and finalized. *(reopened 2026-09-16 for
   external-review integration; re-closed on plan re-review 2026-09-16)*
2. The §41 artifact set exists in `docs/` (vision, architecture,
   domain-boundaries, threat-model, data-model, event-model, policy-model,
   memory-architecture, harness-architecture, workflow-runtime, evals,
   roadmap) — each derived from the corresponding section of the plan (as
   revised), each reviewed against the directive and the external review.
3. ADRs exist for every decision marked **[ADR]** in the plan
   (ADR-0001..0012; ADR-0008 rewritten per review §2).
4. Toolchain bootstrap (M0) is done: Node 22, pnpm, PostgreSQL 16 running
   locally, plus the local authentication primitive (review §4).
5. Kernel schema v1 (M1, revised per plan §7 / review §23) is migrated into a
   live local database, with a practiced backup/restore that covers artifacts
   (review §11).
6. The escalation list (plan §19) has Jehad's answers or is explicitly
   deferred with a safe default. *(closed 2026-09-16: E1–E5 answered by the
   owner's external review §21 — dispositions recorded in plan §19)*

Non-goals for Phase 0: no autonomous actions, no external integrations, no
UI, no cloud deployment.

## 3. Current-state assessment (plan §2; facts verified 2026-09-16)

### 3.1 Machine and runtime (this Mac; not the Mac Mini)

- macOS 26.6.2. No Node, npm, pnpm, bun, Docker, or PostgreSQL installed.
  Python 3.9.6 (system only). **Homebrew absent** (re-verified 2026-09-16
  during plan review — corrects an earlier "Homebrew present" claim).
  Installing Homebrew is M0 step 0. Greenfield toolchain; M0 exists for this
  reason.
- OpenClaw 2026.9.4 installed and live under this user: gateway LaunchAgent
  on port 18789, one agent (`main`), default model `anthropic/claude-opus-5`
  (key not yet switched; the tito plan intends OpenRouter). `~/.openclaw/`
  holds credentials, service env, exec-approvals, and a mac-control token.
- No Hermes anywhere on this machine. The directive's cognitive-shell
  candidate is absent (assumption A7, disagreement D2: the cognitive shell is
  a swappable slot; chat arrives via an OpenClaw channel at E4, not a
  commitment to Hermes).

### 3.2 Existing repo: `/Users/Shared/tito` (the future edge node)

- Phase-0 scaffold of the household agent plan (`home-ai-agent.md`): OpenClaw
  workspace (SOUL.md, skills, memory, events), Home Assistant container
  config, build log with claims C1–C11 and open questions Q1–Q13.
- Real progress, honest ledger: C2 PASS (daemon install), C1/C3/C4 PARTIAL,
  C5–C11 UNVERIFIED. Currently blocked on FileVault-off for the dedicated
  `tito` macOS user migration.
- Owners recorded: Jehad (primary user) and Yusra (household member — a
  person record, not a system user). iMessage channel planned on a dedicated
  Apple ID; Google Calendar is the household calendar (Q5); Brave Search +
  OpenRouter with $20/$50 caps (Q7). Contact-routing identifiers live in
  protected runtime state (Keychain / OpenClaw config) and are referenced by
  logical ID — never in design documentation (review §12).
- **Relevance to Jehad OS:** tito is exactly the directive's §11.7
  edge/integration harness (channels, devices, local actions). Its facts
  (owners, calendar provider, search budget) carry over as world-model seed
  data. Its plan does **not** cover the control plane — no event
  canonicalization, no policy engine, no memory promotion, no workflow
  runtime. Those live here.

### 3.3 Gaps the kernel must fill (nothing exists yet)

Event log with idempotency; canonical world model; capability/permission
system; audit trail; memory-promotion pipeline; durable workflows with
human-approval waits; model-provider abstraction; review/attention queue;
human-blocked-time metric. All are Phase 1 scope (plan §15).

## 4. Product guardrails (plan §3, from §2 and §42 — binding constraints)

- Not a chatbot, dashboard, agent zoo, or wrapper around any harness.
- No model or harness owns state.
- No duplicated ownership of memory, scheduling, policy, approvals, or
  workflow state.
- Employer data stays in a detachable work domain — and, per review §3, must
  be capable of **never entering personal storage at all**
  (remote/federated/opaque domain modes, plan §10).
- No dangerous permissions to make demos work.
- Boring, durable, reversible infrastructure.
- Attention is the scarce resource — batch escalations.

These derive from the directive's own constraints: "Jehad's attention is an
expensive dependency"; "Data stays where it belongs. Intelligence comes to
the data"; "The operating model must survive the loss of any particular
integration, employer, model provider, or device" (directive mission), and
the §42 working rules (prefer boring infrastructure; batch human escalations;
never make a harness the canonical control plane; never let two systems have
ambiguous ownership of the same responsibility).

## 5. Interaction-surface future — invariant, NOT Phase-1 scope (plan §14, cleanup §7)

The CLI is the **first surface, not the permanent product surface**. Future
Jehad OS supports multiple surfaces over the same authoritative control
plane — conversational shell, desktop/web control center, command palette,
mobile messaging, CLI, voice, passive notifications/briefings — carrying five
core verbs:

```text
ASK · TELL · DELEGATE · REVIEW · INSPECT
```

Whatever the surface, future interfaces must be able to expose: what is
running / completed / failed / waiting / needs me; and what the system
believes and why — which source, which model/harness, which capability, which
external action, what it cost, whether it can be undone, what is stored.

The existing schema (events, runs, artifacts, audit_log, model_calls,
capability_grants, action_intents/attempts, escalations, memory/evidence)
already provides these primitives — the kernel must not assume away the
answers. This is an observability/product invariant, satisfied by keeping the
control plane surface-agnostic. There is **no UI work in Phase 1** (plan §16
not-now list: web UI / dashboards / mobile; directive §30's surfaces are
deferred past Phase 2 per blessed disagreement D3).
