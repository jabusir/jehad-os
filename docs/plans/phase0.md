# Jehad OS — Phase 0 Plan: Architecture & Kernel Definition

- **Status:** draft — in plan review
- **Date:** 2026-09-16
- **Driver:** `~/Downloads/JEHAD_OS_BUILD_DIRECTIVE(1).md` (the north star; section
  references below use `§`)
- **Related:** `/Users/Shared/tito` (household edge node: OpenClaw + Home Assistant,
  plan `~/Downloads/home-ai-agent.md`)
- **Repo:** `~/Projects/jehad-os` (this repo)

Phase 0's deliverable is not code — it is a set of architecture decisions specific
enough that Phase 1 (kernel) can be built without further design guessing, plus the
smallest credible implementation sequence. This document is the master plan; the
`docs/` artifacts required by §41 are produced from it as the first implementation
step (see §15).

---

## 1. Objective and Phase 0 exit criteria

Phase 0 is done when all of the following are true:

1. This plan is reviewed and finalized.
2. The §41 artifact set exists in `docs/` (vision, architecture, domain-boundaries,
   threat-model, data-model, event-model, policy-model, memory-architecture,
   harness-architecture, workflow-runtime, evals, roadmap) — each derived from the
   corresponding section of this plan, each reviewed against the directive.
3. ADRs exist for every decision marked **[ADR]** in this document.
4. Toolchain bootstrap (M0) is done: Node 22, pnpm, PostgreSQL 16 running locally.
5. Kernel schema v1 (M1) is migrated into a live local database.
6. The escalation list (§19) has Jehad's answers or is explicitly deferred with a
   safe default.

Non-goals for Phase 0: no autonomous actions, no external integrations, no UI,
no cloud deployment.

---

## 2. Current-state assessment (facts, verified 2026-09-16)

### 2.1 Machine and runtime (this Mac; not the Mac Mini)

- macOS 26.6.2. **No Node, npm, pnpm, bun, Docker, or PostgreSQL installed.**
  Python 3.9.6 (system only). Homebrew present. → Greenfield toolchain; M0 exists
  for this reason.
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
- Owners recorded: Jehad (+1 562 370 7369) and Yusra; Irvine, CA; iMessage channel
  planned on a dedicated Apple ID; Google Calendar is the household calendar (Q5);
  Brave Search + OpenRouter with $20/$50 caps (Q7).
- **Relevance to Jehad OS:** tito is exactly the directive's §11.7 edge/integration
  harness (channels, devices, local actions). Its facts (owners, calendar provider,
  search budget) carry over as world-model seed data. Its plan does **not** cover
  the control plane — no event canonicalization, no policy engine, no memory
  promotion, no workflow runtime. Those live here.

### 2.3 Gaps the kernel must fill (nothing exists yet)

Event log with idempotency; canonical world model; capability/permission system;
audit trail; memory-promotion pipeline; durable workflows with human-approval
waits; model-provider abstraction; review/attention queue; human-blocked-time
metric. All are Phase 1 scope (§15).

---

## 3. Product guardrails (from §2, §42 — binding constraints on this plan)

Not a chatbot, dashboard, agent zoo, or wrapper around any harness. No model or
harness owns state. No duplicated ownership of memory, scheduling, policy,
approvals, or workflow state. Employer data stays in a detachable work domain.
No dangerous permissions to make demos work. Boring, durable, reversible
infrastructure. Attention is the scarce resource — batch escalations.

---

## 4. Proposed architecture

### 4.1 Shape

A single TypeScript monorepo holding the control plane. One deployable API service,
one worker process, one PostgreSQL. No microservices, no k8s, no queue broker
beyond Postgres. Verticals arrive as modules inside the same kernel, not as
separate services.

```text
   Surfaces (Phase 1: CLI; Phase 2: chat via OpenClaw channel; web later)
        │
   Jehad OS API  (Fastify: events in, state queries out, approvals)
        │
┌────────────────────────────────────────────────────────────┐
│ Jehad OS core (this repo)                                  │
│                                                            │
│  world model (pg)   event log + outbox   memory promotion  │
│  policy/capability  audit trail          review queue      │
│  workflow runtime (pg-backed, behind interface)            │
│                                                            │
│  adapter ports: SourceAdapter · IntegrationAdapter ·       │
│   HarnessAdapter · ModelProvider · WorkflowRuntime         │
└────────────┬───────────────────────────────┬───────────────┘
             │ grants (scoped, expiring)     │
      OpenClaw edge (tito repo)      coding harnesses (later)
      channels, HA, local actions    Claude Code/Codex via CLI
```

