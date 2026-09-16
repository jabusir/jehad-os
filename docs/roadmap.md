# Jehad OS — Roadmap

- **Status:** derived Phase-0 artifact (§41 set), produced from
  `docs/plans/phase0.md` revision 3 (final, 2026-09-16).
- **Sources:** plan §15 (implementation plan — milestone table, phase ladder,
  standing gates), plan §16 (not-now list), plan §12 (M3 Inngest spike
  contingency), plan §19 (escalation dispositions E1–E5).
- **Citation convention:** bare `§N` = the build directive
  (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`); `plan §N` = the Phase 0 plan
  (`docs/plans/phase0.md`); `review §N` = the owner's external review
  (`docs/reviews/phase0-external-review.md`); `cleanup §N` = the owner's
  final-cleanup review (`docs/reviews/phase0-final-cleanup.md`).

## 1. Milestones (plan §15; order per review §22)

| Step | Deliverable | Acceptance criteria |
| --- | --- | --- |
| Docs | Sync the plan revision to `docs/plans/phase0.md` + §41 artifact set + ADR-0001..0012 (ADR-0008 rewritten; 0009–0012 new) + PII-scrub-verified archives of both owner reviews at `docs/reviews/` — **before any code** (the plan is the artifacts' source; §41) | `docs/plans/phase0.md` content equals the latest revision (status header final, rev 3); every artifact references this plan section (as revised); ADRs complete; both review copies archived with the PII check re-run at archive time |
| M0 | Toolchain: Homebrew install (absent per plan §2.1 — step 0), Node 22 (brew), pnpm, PostgreSQL 16 (brew, no Docker), repo scaffold (.gitignore `data/`), CI-less test runner, **auth primitive: bootstrap migration `000_bootstrap_auth.sql` (principals table only — cleanup §2) + local bearer credential minted into Keychain; API rejects unauthenticated calls (review §4). Invariant: the API never exists unauthenticated because the full schema hasn't landed** | `pnpm build && pnpm test` green; `psql` db `jehad` reachable; unauthenticated API request → 401 |
| M1 | Remaining schema v1 migrations (plan §7 revised; auth bootstrap already landed at M0 — ownership unambiguous per cleanup §2) + db package + backup/restore | migrate up/down clean on fresh db; schema diff reviewed vs plan; nightly backup + one practiced restore that verifies **database rows AND artifact content** (Option A: artifacts in Postgres — review §11); encryption-at-rest for sensitive artifact files noted for E2 |
| M2 | Event ingest API (schema-versioned envelope) + idempotency + outbox + CLI capture adapter (SourceAdapter port), authenticated | duplicate event 200-noop; replay of outbox is safe; unauthenticated request rejected |
| M3 | **Inngest spike first** (plan §12: start → persist step → kill → restart → resume → signal wait → signal → complete; spike result recorded in ADR-0008 before proceeding) then WorkflowRuntime adapter (`packages/workflow/inngest`): steps, signals, approval waits, cron | kill -9 mid-workflow → worker restart resumes; approval pause survives restart; no Inngest imports outside `packages/workflow` |
| M4 | Policy engine + principals + capability grants w/ token possession + audit_log + action intent/attempt/outcome semantics + `policy.yaml` v1 + ModelEgressPolicy + injection fixtures + fake DomainBackend isolation test | grant-less action 403 + audited; token outside its scope rejected; injection eval 5/5; egress: finance context + unauthorized provider → denied before model call; action timeout → outcome `unknown`, audit never claims success; fake federated domain exports only policy-approved metadata and fake opaque domain exports no semantic payload — personal DB clean (cleanup §3) |
| M5 | ModelProvider port + OpenRouter impl (egress-gated) + extraction workflow + memory-promotion pipeline (assertion-kind truth semantics) + evidence links | bootstrap extraction eval ≥0.8 F1 with per-field metrics reported (incl. FPR, due-date/direction/counterparty accuracy, calibration); promotion 7-class ≥0.9; claim-not-fact test passes; all writes carry provenance |
| M6 | Vertical slice: queries (four + derived-stalled + graph-backed leverage), morning brief + evening close, review queue, human_waits | plan §13 acceptance checklist passes end-to-end incl. dependency-leverage query (A blocks B/C/D → A); demo recorded in build log |

## 2. Minimal abstractions alongside M1–M4 (plan §15; review §22/§27, cleanup §1)

Alongside M1–M4, introduce **only the minimal abstractions** (interface +
invariant, no unused concrete adapters):

```text
DomainBackend · HarnessAdapter · IntegrationAdapter · WorkflowRuntime ·
Principal · CapabilityGrant
```

Rule (cleanup §1): **define the port now; implement the adapter only when
needed.** All six interfaces are DEFINED in Phase 1; the first concrete
IntegrationAdapter lands in Phase 2 (E3, first authorized source); the first
concrete HarnessAdapter in Phase 3 (delegation). No Claude Code, Codex,
Hermes, OpenClaw-action, or Gmail adapter is built merely to exercise the
interfaces.

## 3. Phase boundary and terminology (plan §15; review §15, D5)

- **Docs + M0 + M1 close Phase 0** (they are plan §1 exit criteria 2–5;
  criterion 1 closed with re-review of the plan revision; criterion 6 closed
  2026-09-16 via the owner review).
- **M2–M6 constitute "Kernel Phase 1 acceptance."**
- The term **"Jehad OS v1"** is reserved for the §40 program-level maturity
  milestone and must never be used for Phase-1 completion (review §15, D5).
  Rationale (review §15): otherwise the repo will later contain contradictory
  "v1 complete" claims while HarnessAdapter is unexercised, OpenClaw is
  ungated, and delegation is unimplemented.
- After M6: **Phase 1 exit review** against the §40 subset in plan §13, then
  execute the standing gates E2, E3, and E4 before Phase 2.

## 4. Phase ladder (plan §15)

```text
Phase 0   kernel architecture
Phase 1   kernel + personal-ops seed slice
Phase 2   authorized personal integrations
Phase 3   delegation / harness execution
...
Product v1 = §40 program-level acceptance
```

Phasing notes (plan §15):

- M6 folds the directive's Phase 2 seed slice (§32) into this plan's Phase 1
  by seeding captures via CLI; "Phase 2" hereafter means re-running that
  slice against authorized sources.
- The directive's remaining Phase-1 build-list items — basic
  Pair/Delegate/Watch routing primitives (§9 agency router) — are deferred to
  Phase 3 with delegation, matching the item-8/9/16 deferrals in plan §13
  (only cron-watch and CLI capture are exercised before then).
- HarnessAdapter and IntegrationAdapter **interfaces** are defined in Phase 1
  alongside the other ports (cleanup §1); their first concrete
  implementations are deferred — HarnessAdapter to Phase 3 (delegation),
  IntegrationAdapter to E3/first authorized source (its Phase-1 read path is
  covered by the SourceAdapter port).
- Transport auth is NO LONGER deferred (A15 revised — the primitive ships at
  M0; harness identities and hardening arrive with the first non-loopback
  caller at E4).

## 5. Standing gates (plan §19; dispositions from review §21)

| Gate | Question | Disposition |
| --- | --- | --- |
| E1 | Repo split | **Closed — approved.** `~/Projects/jehad-os` = control plane; `/Users/Shared/tito` = OpenClaw/HA edge. Do not merge. |
| E2 | Cloud hosting (cost, data residency, backups) — also decides Inngest managed vs self-hosted | **Standing — deferred with constraints.** Cloud-compatible assumptions now (no Mac-specific behavior in `packages/core`; deployment behind configuration; backup/restore defined at M1). Must land before personal cloud integrations become operationally important, and before Phase 2. |
| E3 | Authorizing first personal sources | **Standing — none until explicit authorization.** Confirmed eventual order: Google Calendar → Gmail (Calendar first: lower-volume, structurally easier first live ingestion path). Source authorization never blocks kernel development. |
| E4 | OpenClaw grant scope | **Standing — read/delivery only first.** Receive channel messages, deliver approved notifications, query explicitly exposed read endpoints. No generic shell privilege via Jehad OS; no unrestricted external actions; capabilities expand only after policy/audit tests exist. The Phase-2 chat surface (plan §4.1) cannot attach without executing this gate. |

Remaining decision requiring Jehad (plan §19): if the M3 Inngest spike fails
an actual requirement, the fallback choice returns to the owner before any
bespoke runtime work begins.

## 6. M3 spike contingency — Inngest (plan §12; review §2)

ADR-0008 (Inngest as the initial durable workflow runtime behind the
`WorkflowRuntime` interface) ships with the Phase-0 docs in status
**accepted, pending spike confirmation**. The spike is the **first task of
M3**:

```text
start workflow → persist step → terminate app/worker → restart → resume
  → wait for external signal → signal → complete
```

- If this works cleanly with the Inngest dev server, proceed with Inngest and
  finalize ADR-0008.
- If the spike fails an **actual** requirement, return to the owner with the
  specific blocker before considering any hand-built runtime. "Postgres is
  already installed" is never a reason to write our own engine.
- The bespoke-engine feature list (retry policy, backoff, leases,
  dead-letter, poison jobs, workflow versioning, timer correctness,
  cancellation, concurrency, fan-out/fan-in, step idempotency, side-effect
  replay, migration, introspection, history) is exactly what we are choosing
  **not** to rebuild.
- Inngest owns workflow execution/checkpoint state only — never a source of
  truth for world state. Jehad OS PostgreSQL remains authoritative. If
  Inngest later fails a demonstrated requirement, the replacement lands
  behind the same interface.

## 7. Not-now list (plan §16; scope guard per review §26 — correct boundaries, not new verticals)

- Money movement of any kind
- Contract signing
- Gmail/Calendar OAuth (until E3)
- Web UI / dashboards / mobile
- Next.js
- pgvector / semantic retrieval (no episodic volume yet)
- Synthetic customers
- Research engine
- Finance vertical
- Wardrobe / home twins
- Voice capture
- Multi-user (Yusra is a person record, not a user)
- Agent personalities
- k8s / microservices / Kafka
- Graph database (the `relationships` table in Postgres suffices)
- Generalized ontology
- Complex cloud deployment
- Full Hermes integration
- Coding-worker orchestration
- Any bespoke durable-workflow engine (only on a demonstrated Inngest
  blocker, with owner sign-off)
- Any concrete remote DomainBackend (interface + fake adapter only until a
  real employer boundary exists)
- Concrete HarnessAdapter / IntegrationAdapter implementations ahead of their
  phase (interfaces ship in Phase 1; implementations at Phase 3 / E3 —
  cleanup §1)
- Sophisticated cross-domain federation/query engine (the policy-mediated
  aggregation invariant is recorded; the engine is not Phase 1 — cleanup §4)