### 4.2 Monorepo layout

```text
apps/
  api/            Fastify service (HTTP + workflow handler + CLI host)
  worker/         long-running workflow executor + cron scheduler
packages/
  core/           domain model, policy, memory, events — pure TS, no SDK imports
  adapters/       port interfaces + implementations (model providers first)
  workflow/       WorkflowRuntime interface + pg implementation
  db/             migrations, query helpers, provenance mixins
docs/
  plans/ adr/     (this doc + ADRs)
infra/
  dev/            local postgres setup scripts (brew; no Docker required)
```

**[ADR-0001]** Monorepo, single service, Postgres-only persistence.
**[ADR-0002]** TypeScript strict; no harness/vendor SDK imports in `packages/core`.

---

## 5. Responsibility boundaries (who owns what)

| Concern | Canonical owner | Explicitly NOT owner |
| --- | --- | --- |
| Structured truth (semantic memory) | Jehad OS + PostgreSQL | any harness, any model |
| Episodic history (events, artifacts) | Jehad OS event log + object storage | harness chat logs |
| Working memory (session state) | active cognitive harness | Jehad OS (does not persist sessions) |
| Procedural memory (playbooks/skills) | `packages/core/procedures` (versioned in git); harnesses may cache read-only copies | harness-private skill stores |
| Policy / approvals / capability grants | Jehad OS policy engine | OpenClaw, coding harnesses |
| Audit trail | Jehad OS | everywhere else |
| Durable global workflows | Jehad OS workflow runtime | OpenClaw automations (local-only) |
| Business-domain schedules | Jehad OS scheduler | cron on any harness |
| Local edge schedules (true local) | OpenClaw (tito) | Jehad OS |
| Channel ingress/egress, devices | OpenClaw edge node under Jehad OS grants | Jehad OS (no direct iMessage/HA coupling) |
| Coding/review execution | Claude Code / Codex via HarnessAdapter (Phase 3+) | Jehad OS (dispatches only) |
| Model calls | ModelProvider port; vendors swappable per workflow | domain code |
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
| Procedural | `procedures/` in git (playbooks, extraction recipes) | versioned | "how we triage a failed workflow" |

### 6.2 Promotion pipeline (nothing auto-canonical)

```text
harness/model proposes MemoryCandidate
  → classifier assigns: discard | working | episodic | semantic | preference |
    commitment | decision | assumption | procedural | policy
  → gate applies, in order:
      1. provenance attached (source event/run, model, prompt version)
      2. domain check (work-domain content blocked from personal semantic store;
         abstract method-level learning allowed, employer specifics are not)
      3. sensitivity/retention classification
      4. confidence + conflict check (existing contradicting fact → both kept,
         conflict recorded, review queue if material)
      5. write to the matching store — semantic writes are proposals that land
         in review queue unless (a) source is the user directly, or
         (b) class is episodic
```

Promotion rules are data (config), not model judgment. First correction-scope
taxonomy (§29) ships as an enum on the candidate. **[ADR-0004]**

---

## 7. World model / database proposal (schema v1)

Schema v1 covers only what the first slice needs (directive warning: don't build
38 entities upfront). Entities from §5 not listed here are Phase 2+.

| Table | Key columns (beyond id/created_at/updated_at) |
| --- | --- |
| `domains` | key, name, sensitivity (personal/work/finance/…), retention_class, detachable bool |
| `events` | type, source, occurred_at, recorded_at, idempotency_key (unique), domain_id, payload jsonb, sensitivity, run_id |
| `entities` | discriminator (person/org/project/account…), domain_id, name, external_refs jsonb, sensitivity |
| `commitments` | direction (owes_me/i_owe), counterparty_entity_id, description, due_at, confidence, status (open/met/missed/renegotiated/void), source_event_id, may_follow_up bool, blocked_by[] |
| `decisions` | domain_id, question, chosen, alternatives jsonb, reasons, assumptions jsonb, revisit_conditions jsonb, decided_at, source_event_id |
| `assumptions` | decision_id, statement, status (held/violated/unknown), last_checked_at |
| `memory_candidates` | proposed_class, gated_class, payload jsonb, provenance jsonb, gate_result jsonb, status |
| `procedures` | id, name, version, body (git-sourced; row is an index) |
| `runs` | kind (workflow/harness), workflow_id, status, intent, domain_id, budget, started_at, ended_at, human_blocked_ms |
| `capability_grants` | run_id, capability, resource, domain_id, expires_at, revoked_at |
| `audit_log` | actor (run/user/system), action, inputs_ref, outputs_ref, grant_id, reversible bool, occurred_at |
| `escalations` | run_id, reason, urgency, consequence_of_waiting, blocked_run_ids[], est_human_minutes, status (pending/batched/resolved) |
| `model_calls` | run_id, provider, model, prompt_version, in_tokens, out_tokens, cost_usd, latency_ms, result_status |

Every table: `domain_id` + `sensitivity` where the directive requires provenance
(§5). No generic jsonb "memory" table. **[ADR-0005: schema v1 scope]**

---

## 8. Event model

Envelope (stored verbatim in `events`, plus outbox for dispatch):

```json
{
  "id": "uuid-v7",
  "type": "commitment.detected",
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
for grouping — see D4). Catalog v1: `capture.recorded`, `commitment.detected`,
`commitment.due`, `commitment.overdue`, `decision.recorded`,
`assumption.changed`, `memory.proposed`, `memory.promoted`, `run.started`,
`run.completed`, `run.failed`, `verification.failed`, `escalation.raised`,
`escalation.resolved`, `grant.issued`, `grant.revoked`, `brief.generated`.

Rules: immutable once accepted; unique `idempotency_key` enforced by constraint;
handlers idempotent (safe to replay); outbox dispatch is at-least-once.
**[ADR-0006]**

---

## 9. Capability & permission model

- Deny-by-default. A run acts only through `capability_grants` issued at dispatch:
  `{capability: "read_events" | "write_entity:<type>" | "call_model" |
  "send_channel:<id>" | "spend_budget:<usd>", resource, domainId, expiresAt}`.
- Autonomy ceiling per action type, from versioned `policy.yaml` (§35 pattern):
  v1 ships `read: autonomous · propose: autonomous · write_canonical: gated ·
  external_side_effect: approval_required · money_and_contracts: prohibited`.
- Policy evaluation happens **only** in Jehad OS. Edge harnesses (OpenClaw)
  receive time-boxed, single-purpose grants and cannot escalate them — the API
  rejects actions outside the grant, full stop (§40 item 19 test).
- Audit: every granted action writes `audit_log` before effect; grants are
  revoked on run end. **[ADR-0007]**

---

## 10. Domain boundaries & data isolation

Domains are rows, enforced by `domain_id` on every read/write path in the data
layer (not by model discipline). v1 domains: `personal`, `work`, `finance`,
`research`, `learning`, `creative`. Work domain: `detachable=true`; its data
lives in the same database but (a) is excluded from personal semantic promotion
(§6.2 gate 2), (b) is exported+deletable as a unit, (c) never crosses into
another domain's context package. Finance domain rows carry stricter sensitivity
defaults. Cross-domain queries exist only in the audit surface.

---

## 11. Threat model (top set; full matrix lands in `docs/threat-model.md`)

| # | Threat | Vector | Mitigation (v1) |
| --- | --- | --- | --- |
| T1 | Prompt injection via ingested content | email/web/channel text reaching a model with tools | Untrusted text is data, never instructions: extraction-only prompts, no tool grants for untrusted-source runs, injection fixture in evals (§40 item 15) |
| T2 | Edge harness bypassing policy | OpenClaw executing privileged action directly | Privileged actions exist only behind Jehad OS API + grant; test §40 item 19 |
| T3 | Cross-domain leakage (employer → personal memory) | semantic promotion of work content | domain gate in promotion pipeline; abstract-learning allowlist |
| T4 | Secret leakage into prompts/logs/events | config drift, logging payloads | secrets from env/Keychain only; redaction at logger; events store references not bodies where sensitive |
| T5 | Duplicate/replayed events | adapters retrying | idempotency keys, at-least-once + handlers idempotent |
| T6 | Conflicting state across harness memories | OpenClaw memory vs canonical | OpenClaw memory is cache-only (documented in tito AGENTS.md); canonical queries go through API |
| T7 | Workflow runtime compromise / runaway spend | compromised package, loop bug | budget field on runs, enforced per model_call; kill switch (revoke grants by domain) |
| T8 | Multiple schedulers double-firing | tito cron + Jehad OS cron | ownership table §5; business schedules only in Jehad OS (advisory-lock cron) |
| T9 | Mistaken entity resolution | extraction merges two people | commitments keep counterparty as text + optional entity link with confidence; never auto-merge |
| T10 | Stale context packages | delegated work uses outdated state | packages carry event watermark; verifier checks freshness (Phase 3) |

---

## 12. Durable workflow runtime — recommendation and tradeoffs

Directive default: Inngest (or Trigger.dev). **Challenge (D1): start
Postgres-backed, vendor later.**

Rationale: single-user volume; both Inngest and Trigger.dev self-hosting require
Docker/Kubernetes we don't run, and their clouds put a vendor between the control
plane and its own durability — the directive's replaceability principle cuts
against adopting one at kernel stage. A pg-backed runtime (jobs table, persisted
step state machine, signal/approval waits, advisory-lock cron) is boring,
inspectable with plain SQL, and satisfies every §11.9 requirement except fan-out
elegance.

Gate: when workflows need child-workflow fan-out, long sleeps at scale, or a
dedicated UI beyond SQL inspection, adopt Inngest **behind the existing
`WorkflowRuntime` interface** — at that point migration cost is confined to one
package. Interface (from §11.9): `start/signal/cancel/status`.

**[ADR-0008: pg-backed WorkflowRuntime, Inngest deferred to a gated upgrade]**

---

## 13. First vertical slice

**Personal Operations / Chief of Staff (§ Phase 2)**, seeded without external
OAuth so no integration blocks the kernel:

- Ingest: `josctl capture "I'll send Jehad the migration plan Friday"` (CLI
  SourceAdapter) + `josctl decide "…"`. Real sources (Google Calendar — known
  from tito Q5 — then Gmail) attach after authorization escalation E3.
- Extract: model-provider workflow detects commitments (who owes whom, due,
  confidence) → memory-promotion gate → `commitments`/`decisions` rows.
- Query: `what am i waiting for / what waits on me / overdue / stalled` over
  structured state only.
- Brief: scheduled workflow renders a delta-oriented morning brief (§31 shape)
  to stdout; iMessage delivery via OpenClaw when the edge grant exists.
- Review queue: escalations + semantic-promotion approvals, batched.

Sequence:

```text
CLI capture → POST /events → events row (idempotent)
  → outbox → extract workflow (ModelProvider) → memory_candidates
  → promotion gate → commitments/decisions (+audit)
  → cron brief workflow → queries → brief artifact → escalation queue
```

Acceptance criteria (map to §40): 2 normalize ✓ · 3 extraction usable ✓ ·
4 decision ledger ✓ · 5 four queries ✓ · 6 delta brief ✓ · 7 leverage-ordered
queue ✓ · 10 audit ✓ · 11 one capability denial demo ✓ · 12 human-blocked time ✓ ·
13 survives worker kill -9 ✓ · 18 pause-for-approval/resume ✓ · 15 injection
fixture ✓ · 20 promotion pipeline ✓. Items needing external sources/harnesses
(1, 8, 9, 14, 16, 17, 19) land with E3/E4 and Phase 3.

Evals (built with the slice, run in CI): commitment extraction P/R on a 25-item
golden set (target ≥0.8 F1 to leave autonomy level 0); injection-resistance
fixtures (must be 5/5 blocked from side effects); promotion classification
accuracy on 20 labeled candidates (≥0.9); brief determinism smoke test.

---

## 14. Observability strategy

- Structured JSON logs (pino) with `run_id`/`workflow_id` correlation.
- `model_calls` = cost + latency ledger per run; `runs.human_blocked_ms` =
  the §28 north-star metric, computed from escalation timestamps.
- Weekly metrics rollup job (autonomous_completion_rate, interruptions_per_day,
  false_escalation_rate) rendered by `josctl metrics` — no dashboards until a
  user asks for one.
- Failure triage procedure v1 in `procedures/`.

---

## 15. Implementation plan (Phase 0 execution → Phase 1 kernel)

| Step | Deliverable | Acceptance criteria |
| --- | --- | --- |
| M0 | Toolchain: Node 22 (brew), pnpm, PostgreSQL 16 (brew, no Docker), repo scaffold, CI-less test runner | `pnpm build && pnpm test` green; `psql` db `jehad` reachable |
| M1 | Schema v1 migrations (§7) + db package | migrate/up-down clean on fresh db; schema diff reviewed vs plan |
| M2 | Event ingest API + idempotency + outbox + CLI capture adapter (SourceAdapter port) | duplicate event 200-noop; replay of outbox is safe |
| M3 | WorkflowRuntime (pg): steps, signals, approval waits, advisory-lock cron, resume | kill -9 mid-workflow → worker restart resumes; approval pause survives restart |
| M4 | Policy engine + capability grants + audit_log + policy.yaml v1 + injection fixtures | grant-less action 403 + audited; injection eval 5/5 |
| M5 | ModelProvider port + OpenRouter impl + extraction workflow + memory-promotion pipeline | extraction eval ≥0.8 F1; promotion ≥0.9; all writes carry provenance |
| M6 | Vertical slice: queries, morning brief, review queue, human-blocked-time | §13 acceptance checklist passes end-to-end; demo recorded in build log |
| Docs | §41 artifact set + ADR-0001..0008 | every artifact references this plan section; ADRs complete |

After M6: Phase 1 exit review against §40, then escalate E2 (hosting) and E3
(sources) before Phase 2.

---

## 16. Not-now list

Money movement of any kind · contract signing · Gmail/Calendar OAuth (until E3) ·
web UI / dashboards · Next.js · pgvector/semantic retrieval (no episodic volume
yet) · synthetic customers · research engine · finance vertical · wardrobe/home
twins · voice capture · mobile · multi-user (Yusra is a person record, not a
user) · agent personalities · k8s/microservices · any Hermes commitment.

---

## 17. Assumptions (chosen, not asked — flag any wrong one)

A1 Kernel lives in a new repo `~/Projects/jehad-os`; tito stays the edge repo.
A2 Local-first development; cloud deployment deferred to E2 (directive §3.3
honored at deployment, not before).
A3 Single user (Jehad) at the API boundary for v1.
A4 Node/TS/Postgres per §33 defaults; Fastify over Next.js for the API (no UI yet).
A5 OpenRouter is the first ModelProvider (tito already chose it, Q7 caps).
A6 CLI (`josctl`) is the only Phase 1 surface.
A7 Hermes not installed → cognitive shell is deferred; chat arrives via OpenClaw
channel (E4) as a plain integration, not a commitment to Hermes.
A8 tito keeps running its own local schedules; ownership table (§5) governs.
A9 iMessage/Google creds live in OpenClaw/keychain, never in this repo.
A10 The Mac Mini (tito host) is unrelated to kernel hosting.
A11 pg-backed workflows suffice at single-user volume (D1).
A12 English-first extraction; Arabic/Islamic-content handling deferred with the
learning vertical.
A13 `$20/$50` monthly model caps from tito Q7 apply kernel-wide initially.
A14 No CI provider yet; `pnpm test` locally until E2.

## 18. Disagreements with the directive / recommended changes

D1 **Workflow runtime:** pg-backed now, Inngest behind the same interface at a
gated upgrade (§12) — not Inngest first.
D2 **Hermes:** absent from this machine and non-essential to the kernel; treat
"cognitive shell" as a swappable slot (first occupant: chat via OpenClaw
channel), demote Hermes from "strong candidate" to "unevaluated option."
D3 **UI:** CLI-first; §30's web surfaces deferred past Phase 2 — the review
queue works fine in a terminal for a single user, and UI polish is explicitly
not success (§40).
D4 **Event naming:** noun-first (`commitment.detected`), grouping-friendly,
regret-free vs subject-first.
D5 **§40 breadth:** v1's 20 success criteria are a program, not a milestone;
this plan explicitly schedules the subset above (§13) and defers the rest with
named gates — recommend the directive adopt that framing.

## 19. Escalations needing Jehad (answer or bless the default)

E1 Repo split (A1): `jehad-os` core here + tito as edge. Default: yes. *(reversible)*
E2 Cloud hosting target for the control plane (cost, data residency, backups)
before Phase 2. Default: defer; kernel runs locally until then. *(costly,
security-sensitive)*
E3 Authorizing first personal sources (Google Calendar then Gmail OAuth scopes).
Default: none until you approve. *(externally consequential)*
E4 OpenClaw grant scope for the edge node (which channels/actions may it take on
Jehad OS's behalf). Default: read-only channel delivery first. *(security-sensitive)*
E5 D1/D2/D3 challenges above — blessing requested, not required. *(reversible)*

## 20. Artifact map (plan section → §41 doc)

vision ← §3 · architecture ← §4–5 · domain-boundaries ← §10 · threat-model ← §11
· data-model ← §7 · event-model ← §8 · policy-model ← §9 · memory-architecture ←
§6 · harness-architecture ← §5 + A7/D2 · workflow-runtime ← §12 · evals ← §13 ·
roadmap ← §15–16.
