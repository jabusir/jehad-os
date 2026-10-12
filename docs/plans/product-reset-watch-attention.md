# Jehad OS — Product Reset: Watch + Attention (Loop-Closing Personal Operations)

- **Status:** proposed 2026-10-11. Planning artifact only — **no code**. Grounded in
  `main` @ `68ab53b` (W2E holdout final). Driven by the owner's product-reset brief
  (2026-10-11): free-form chat as a deterministic state-management interface did not
  clear the bar after five blind holdouts; the product thesis moves to
  **watch / own / operate** with natural language for goals only and direct controls
  for known state. The intelligence-reset 10-day freeze (2026-09-24,
  `docs/plans/intelligence-reset.md`) has elapsed; latest holdout commits themselves
  recommend stopping cognition R&D. This plan does not resume any frozen lane.
- **Question this plan answers:** *What is the smallest set of durable objects and
  surfaces that makes Jehad OS useful when nobody is chatting with it — and that
  keeps working even if chat is removed entirely?*
- **Relation to prior artifacts:** implements the Watch half of
  `docs/plans/delegate-watch-roadmap.md` (its typed-predicate §5.5 vocabulary, its
  reserved migration `025`, its `watch-evaluator` workflow shape) and adds the
  **AttentionItem** layer the roadmap lacked. Supersedes the roadmap's chat-first
  intake (`watch_spec` via conversation envelope) in favor of structured-first
  creation. Does not touch any accepted ADR; extends ADR-0013/0016 boundaries to the
  new surfaces (§14, §15). Two new ADRs land with ratification (§16).
- **Revision 1 (2026-10-11, owner amendment pass):** wave order inverted —
  Attention + Outcome producer + minimal Today now land in **W1** so the first
  daily dogfood arrives in ≈2.5–3.5 days, before any Watch code; Today is exposed
  **privately over the tailnet** (Tailscale Serve), not localhost-only; watch refs
  are principal-scoped; `silent` removed from item levels; producer-supplied
  `change_fingerprint`; semantic watches deferred to a post-dogfood **W7**;
  attention actions are registry-backed; HA edge runs as a persistent process, not
  a workflow; migration 025's late-landing behavior is proven empirically in W0
  (§16, §21). Review loop re-run after amendment; §27 records both passes.

## 0. Verification record (what was inspected)

Verified against `main` @ `68ab53b`, 2026-10-11:

- **Kernel reuse seams:** `events`/`outbox` append-only store
  (`packages/core/src/events/store.ts:136` `acceptEvent`, with `ON CONFLICT
  (idempotency_key) DO NOTHING` returning `accepted: true|false` for
  created-vs-no-op — the §6 match-record primitive; catalog additive-only);
  typed predicates already implemented for outcomes
  (`packages/core/src/outcomes/predicates.ts` — header L3 explicitly reserves
  `watches.condition` for this vocabulary);   resume-router precedent
  `runOutcomeResumeScan` (`packages/workflow/src/outcome-workflows.ts:752`, cron
  every minute, 15-min lookback, idempotent CAS satisfaction — plus a DB-state
  reconciler half over satisfied-but-parked waits, which is why a fixed
  lookback suffices there; watch-scan §6 has no reconciler half and therefore
  uses a watermark-driven window); reaper precedent
  (`outcome-reaper`, hourly :23); notifications queue
  (`packages/db/migrations/006_notifications.sql`, kinds widened 009/016/019;
  claim-lease + TTL + auto-approve config `packages/core/src/notifications/config.ts`);
  edge-agent delivery loop (`apps/edge-agent/src/agent.ts:129` `runOnce`, claim →
  render → delivered with `rendered_text_sha256`); reminders quiet-hours precedent
  (`packages/core/src/reminders/lifecycle.ts:37` — 22:00–07:00,
  `BRIEF_TIMEZONE` = America/Los_Angeles); `review_refs` snooze semantics
  (hide-never-freeze, `packages/core/src/imessage/review-commands.ts:762`);
  escalations table/service (`001_schema_core.sql:252`,
  `packages/core/src/escalations/service.ts`); briefs' `OutcomesBriefSection`
  (`packages/core/src/briefs/data.ts:296`); egress registry
  (`packages/core/src/egress/policy.ts:251`) + `model_calls` ledger.
- **Gmail:** adapter (`packages/adapters/src/source-adapters/gmail.ts`), sync core
  (`packages/core/src/gmail/sync.ts:382`), content lane
  (`packages/core/src/gmail/content.ts` — `gmail_messages` 7-day retention,
  `untrusted_external`, principal-UUID scoped, keyword search L344), sync worker
  (`packages/workflow/src/gmail-workflows.ts:244`, cron `*/5`), event
  `gmail.message.received` (content-free envelope payload, sync.ts:477;
  `occurredAt` stamped from `internalDateIso` — sync.ts:476 — which drives the
  §6 watermark window); content lane gated by policy `contentEnabled`
  (`packages/core/src/policy/ceiling.ts:98`, default `false`).
- **Durable work:** `outcomes`/`outcome_criteria`/`outcome_waits` (migration 024),
  `assignments` (026), verifier gate (027), executor/scanner/reaper workflows,
  outcome statuses `proposed → accepted → queued → running → waiting_external |
  waiting_user | blocked | verifying → completed | failed | cancelled`
  (`packages/core/src/outcomes/service.ts:32`).
- **Schema hole:** migrations run 000–028 with **025 deliberately reserved for
  `watches`** (`docs/plans/delegate-watch-roadmap.md:966`). No `watches` code
  exists. **No `attention_items` table exists**; `attention_item` appears only as a
  feedback `item_type` CHECK value (migrations 008:23, 016:53-57) and in
  false-alarm metrics (`packages/core/src/metrics/compute.ts:347`) — the feedback
  vocabulary already anticipates this object.
- **No web UI exists anywhere in the repo** (grep-verified; surfaces are iMessage,
  `josctl` CLI, loopback Fastify JSON API at `127.0.0.1:3000`). The roadmap's CR1
  "loopback web read-out" (§16) was sanctioned-then-frozen; this plan revives it as
  the Today surface (W1, polished in W4) with owner approval — exposed privately
  over the tailnet rather than localhost-only (§13, owner amendment 2).
- **Edge node:** `/Users/Shared/tito` already carries Home Assistant Container
  config with an MCP-exposed **entity allowlist** (`ha/config`) — the W5 Home Edge
  will normalize, not re-house, that instance.
- **External references** (cloned to a scratch dir, licenses checked — §3):
  istota-project/istota (EUPL-1.2), theexperiencecompany/gaia (PolyForm
  Noncommercial), timothy-agent/timothy (AGPL-3.0), LumabyteCo/aibutler
  (Apache-2.0). **No source is copied; only behavior patterns are adapted.**

## 1. Executive product thesis

> **Jehad OS is an always-on loop-closing personal operations system.**
> Tell it what to own once, then stop thinking about it. It watches, works,
> remembers canonical state, closes loops, escalates only meaningful exceptions,
> and returns finished work.

Three jobs: **(A) Watch my world** — declare a condition once; deterministic
machinery evaluates it; the LLM is never responsible for remembering it exists.
**(B) Own delegated personal work** — the existing Outcome/Assignment substrate
already does this; it becomes a *producer of attention*, not a rebuild.
**(C) Maintain personal/household operations** — known objects (watches,
commitments, reminders, outcomes, later home entities) get direct controls; no LLM
interprets "the photographer is handled" as a database command.

Two first-class objects carry the reset:

- **Watch** — durable, principal-scoped, typed-predicate condition over trusted
  sources, with explicit completion/expiry. Auto-satisfies when done.
- **AttentionItem** — the durable open set of things waiting on the owner.
  Delivery (iMessage/push) is a best-effort projection of it, never the record.

**Chat-removal test:** with all chat removed, Watches still evaluate, Outcomes
still complete and surface, Today still renders, iMessage still delivers
interruptions, the owner still resolves items through direct controls. The core
product survives. Chat remains only as an optional *drafting* surface for Watch
specs (validated, owner-confirmed — and deferred until after the E2E slice).

## 2. Existing Jehad OS code/state reused (nothing rebuilt)

| Area | Reused as-is / extended | Never rebuilt |
| --- | --- | --- |
| Events + outbox | `acceptEvent` single write path; additive catalog; `gmail.message.received`, `outcome.status_changed` are the v1 Watch input events | no new event bus |
| Typed predicates | `packages/core/src/outcomes/predicates.ts` validator/matcher extended with grounded content/home predicate types (v1.1, §4) | no DSL, no expression language |
| Resume-router precedent | `watch-scan` mirrors `runOutcomeResumeScan` (watermark + lookback floor + idempotent CAS), replacing its DB-state reconciler half with a watermark-driven window (§6) | — |
| Durable work | Outcomes/Assignments/Runs/Artifacts/verifier/executor untouched; **projected**, never duplicated (briefs' `OutcomesBriefSection` query pattern reused for Missions view) | no second mission engine |
| Notifications + delivery | `notifications` queue gains one `attention` kind; edge-agent claim loop unchanged; delivery-failure = row expires, item persists | no new delivery channel; iMessage stays the only outbound |
| Briefs | Morning/evening briefs gain an "Attention" section reading open `attention_items` (digest level) | briefs never become source of truth |
| Escalations | unchanged; remains *run-blocking* machinery — AttentionItems are the user-facing open set (different lifecycle, no overlap: escalations keep `human_waits` metric) | — |
| Reminders | quiet-hours window + claim-before-send discipline copied as constants/pattern | — |
| Policy ceiling | `policy.yaml` gains `watches:`/`attention:`/`home:` sections, fail-closed parser reused | — |
| Feedback + metrics | existing `useful/noise/missed/interruptive` verdicts attach to `attention_item` ids (vocabulary already in CHECK constraints); `metrics/compute.ts` extended | no new rating system |
| Gmail | canonical `gmail_messages` + content reads are the Watch's evidence join; no second Gmail store | — |
| Egress/model | `egressGatedModelProvider` + `model_calls` ledger reused only by the W7 semantic path; **W1–W6 contain zero model calls** | no model in the deterministic product |
| Auth/grants/audit | principal bearer auth on every new route; system workflow principals (`system:watch-evaluator`, `system:attention-sweeper`) mint short-lived grants like `system:gmail-sync` does | — |

## 3. External reference findings — borrowed vs. rejected

All four repos were inspected at their listed files. **No code is copied** (three of
four licenses forbid or complicate it: EUPL-1.2 weak copyleft, PolyForm
Noncommercial, AGPL-3.0; AI Butler is Apache-2.0 but Go — patterns only regardless).

### 3.1 Istota (strongest reference — Attention architecture)

**Borrowed:**
1. **Inbox ≠ delivery.** Durable item table is the system of record; pushes are
   best-effort fan-out. A failed/missing push changes nothing about the row.
2. **Three-branch dedupe write** on `UNIQUE(principal, source, fingerprint)`:
   no-row → insert **and deliver**; open → **bump** (occurrences++, refresh
   title/summary, updated_at) **without re-delivery**; closed → **reopen**
   (preserve first_raised_at) and deliver. This is the anti-spam primitive.
3. **Resolver seam.** Items carry `(source_type, source_object_id)`; a per-source
   resolver recomputes liveness; resolver returning "gone" → auto-resolve
   (`resolved_by='liveness'`). Producers close their own rows on underlying
   transitions; a bounded liveness sweep is the backstop, scanning the **whole**
   open set (oldest rows are where dead items live), cap 500/tick.
4. **Success-only delivery stamps.** `last_delivered_at` written only when a
   channel accepted; suppressing future delivery off a failed send is "the exact
   failure the inbox exists to fix."
5. **Actions POST to producer-owned routes.** No generic action dispatcher — each
   action names an existing, authorized API route; a dispatcher would be a second,
   weaker gate. No item action can approve-without-authorization.
6. **Suppression gates fail open.** Any gate whose job is *withholding* delivery
   fails toward delivering: worst case a duplicate push, never a silently lost
   issue (the durable item bounds the damage either way).
7. **"seen" ≠ "resolved"**; version-checked seen; snooze is explicit state.

**Rejected:** HEARTBEAT.md/TOML-in-markdown user interface (Jehad OS gets canonical
Watch rows with schema validation, not a hand-edited file re-parsed every sweep);
poll-everything evaluation; flat alert format with no escalation model; stringly
signature suppression (we adopt change-fingerprint instead, applied to all items).

### 3.2 GAIA (proactive defaults + workflow creation)

**Borrowed:**
1. **Small reviewed defaults/recipes** on source connect (W4+, after dogfood):
   e.g. "important-reply watch", "delegated-work blocked/ready". Idempotent,
   owner-visible, deletable. We will *not* auto-create dozens of opaque watches.
2. **Pause-with-reason discipline** (their `DeactivationReason`): every automatic
   watch pause carries a typed reason (`source_gone`, `eval_error_budget`,
   `owner_dormant`); only the reason that owns a pause may resume it.
3. **Draft-correction loop** (validate structured output, ≤2 correction rounds,
   forced fallback) — *deferred* to the optional NL drafting surface (post-E2E).

**Rejected:** prompt-as-program workflows (unauditable — our watches are typed
predicates); MongoDB system of record; Composio/vendor coupling (adapter rule);
paywall machinery; their overlapping todo/workflow systems.

### 3.3 Timothy (Missions + "results find you")

**Borrowed:**
1. **Delivery is deterministic infrastructure.** The result phase has *zero LLM
   turns*; destinations are operator-owned rows validated at creation; the model
   never addresses a delivery. Mapped onto us: outcome completion → deterministic
   AttentionItem + notification enqueue; no model in the addressing path.
2. **Park-on-delivery-failure.** A delivery failure parks the work observably
   (our equivalent: the AttentionItem stays open; the notification row expiring
   never implies the issue is gone).
3. **UI projection ideas:** actionable gates pinned at top of detail view;
   per-kind timeline renderers with forward-compatible fallback; terminal-only
   Result section; SSE/poll carries *hints*, state always from the DB.

**Rejected:** 60-column mission god-row; three parallel backoff systems;
single-process in-memory concurrency (we keep Postgres CAS discipline);
client-side re-derivation of domain relationships.

### 3.4 AI Butler (Home Assistant edge + action risk)

**Borrowed:**
1. **Monotonic risk-tier upgrade invariant.** Entity tiers
   (sensor-read / comfort / physical-security) can only ever be *raised* by config
   or discovery merges, never lowered — enforced at three independent points with
   adversarial regression tests ("config may never downgrade a lock").
2. **Unknown/default-deny domains are invisible**, not tier-guessed.
3. **Tier → capability mapping** with security tier absent from default grants;
   consequential actions require confirmation (+ our existing consent-class /
   confirm-token machinery instead of their LLM-carried PIN).
4. **Batch operations re-run the full per-step gate** with honest partial results.

**Rejected:** REST-on-demand with no event stream (we use HA's official WebSocket
API for state); PIN transmitted through model context (violates our secrets
boundary); `scene`/`script` classified as low-risk (tier-escape — we classify
automation primitives security-or-excluded); entity-name substring heuristics
("garage" in the id) as the *only* tier signal.

## 4. Proposed Watch model

Migration `025_watches.sql` (honoring the reserved number — safe: lexically before
026–028, no cross-dependencies; fresh DBs apply in order, existing DBs apply it as
a new pending migration). New module `packages/core/src/watches/`.

```sql
CREATE TABLE watches (
  id                 uuid PRIMARY KEY,
  principal_id       uuid NOT NULL REFERENCES principals(id),
  ref                text NOT NULL,              -- 4-char Crockford base32, mint-once with collision retry
                      -- scoped per principal (owner amendment 3): refs are human-typed,
                      -- so uniqueness is (principal_id, ref), not global
  title              text NOT NULL,
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('draft','active','paused','satisfied','expired','failed','cancelled')),
  source_type        text NOT NULL CHECK (source_type IN ('gmail','outcome','home_assistant')),
  predicate          jsonb NOT NULL,                -- typed, versioned, non-executable (see vocabulary below)
  evaluation_mode    text NOT NULL DEFAULT 'event' CHECK (evaluation_mode IN ('event','scheduled','hybrid')),
  attention_policy   jsonb NOT NULL DEFAULT '{}',   -- {level: silent|inbox|digest|interrupt, cooldownMinutes?, safetyClass?}
                                                   -- level 'silent' = record events/match state only, open NO
                                                   -- attention item (§5); items exist only at inbox/digest/interrupt
  completion_policy  jsonb NOT NULL DEFAULT '{}',   -- {completeOnMatch?: bool, expiresAt?: timestamptz}
  watermark          jsonb NOT NULL DEFAULT '{}',   -- per-source eval cursor {eventType, occurredAt, eventId}
  eval_state         jsonb,                         -- carried state for duration/absence semantics
  source_refs        jsonb,                         -- bound objects: {threadRef?, outcomeRef?, entityRef?}
  pause_reason       text,                          -- typed (source_gone | eval_error_budget | owner_dormant | owner_paused | content_lane_disabled)
  last_evaluated_at  timestamptz,
  last_match_at      timestamptz,
  next_evaluation_at timestamptz,
  failure_reason     text,
  created_by         text NOT NULL DEFAULT 'owner-ui',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,                   -- default 30d (roadmap §6: nothing watches forever silently)
  satisfied_at        timestamptz,
  UNIQUE (principal_id, ref)
);
CREATE INDEX watches_active_idx ON watches (principal_id, source_type, status);
```

**Typed predicate vocabulary (v1.1)** — extends `OutcomeWaitPredicate` in
`packages/core/src/watches/predicates.ts` (importing/sharing the outcome validator;
`outcomes/predicates.ts:3` already reserves this):

| Type | Shape (validated, canonicalized, fail-closed) | Evaluated by |
| --- | --- | --- |
| `arrival` (existing) | `{v:1,type:"arrival",source:"gmail",fromDomain?}` | envelope match on `gmail.message.received` (pure) |
| `content_match` (new) | `{v:1,type:"content_match",fromDomain?,fromContains?,subjectTerms?[≤6],threadRef?}` | envelope narrowing then grounded join `payload.messageId → gmail_messages` (principal-scoped, ≤7-day window) |
| `semantic_relevance` (new — **W7, post-dogfood only**) | `{v:1,type:"semantic_relevance",narrowing:content_match-fields,question:≤200 chars,threshold:0.0–1.0}` | deterministic narrowing → bounded candidate (subject+snippet) → **classification-only** model call (§15) → policy threshold; **not in the first E2E slice** (owner amendment 6 — Gmail sender/thread/subject matching + Outcome transitions answer the product question first, and W1–W6 stay model-free) |
| `duration` (new, W5) | `{v:1,type:"duration",entityRef,attribute,operator:"gte",durationMinutes:1–1440}` | scheduled evaluator over normalized home state with `eval_state` carry |
| `absence_past` (existing, now implemented) | `{v:1,type:"absence_past",source,eventSelector,deadlineIso}` | scheduled evaluator (fail-closed in outcome waits today; watches implement it) |
| `outcome_state` (new) | `{v:1,type:"outcome_state",outcomeRef,statuses:[waiting_user,blocked,failed,completed]}` | event match on `outcome.status_changed` (pure projection; the outcome producer §8 is the default path — a Watch of this type only *customizes* levels/completion) |

Hard constraints (ADR-0017 §1.2 inherited): typed, versioned, validated,
non-executable; models may *propose* specs, code validates or refuses; unknown
predicate fields → rejection, not coercion. **No universal expression language.**
Every watch is principal-scoped; creation authority is the owner (UI/API/CLI) —
not chat, not model output, not email content. Creation/activation of watches
whose predicates require the content join (`semantic_relevance`, or
`content_match` carrying `subjectTerms`/`fromContains`) is refused with a typed
error while the gmail sensor policy's content lane (`contentEnabled`,
`policy/ceiling.ts:98`) is disabled — a content-dependent watch must never sit
silently blind (envelope-only needs are the `arrival` type; an envelope-only
`content_match` evaluates without the join per §7.2). If the lane is disabled
at runtime, `watch-reaper` pauses active content-dependent watches with typed
reason `content_lane_disabled` (GAIA pause-with-reason: only lane re-enable
resumes them).

Lifecycle: `draft → active → (paused ⇄) → satisfied | expired | failed |
cancelled` — owner **stop** sets `cancelled` (mirroring `outcome.cancelled`),
which is what emits the `watch.cancelled` event already listed below and
closes the watch's outstanding attention items (§5.3); only `active` watches
are evaluated, and activation initializes the watch's watermark to the
activation instant (service-layer write; watches watch forward — §6).
`completeOnMatch=true` → first match sets `satisfied` (disposable watches,
brief §6) — the match item itself stays open for owner ack (§5.3). Expiry default 30 days; reaper pre-expiry note in evening brief. Status
transitions emit additive events `watch.created|activated|paused|resumed|
satisfied|expired|failed|cancelled` (catalog addition; payloads
ids/refs/statuses only — content-free per house contract); each predicate
match additionally emits `watch.triggered` with `externalId =
watch:<watchId>:<sourceEventRowId>` — the §6 idempotent match record (payload
ids/refs only, content-free; no `triggered` status exists — "triggered" in
the §13 Watches list is a UI projection of `last_match_at`).

## 5. Proposed AttentionItem model

Migration `029_attention_items.sql`. New module `packages/core/src/attention/`.

```sql
CREATE TABLE attention_items (
  id                    uuid PRIMARY KEY,
  principal_id          uuid NOT NULL REFERENCES principals(id),
  source_type           text NOT NULL,              -- 'watch' | 'outcome' | 'system'
  source_object_id      text NOT NULL,              -- watch id / outcome id / …
  fingerprint           text NOT NULL,              -- dedupe key, e.g. 'watch:<id>:match' / 'outcome:<id>:ready'
  kind                  text NOT NULL,              -- 'watch.match'|'outcome.ready'|'outcome.blocked'|'outcome.failed'|'home.alert'|'system.*'
  state                 text NOT NULL DEFAULT 'open'
                        CHECK (state IN ('open','seen','snoozed','resolved','dismissed')),
  level                 text NOT NULL DEFAULT 'inbox' CHECK (level IN ('inbox','digest','interrupt')),
                        -- NO 'silent': if something requires no attention it is not an
                        -- AttentionItem (owner amendment 4) — silent watch matches record
                        -- watch.triggered events + match state on the watch row only
  safety_class          text NOT NULL DEFAULT 'none' CHECK (safety_class IN ('none','security','water','safety')),
  title                 text NOT NULL,
  summary               text NOT NULL,              -- what happened
  why_it_matters        text,                       -- why the owner cares
  evidence_refs         jsonb NOT NULL DEFAULT '[]',-- [{type:'event',id},{type:'gmail_message',id},{type:'outcome',ref}]
  actions               jsonb NOT NULL DEFAULT '[]',-- typed AttentionAction[] (§13; producer-owned routes only)
  occurrences           int  NOT NULL DEFAULT 1,
  change_fingerprint    text,                       -- producer-supplied per-occurrence identity (owner
                                                        -- amendment 5): sha256 of the UNDERLYING OCCURRENCE id
                                                        -- — gmail messageId, home entity_id+last_changed (W5),
                                                        -- outcome id+target status, semantic result digest
                                                        -- (W7) — NEVER the event row id. This key is what makes
                                                        -- §18's "duplicate event ⇒ one bump, no re-delivery"
                                                        -- hold for ANY source: a re-reported occurrence arrives
                                                        -- as a NEW event row (new row id, same occurrence id)
                                                        -- and bumps without re-delivering, while the SAME row
                                                        -- re-scanned in an overlapping window is a match-record
                                                        -- no-op (§6: match records key on the event row; this
                                                        -- column keys on the occurrence). Gmail production
                                                        -- cannot mint duplicate rows — acceptEvent dedupes by
                                                        -- externalId `gmail:<messageId>` — so the duplicate-row
                                                        -- case is a defensive property for sources without that
                                                        -- guarantee (e.g. HA reconnect replays, W5); §22 D
                                                        -- injects it as a fixture. NOT a hash of the rendered
                                                        -- text; distinguishes "same occurrence seen again"
                                                        -- from "a genuinely new occurrence that happens to
                                                        -- render identically" (§12.5)
  first_raised_at       timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  seen_at               timestamptz,
  snoozed_until         timestamptz,
  snooze_count          int  NOT NULL DEFAULT 0,
  resolved_at           timestamptz,
  resolved_by           text,                       -- 'owner'|'producer'|'liveness'|'system'
  resolution_reason     text,
  last_delivered_at     timestamptz,                -- SUCCESS-ONLY stamp (Istota rule)
  delivery_attempts     int  NOT NULL DEFAULT 0,
  last_delivery_attempt_at timestamptz,
  UNIQUE (principal_id, source_type, source_object_id, fingerprint)
);
CREATE INDEX attention_open_idx ON attention_items (principal_id, state, updated_at DESC);
```

**Required semantics** (each with a dedicated test):

1. **Dedupe/bump:** the write is a read-modify-write in one transaction
   (`SELECT … FOR UPDATE`), branching on pre-write state — insert+deliver /
   bump-silent / reopen+deliver (§3.1.2). Duplicate source events collapse into
   one row.
2. **Delivery failure never deletes.** Delivery is a separate `notifications` row;
   its expiry affects nothing in `attention_items`.
3. **Auto-resolve (condition-held items only):** producers close their own rows
   on the underlying *condition* transition — the outcome hook when an outcome
   leaves `waiting_user`/`blocked` (§8), home state normalization when a
   condition-held home alert's condition is gone (`kind='home.alert'`, §9 /
   scenario C), and **watch stop**: owner `cancelled` closes the watch's
   outstanding items — match and system — with `resolved_by='producer'`,
   `resolution_reason='watch_cancelled'` (an explicit owner abandonment,
   mirroring §22 B's outcome-`cancelled` producer close — never a silent
   sweep). **A watch match item is occurrence-news, not a held condition:
   watch satisfaction never closes it.** "Plaid replied" waits for owner
   resolve/dismiss — the iMessage already says "Review in Today" (§11), and
   §11's liveness re-enqueue duty covers only *open* items, so
   auto-close-on-satisfaction combined with one failed push would erase a
   disposable watch's news entirely (the brief's §19 "failed push forgets an
   open issue" attack, inside its §6 first-class case). The watch's own system items (`missed_evidence` §7.2,
   `scan_gap` §6) follow the same rule — closed by owner ack or watch
   `cancelled` only: a later `satisfied`/`expired`/`failed` transition must
   not silently swallow the very blindness they exist to surface (their
   defining contract is "resolving it is an owner ack"). The watch liveness
   resolver returns `gone` only for `cancelled` rows (a missing watch row
   returns `unknown`, never `gone`); resolver+liveness sweep is the backstop
   (gone → `resolved_by='liveness'`).
4. **Reopen:** condition recurs after resolve → reopen preserving
   `first_raised_at`, re-deliver.
5. **UI renders from AttentionItems**, never from push history.
6. **seen ≠ resolved** (seen is a timestamp; only resolve/dismiss closes).
7. **Snooze is explicit state** (`snoozed_until` + count), visible in UI, never a
   hidden timer; a snoozed item whose `change_fingerprint` changes re-opens.

**Actions are registry-backed, never persisted endpoints** (owner amendment 8):
items store only typed `{key, args}` pairs (e.g. `{key:'attention.snooze',
args:{minutes:60}}`, `{key:'outcome.open', args:{ref:'K3PQ'}}`, `{key:
'gmail.openMessage', args:{messageId}}`). A server-side **action registry**
(`packages/core/src/attention/actions-registry.ts`) maps each key to a handler
bound to a producer-owned, principal-authorized route with a per-action argument
validator; labels are registry-provided, not row-provided. No endpoint strings,
URLs, or hrefs are ever stored in an item row or rendered from one — a poisoned
row cannot direct the UI at an arbitrary target (this hardens §3.1.5: the
producer-owns-the-route principle now holds structurally, not by convention).

## 6. Source adapter / evaluator architecture

```
 gmail sync (5m) ──▶ events: gmail.message.received ──┐
 HA edge (W5) ────▶ events: home.entity.state_changed ─├─▶ watch-scan (cron 1m, watermark window,
  outcome svc ─────▶ events: outcome.status_changed ───┘   watermark-advanced, idempotent)
                                                            │ pure predicate match
                                                            ▼
                                              watches/predicates.ts (typed, versioned)
                                                            │ match ⇒ evidence refs (eventId,
                                                            │ messageId/outcomeId — validated)
                                                            ▼
                                     attention/service.ts openOrBumpOrReopen (3-branch, txn)
                                                            │
                              ┌─────────────────────────────┴─────────────────────┐
                              ▼                                                   ▼
                 salience.ts (deterministic ladder, §12)              watch-tick (cron 5m):
                 decides level + delivery eligibility                  duration/absence predicates,
                                                             │         pending-evidence retries,
                                                             ▼         eval_state carry, expiry
                                                            ▼
                  notifications queue (kind='attention')               watch-reaper (hourly):
                  edge-agent claim → iMessage (best-effort)            expiry, stale, budget pauses
                                                            │
                                                            ▼
                  attention-liveness (cron 5m): resolver backstop over open items
```

**Evaluator core is pure** (`evaluateWatchPredicate(watch, event, ctx)` — no I/O),
making replay/audit trivial: "why did this alert?" = watch row (predicate snapshot)
+ stored match evidence + the event envelope. Event-mode evaluation is driven by
`watch-scan` (the proven `outcome-resume-scanner` pattern: every minute,
per-watch watermark `{eventType, occurredAt}` advanced only after successful
processing — at-least-once + **idempotent match records, made concrete:** each
match emits the §4 `watch.triggered` event with `externalId =
watch:<watchId>:<sourceEventRowId>`, and `acceptEvent`'s idempotency dedupe
(`ON CONFLICT (idempotency_key) DO NOTHING` on sha256(source + externalId),
returning `accepted: true|false` for created-vs-no-op — `events/store.ts:43,62`)
*is* the per-event match record — no new table, no change to the W0-frozen 025
SQL (a `watch_matches` table was considered and rejected: it would require a
new W2 migration and duplicate the events store's append-only idempotency).
The match-record insert and its attention write commit in **one transaction**,
so a no-op insert (`accepted:false`) proves the entire step previously
committed and the attention write is skipped — no committed match record can
exist without its attention write, which is what makes skip-on-no-op safe.
This one mechanism carries every anti-duplication claim in the plan: the same
row re-scanned in the 15-min overlap floor is a no-op (§22 D(i)); N distinct
duplicate rows for one occurrence produce N match records but one item and ≤1
delivery (§22 D(ii)); `pendingEvidence` retries are double-effect-free (§7.2);
watermark-gap replay after host sleep is single-effect (below, §26.1); and the
`watch.triggered` rows are the stored match evidence behind "why did this
alert" replay. (The match-record key is deliberately distinct from the §5 item
fingerprint `watch:<id>:match`: the fingerprint keys the *item* per watch, the
externalId keys the *match* per watch × source-event row.) The scan window is
`since = LEAST(now − 15m, oldest un-advanced watermark across active watches)`
(extension capped at 24h, logged when invoked): gmail sync stamps `occurredAt`
from `internalDateIso` (`sync.ts:476`), so after a host sleep the backlogged
events land with pre-sleep timestamps a fixed 15-minute lookback would skip
forever — and unlike the resume scanner, watch-scan has no DB-state
reconciler half to catch up. The watermark-driven window replays the missed
gap up to the 24h cap; idempotent match records make the replay
single-effect. When the cap actually truncates the true gap (oldest
un-advanced watermark older than now−24h — e.g. a host asleep >24h), the
scan opens/bumps one visible `system.scan_gap` attention item — digest
level, fingerprint `watch:<id>:scan_gap`, occurrences++ on later gaps (§12.6
collapse applies) — naming the unevaluated window; resolving it is an owner
ack. The skipped window must surface to the owner, never silently skip (the
§7.2 `missed_evidence` principle applied to the scan window itself). This is
the mechanical half of risk §26.1 (keep-awake discipline remains the
operational half).

**Initial watermark = activation instant.** A watch's evaluation window never
reaches earlier than its own activation: on the `draft → active` transition
the watches service initializes the empty `{}` watermark to the activation
instant (a service-layer write — the W0-proven 025 SQL and its `DEFAULT '{}'`
are untouched, §16). Watches watch forward ("tell me when Plaid replies"
means from now on); without this rule a freshly activated watch drags `since`
back through the 24h cap and false-triggers on pre-creation thread history
(scenario A's `threadRef` watch would match the security-review thread's
existing messages at creation, breaking its "exactly one attention row"
assertion). For `outcome_state` watches this is safe by construction: state
at creation is the §8 producer's job; the watch hears future transitions.
Pause/resume needs no extra rule: a paused watch's watermark does not
advance, so on resume the stale-watermark extension replays the pause gap
(≤24h; a longer pause surfaces `system.scan_gap` like any other cap
truncation) — pausing is never a data-loss event. §18 asserts: an event that
occurred before a watch's activation never matches it.

Worst-case source-event → attention latency ≈ gmail cadence (5m) + scan (1m). A push seam
(outbox handler invoking evaluation directly) is a later optimization, not v1.

The **outcome producer** (§8) does not go through watch-scan — it writes attention
in-service at transition time (low frequency, already centralized).

**Semantic watches** slot in as a bounded classification step inside watch-scan
(§15) — narrowing first, model second, deterministic threshold decides. **They are
deferred to W7** (owner amendment 6): the W1–W6 product is fully deterministic —
zero model calls anywhere in the loop.

## 7. Gmail producer design

Input: `gmail.message.received` events (content-free envelope: `messageId,
threadRef, fromDomain, senderSha256, receivedAt`). Evaluation:

1. **Envelope narrowing** (pure): `arrival`/`content_match`/`semantic_relevance`
   (the last W7-only) filter on `fromDomain`/`threadRef` off the payload — no
   content access.
2. **Grounded content join** (deterministic): for `subjectTerms`/`fromContains`,
   read `gmail_messages` via existing principal-scoped readers
    (`gmail/content.ts`) keyed by `payload.messageId`, inside the 7-day retention
    window. Terms matched case-insensitively against subject + from; **snippet/body
    never copied into events or attention payloads** — evidence refs only
    (`{type:'gmail_message', id}`).
    **Absent content row ⇒ inconclusive, not no-match.** The content row can be
    missing for two reasons: retention swept it (7-day window — then the honest
    outcome is `missed_evidence`, no match fabrication), or the content persist
    failed (sync is deliberately non-atomic with the observation event —
    `gmail/sync.ts:515` "a persist failure never fails the observation event…
    the row simply stays absent"). A Plaid reply whose persist failed must never
    be silently dropped: the scan records the candidate in
    `eval_state.pendingEvidence[]` (messageId + firstSeenAt; the watermark still
    advances — the scan window cannot carry a multi-hour retry once the event
    is processed, so the pending list does) and `watch-tick` re-tries the evidence join until
    it resolves or a bounded retry window (default 48h) expires, after which the
    watch records `missed_evidence` **and opens (or bumps) one visible
    `system.missed_evidence` attention item** (fingerprint
    `watch:<id>:missed_evidence`, level digest, occurrences++ on later misses;
    §12.6 collapse applies) whose evidence refs carry the envelope event +
    messageId — the blindness itself must surface to the owner, never silently
    record on the watch row; resolving that item is an owner ack. Idempotent
    match records make the retry free of double-effects, and `pendingEvidence[]`
    appends are idempotent by `messageId` (an event re-scanned inside an
    overlapping window never double-appends). `semantic_relevance` candidates
    (W7) follow exactly this path — an absent content row is inconclusive for them
    too (never an implicit `matched:false`), since their subject+snippet
    payload comes from the same grounded join.
3. **Match record:** `last_match_at`, evidence refs, match count; the
   attention item title/summary are rendered from envelope + predicate fields
   only (e.g. "Plaid replied — security review thread").
4. **Completion:** `completeOnMatch` → `satisfied`; else stays active (subsequent
   matches bump the same item via the stable fingerprint `watch:<id>:match`).
   Either way the item itself is occurrence-news awaiting owner resolve/dismiss
   — satisfaction is a watch-lifecycle transition, never an item resolution
   (§5.3).

No new Gmail store, no re-sync, no change to sync worker. Injection boundary:
message content reaches only (a) deterministic term matching and (b) the §15
classification context — never predicate minting, never side effects
(ADR-0016 §2.6 extended unchanged).

## 8. Outcome producer design

`packages/core/src/outcomes/service.ts` `transitionOutcome` (single transition
path, L293) gains an in-transaction hook `emitOutcomeAttention(db, outcome, next)`:

| Transition | Item (fingerprint) | Default level | Resolves when |
| --- | --- | --- | --- |
| → `waiting_user` (verify park) | `outcome:<id>:ready` "Smart-lock research is ready for your judgment" | inbox | owner decision (criterion waive/verify or outcome terminal) |
| → `blocked` | `outcome:<id>:blocked` | inbox | outcome leaves blocked |
| → `failed` | `outcome:<id>:failed` | inbox | owner ack (dismiss/resolve) |

**`completed` opens no attention item** (owner amendment 4): a completed outcome
is either (a) genuinely awaiting owner judgment — in which case the flow is
`waiting_user` → `ready`, already in the table — or (b) informational, in which
case it belongs to the **brief/result-delivery channel**, not the open attention
set. The evening brief already surfaces completed outcomes in its "resolved"
section (`briefs/data.ts` L327+); that is where completions live. No
auto-resolve-after-brief-render item exists anywhere — protecting the rule that
**seen/delivered/briefed ≠ resolved** for everything that *is* an attention item.

No polling, no LLM. Item evidence refs: outcome ref + artifact/assignment ids.
The Missions UI (§13) links through to the canonical outcome view. Resolving
`outcome:<id>:ready` records **owner acknowledgment of the item only** — the
outcome decision itself still flows through the canonical decision path behind
the evidence link, and a later re-entry into `waiting_user` reopens the item
(§5.4). An optional `outcome_state` Watch (§4) only *customizes* levels/
completion ("only bother me if blocked" = suppress `ready` for that outcome) —
never duplicates state. The executor, verifier, scanner, and reaper workflows
are untouched.

## 9. Home Assistant edge design (W5–W6)

**Transport:** official WebSocket API (`/api/websocket`) — `auth` (long-lived
token from Keychain, same secret discipline as `GMAIL_ACCESS_TOKEN`), then
`get_states` bootstrap + `subscribe_events` on `state_changed`. REST API only for
service calls (W6). Never an LLM polling HA to know if the garage is open.

**New sensor:** `packages/adapters/src/source-adapters/homeassistant.ts`
(`HomeAssistantPort`: `listStates()`, `subscribeStateChanges(handler)`,
`callService(domain, service, payload)` — v1 read-only impl). The WS connection
runs in a **persistent edge process** — `apps/home-edge`, a long-running Node
process under launchd (the `apps/edge-agent` shape), **not an Inngest workflow**
(owner amendment 7: an ephemeral/retrying workflow runtime is the wrong host for
an indefinite socket). It maintains the connection with reconnect/backoff,
bootstraps via `get_states`, subscribes to `state_changed`, and normalizes each
change into `home.entity.state_changed` events (entity_id, domain, state,
attributes subset, last_changed — content-free contract) through the existing
API ingest path. Inngest keeps only a lightweight `home-edge-watchdog` cron
(missed-heartbeat detection → one `system.*` attention item, mirroring §7.2's
blindness-surfaces rule). Normalized current-state cache table `home_entities`
(W5 migration) backs duration predicates and the read-only Home view. The
existing tito HA instance (already allowlist-gated in `ha/config`) is the target;
Jehad OS becomes another consumer of the same instance, not a second HA.

**Risk tiers (AI Butler pattern, mapped onto our authority model):**
- `tier_read` — sensor/binary_sensor/input_*/sun/weather/person/device_tracker/zone.
- `tier_comfort` — light/switch/fan/climate/media_player/cover(non-security)/humidifier/water_heater.
- `tier_security` — lock/alarm_control_panel/garage-class covers; **any entity
  promoted by config**. `scene`/`script`/`automation`/`button` domains are
  **excluded entirely** (tier-escape: they can do anything) unless individually
  allowlisted with an explicit tier.
- **Monotonic upgrade invariant** enforced at three points (config load,
  discovery merge, action gate) with adversarial tests ("config may never
  downgrade a lock"); unknown domains invisible (default-deny).

**W6 actions:** tier-comfort service calls ride `action_intents → action_attempts`
(ADR-0011) behind a `home:control` grant + notification confirm for first-use
per entity; tier-security additionally requires the existing confirm-token lane
(consequence class — same as `calendar_action`/`outcome_spec`), never a
model-carried PIN. Every attempt audited. High-risk confirmation UX = attention
item with explicit [Confirm]/[Deny] actions on producer-owned routes.

## 10. Attention lifecycle

```
        source event / transition
                 │ producer (watch-scan | outcome hook | home edge)
                 ▼
   ┌─ no row ────INSERT─── open ─────────────────────────────┐
   │                          │ seen (timestamp only)         │ deliver per salience ladder
   │                          ▼                               ▼ (notification kind=attention)
   ├─ open ───── bump ──▶ open (occurrences++, maybe re-deliver
   │                       on meaningful change / level rise)
    │                          │ owner: snooze 1h/3d/…         │ producer closes (§5.3:
    │                          ▼                                ▼ condition gone | watch stop)
   │                       snoozed ──(snoozed_until passes)──▶ open
   │                                                          │
   └─ resolved/dismissed ── reopen (condition recurs) ──▶ open (keeps first_raised_at)
                                                              │
                                              resolve/dismiss ◀┘ (resolved_by: owner|producer|liveness)
```

- Producers close their own rows (`resolveAttentionBySource`) — outcome hook
  (condition-holding state left), home state normalization (condition gone),
  and watch stop (`cancelled` closes the watch's outstanding match and system
  items, §5.3). **Watch satisfaction never closes a match item** — the match
  is occurrence-news awaiting owner ack; the watch liveness resolver returns
  `gone` only for `cancelled` (missing row → `unknown`), so un-acked news is
  never swept.
- **Liveness backstop:** `attention-liveness` sweep (every 5m) runs resolvers over
  the whole open set (cap 500, oldest first). Resolver = pure function of
  (source_type, source_object_id, current DB state) → `live | gone | unknown`;
  `unknown` never closes anything (fail toward a clearable row over a wrongly
  swept one). The watch resolver's truth table: `gone` only for `cancelled`
  (§5.3); a missing watch row is `unknown`. Unregistered source types render
  with stored text + Dismiss only.
- Terminal rows retained 30d for metrics/dogfood, then purged by the liveness
  sweep (chunked deletes). Open rows are never age-deleted.

## 11. Delivery / iMessage architecture

Rule: **ATTENTION ITEM = durable truth; DELIVERY = best-effort projection.**

- New notification kind `attention` (migration `030`, config auto-approve list +
  policy ratification — it is owner-directed, like `brief`; recipient = owner's
  paired handle; the §4 reply-conjunction is unaffected).
- Enqueue at open / reopen / bump-with-meaningful-change, after the salience
  ladder (§12) decides the item is deliverable *now*. Enqueue failure logs;
  the liveness sweep re-enqueues items whose latest eligible delivery never
  succeeded — the enqueue itself failed, or the notification TTL lapsed
  without a delivered callback (§22 A exercises this live) — provided the
  ladder still deems them deliverable and no unexpired notification for the
  item is pending (at most one in-flight delivery per item;
  `delivery_attempts`/`last_delivery_attempt_at` account the retries).
- Rendering is deterministic (no LLM): `What happened / why it matters / actions`
  as three short lines; action buttons on the Today UI, terse verbs in iMessage
  text (v1 iMessage carries no inline buttons — the Today surface is the
  action surface; iMessage says "Review in Today").
- edge-agent claim/delivered loop unchanged; `last_delivered_at` on the attention
  row is stamped **only** from the notification's delivered callback (success-only).
- Interrupt class bypasses quiet hours (§12); digest class waits for the next
  brief; inbox class delivers immediately within waking hours.
- iMessage remains the only outbound channel in v1. The delivery abstraction goes
  no further than the existing notifications queue.

## 12. Salience / cooldown / quiet-hours rules (deterministic v1)

No ML ranker. `attention/salience.ts` — pure, table-tested:

1. **Level comes from owner-declared policy** (watch `attention_policy.level`, or
   outcome-producer defaults). Not inferred. A watch policy of `silent` never
   produces an item at all (§4) — items exist only at inbox/digest/interrupt.
2. **Safety class forces interrupt:** items with `safety_class ∈
   {security,water,safety}` (home watches; explicit predicate fields only) →
   `interrupt` regardless of default, **and bypass quiet hours** (a leak at 2am
   wakes the owner; quiet hours must never delete urgency — reviewer attack
   anticipated and closed).
3. **Quiet hours** 22:00–07:00 PT (reuses reminders' constants/tz): inbox/digest
   items stay open and render in Today; delivery defers to the first
   `attention-liveness` tick after quiet hours end (07:00 PT) and/or the morning
   brief. Deferred ≠ dropped.
4. **Cooldown** per item: default 60 min (configurable per watch); suppresses
   re-delivery, not bumps. Safety-class items are exempt (a worsening
   security/water/safety condition re-delivers immediately — safety beats
   every suppression gate, the same rationale as §12.2's quiet-hours bypass
   and §12.7's snooze re-open; the §12.5 fingerprint rule still applies, so
   an unchanged occurrence never re-delivers).
5. **Meaningful-change rule (owner amendment 5):** re-delivery on bump only if
   the producer-supplied `change_fingerprint` (underlying occurrence identity —
   §5) differs from the stored one, or the level rose; otherwise occurrences++
   silently ("no notification if nothing actionable changed"). Rendered-text
   similarity is explicitly *not* the signal: a second genuinely different Plaid
   reply that renders the identical summary still re-delivers, because its
   messageId differs; ten replays of the same event do not.
6. **Repetition suppression:** repeated-failure producers (watch eval errors,
   delivery failures ≥3 consecutive) collapse to one `system.*` item with
   occurrences — no error spam.
7. **Snooze respect:** no delivery while `snoozed_until` is future, except
   safety-class interrupts (a snoozed leak alert that worsens re-opens).
8. **Fail-open:** every suppression gate (quiet/cooldown/fingerprint) fails toward
   delivering; the durable item bounds the worst case at one duplicate push.

## 13. Minimal Today / Watches / Missions UI

Smallest implementation consistent with the repo: **server-rendered HTML served by
the existing Fastify API** (no SPA, no build toolchain, no frontend dependency) —
reviving the sanctioned CR1 read-out shape, extended with direct controls. New
routes under `apps/api/src/routes/ui.ts` + `apps/api/src/routes/attention.ts` /
`watches.ts` (JSON, same auth):

**Remote-access decision (owner amendment 2, made before implementation):** the
app stays a **private app exposed over the tailnet via Tailscale Serve**, never a
public internet app. Concretely: the API keeps binding `127.0.0.1:3000` only;
`tailscale serve` proxies tailnet HTTPS → loopback, so TLS, reachability, and
device-scoped access are the tailnet's job and the app itself never binds a
public interface. The owner reaches Today from the phone (Tailscale app) or any
logged-in device — an iMessage saying "Review in Today" deep-links to the
tailnet URL and is *actually usable away from the Mac*, which a localhost-only
surface never could be (the interface edge would have failed again).
Consequences carried into §14: session cookie `Secure` (HTTPS via tailnet) +
`HttpOnly` + `SameSite=Strict`; CSRF tokens on every state-changing POST (the
surface is now network-reachable, not loopback-only); no public DNS, no public
certificates, no new auth provider — device membership in the tailnet is the
network gate, the principal bearer/session remains the identity gate.

- **Auth:** existing principal bearer credential; one-time paste → session cookie
  (`Secure` + `HttpOnly` + `SameSite=Strict`, tailnet-served HTTPS). Every query
  principal-scoped.
- **Today (primary):** "Needs you" = open items sorted
  (safety_class → level → actionability(has actions) → age); item shows title,
  why-it-matters, age, occurrences, evidence link (gmail message / outcome /
  entity), [Snooze 1h] [Dismiss] [Resolve] [Open evidence] — buttons rendered
  from the §5 action registry, never from row-stored endpoints; "Quietly
  watching" strip = active watches (title, since, last match); "Snoozed" section.
- **Watches:** list by status buckets (active/triggered/paused/completed/
  cancelled/failed — UI projections of watch state: "triggered" = has
  `last_match_at`, "completed" = `satisfied`; no such DB statuses, §4);
  **structured create form** (source type, typed predicate fields, notify level,
  completeOnMatch, expiry) — the primary v1 creation path; pause/stop/edit
  (stop = `cancelled`; its confirm copy states that the watch's open items
  close with it, §5.3 — never a surprise).
  Natural-language drafting is **not** in v1 (deferred until the slice proves
  out; then as draft→owner-confirm per §5 of the brief).
- **Missions:** read-only projection of outcomes (status, done-means criteria
  checklist, result link) reusing the briefs' outcome queries. No second task
  source of truth.
- **Home (W5):** read-only entity list + home watches. No analytics, no activity
  firehose, no model debug panels in this UI.

**Not built:** chat-first homepage, activity feed, dashboard sprawl, memory graph,
settings universe (§23).

## 14. Security / principal isolation

- Every table and query principal-scoped (`WHERE principal_id = $1` house
  discipline); watch/attention services take `principalId` explicitly, deny/empty
  fail-closed.
- Creation authority: owner via authenticated UI/API/`josctl watch` only. Model
  output can never mint a Watch (v1 has no NL path at all; the later drafting
  surface outputs a **WatchSpec proposal** validated by the fail-closed
  predicate parser and activated only by owner confirm — the outcome_spec
  consent-class pattern).
- Workflow principals `system:watch-evaluator`, `system:attention-sweeper`,
  `system:home-edge` mint short-lived grants exactly as `system:gmail-sync` does;
  every state change of consequence flows through events + audit (ids only).
- Gmail content: cannot create watches, mutate state, or trigger side effects
  (ADR-0016 §2.6 extended verbatim to watch evaluation and semantic
  classification). Evidence refs are validated against the actual candidate set —
  fabricated references are stripped and the match fails closed.
- Home: risk tiers (§9) with monotonic-upgrade invariant; consequential actions
  behind action_intents + confirm tokens + consent classes; no secrets through
  model context; HA token in Keychain.
- UI: app binds loopback only; **Tailscale Serve fronts it on the tailnet**
  (§13) — no public interface, no public DNS/certs; session cookie `Secure` +
  `HttpOnly` + `SameSite=Strict`; **CSRF tokens on every state-changing POST**
  (the surface is network-reachable via the tailnet); no cross-principal surface;
  actions resolve through the §5 registry to producer-owned authorized routes —
  no row-stored endpoints exist to forge. **Output encoding is a hard rule:**
  every string rendered into Today/Watches/Missions/Home HTML that derives from
  external content (gmail `fromDomain`/subject, HA entity names) passes a single
  escape-at-boundary helper — no raw HTML interpolation anywhere; CSP
  `default-src 'none'`. (Gmail content is untrusted input to a server-rendered
  page, not just to the model.)
- Egress: semantic-watch model calls (W7 only) go through `egressGatedModelProvider`
  (untrusted_external content class) and the `model_calls` budget ledger.

## 15. Semantic-Watch model boundary (W7 — post-dogfood only)

**Activation gate (owner amendment 6):** semantic watches land only after the
deterministic Watch product has proven useful in dogfood. Gmail
sender/thread/subject matching + Outcome transitions answer the product question
first; W1–W6 contain zero model calls, which strengthens the works-without-AI
thesis. This section is the boundary design W7 implements — nothing here is
built in the first E2E slice.

Semantic watches ("tell me when Plaid sends something that materially changes the
security review") are a **classification/read problem — never authority**:

1. Deterministic narrowing first (`narrowing` fields: fromDomain/thread/terms) —
   the model sees only pre-narrowed candidates.
2. Bounded candidate payload: subject + snippet (≤600 chars, the existing
   normalized snippet), rendered inside the house DATA BOUNDARY block format
   (conversation.ts precedent) with injection flattening.
3. One structured-output classification call: `{matched: bool, confidence:
   0..1, reason: ≤140 chars}` — strict parser, fail-closed to `matched:false`
   on any parse deviation (parseRouteJson discipline).
4. **Deterministic threshold decides** (`threshold` from the predicate × policy
   confidence floor). The model output is data recorded on the match evidence.
5. Model **cannot**: mutate source state, create side effects, invent evidence
   (refs validated against the candidate set), change watch status, or expand its
   own scope. The evaluator calls only `openOrBumpOrReopen`.
6. Budgets: per-watch daily classification cap (default 20/day), per-principal
   monthly ceiling via `model_calls` ledger, hard timeout; cap exhaustion pauses
   the watch with `eval_error_budget` (GAIA pause-with-reason) and opens one
   `system.*` attention item.
7. Audit: every classification logged with watch id, message id, confidence,
   threshold, decision — replayable.

## 16. Migrations (all with tested down paths, applied via
`tsx packages/db/src/migrate.ts up`; note `pnpm migrate` script does not exist
today — W1 adds it, fixing the stale AGENTS.md row)

| # | File | Contents | Down path |
| --- | --- | --- | --- |
| 025 | `025_watches.sql` | watches table + indexes (reserved number honored; W0-proven draft, committed and applied in **W1** before 029/030 — see below) | drop table (owner exports via `josctl watch export` first) |
| 029 | `029_attention_items.sql` | attention_items + indexes | drop table (items are re-derivable from sources except snooze/dismiss state — acceptable, documented) |
| 030 | `030_attention_kind.sql` | notifications `kind += 'attention'`, `source_type += 'attention'` (drop/recreate CHECK precedent 009) | restore prior CHECK vocabularies |
| 031 | `031_home_entities.sql` (W5) | normalized entity cache + tiers | drop |
| 032 | `032_home_action_kinds.sql` (W6) | action/consent vocabulary if needed | drop |

Event-catalog additions are code (`EVENT_CATALOG_V1`, additive-only), not
migrations, each wave-assigned: `attention.item.opened|resolved` in **W1**
(open and reopen ride `opened`, resolve and dismiss ride `resolved`, payload
discriminates — ids/counts only; item open/reopen/resolve/dismiss are state
changes of consequence under the house event-log rule, emitted from
`attention/service.ts`, while bump/seen/snooze update an already-open row and
stay table-only — a labeled scoping decision, so 10 duplicate source events
never mean 10 attention events; they do mean 10 `watch.triggered` match
records, one per distinct source row — §6 — which is the append-only log's
job, not event spam), `watch.*` in **W2**, `home.entity.state_changed` in **W5**;
migration numbers are assigned only when a migration file actually lands (the
W6 row may therefore go unused).

**Migration 025 is proven empirically before any W1 code (owner amendment 9).**
The reserved number lands *after* 026–028 have already been applied on the live
DB; the plan asserts the runner handles this, and the assertion is tested, not
assumed. W0 executes: (1) `pg_dump`/restore a scratch DB from the live database
(at migration state 028, schema only); (2) draft `025_watches.sql`; (3) apply it
to the scratch copy — assert clean apply + clean down; (4) fresh-database apply
of the full lexical sequence 000…028 with 025 in its lexical position — assert
clean apply (no dependency of 026–028 on absence/presence of `watches`).
Step 3 also exercises the checksum guard for real: after the clean apply,
tamper with the applied SQL (append a comment), re-run `migrate up`, and
assert the hard mismatch error (`migrate.ts` throws on a changed checksum);
restore, then assert the clean down. The W0 run records the proven draft's
sha256 in ADR-0018, and the `025_watches.sql` committed in W1 must hash
identically — asserted by W1's migration round-trip test before the first
live `pnpm migrate` — so the proven SQL and the applied SQL are the same
bytes (the per-DB checksum freeze only begins when the live DB applies 025;
the recorded hash binds the gap between proof and commit). Only after this
passes does W1 begin; once 025 touches the real DB its SQL is frozen.

**When 025 actually lands (consequence of the amendment-1 wave reorder):** the
proven draft is committed with W1 and applied in W1's first migration run. The
runner applies pending migrations in lexical order (`migrate.ts`
`listMigrations` sorts; `migrateUp` skips applied names), so the pending set
{025, 029, 030} applies as 028 → **025** → 029 → 030: 025 hits the live DB at
state 028 — *exactly* the path step 3 proved — and every later fresh-DB build
is plain lexical order. The watches table then sits empty, untouched by any
W1 code path, until W2. Holding 025 for W2 instead would apply it at live
state 030 — a path the W0 proof cannot exercise (029/030 do not exist at W0)
— and would make §20's documented rollback order no longer the reverse of
application order. W2 therefore lands no migration, only watch code over the
already-applied table.

ADR-0018 (Watch & Attention semantics) and ADR-0019 (private tailnet web
read-out + direct controls, per §13's remote-access decision) land with
ratification, before W1 code.

## 17. Background workflows (registered in `apps/worker/src/workflows.ts`)

| Workflow | Cron | Does | Pattern reused |
| --- | --- | --- | --- |
| `watch-scan` | `* * * * *` | event-mode predicate eval, watermark-driven window (15m floor; extends to stale watermarks after host sleep, 24h cap; cap truncation surfaces as a `system.scan_gap` item), match records, attention writes | `outcome-resume-scanner` |
| `watch-tick` | `*/5 * * * *` | scheduled-mode eval (duration/absence), pending-evidence retries (§7.2), eval_state carry, next_evaluation_at | reminders sweep |
| `watch-reaper` | `23 * * * *` (offset) | expiry (30d default + explicit), stale watches, budget-pause upkeep, `content_lane_disabled` pauses when the gmail content lane is off | `outcome-reaper` |
| `attention-liveness` | `*/5 * * * *` | resolver backstop, wake-sweep for quiet-hours-deferred deliveries (first tick after 07:00 PT local — house `localHour` guard pattern; **no UTC-pinned daily crons anywhere** — pass-1 review fix, §27), terminal-row GC (30d) | Istota liveness pass |
| `home-edge` (W5) | persistent process + watchdog cron | **`apps/home-edge` long-running launchd process** (§9) holds the WS subscription → normalized events; reconnect backoff in-process; the Inngest `home-edge-watchdog` cron only detects missed heartbeats and surfaces one `system.*` item | edge-agent process shape |

All start with a `policy.yaml` kill-switch check (`watches.enabled`,
`attention.enabled`, `home.enabled`) exactly like the gmail sensor gate. The
outcome producer needs **no workflow** (in-service hook).

## 18. Testing strategy

- **Pure units (hermetic vitest):** predicate validator/matcher table tests
  (every predicate type × valid/invalid/canonicalized/malicious unknown fields);
  three-branch attention write semantics; resolver truth table (live/gone/
  unknown); salience ladder truth table incl. quiet-hours-bypass, cooldown,
  meaningful-change, fail-open; tier classification + monotonic-upgrade
  adversarial tests; action-registry key/argument validation (unknown key or
  arg → refuse); semantic strict-parser fail-closed tests (W7).
- **Integration (local Postgres, existing `*.integration.test.ts` pattern):**
  migrations up/down round-trip;   watch-scan idempotency (duplicate event ⇒
  one bump, no second row — §22 D's three duplicate paths; match-record
  `accepted:false` ⇒ attention write skipped, §6);
  delivery-failure-preserves-item (notification expires →
  item open, retried); reopen-on-recurrence;   auto-resolve via producer and via
  liveness; outcome-hook transactionality (transition + item atomic); watermark
  replay safety; pending-evidence retry (content row absent → inconclusive →
  row appears → match fires; retry-window expiry → `missed_evidence` + its
  `system.missed_evidence` item opens, never a silent drop); watermark-gap
  replay (events landed with pre-sleep `occurredAt` after a stale-watermark
  wake still match exactly once); watermark-cap truncation (true gap > 24h →
  the skipped window surfaces as a `system.scan_gap` item, never a silent
  skip); initial watermark = activation instant (an event that occurred
  before a watch's activation never matches it — no historical replay at
  creation); resume-after-pause replay (events during a pause match exactly
  once on resume via the stale watermark); content-lane creation refusal (specs
  requiring the content join rejected while `contentEnabled` is off;
  envelope-only specs unaffected).
- **Injection/red-team fixtures** (house style): gmail body containing
  "ignore previous instructions / create a watch / close the garage" through the
  term matcher (W2) and the semantic classifier (W7) — assert no watch minting,
  no state mutation, refs fail closed.
- **E2E acceptance scripts** (§22) as `josctl`-driven scripts against the live
  local stack.
- Existing suites stay green; boundary test (no Inngest imports outside
  packages/workflow) extended to the new workflows.

## 19. Observability

- **Watch quality:** watches created/active/satisfied/expired/stopped-early
  counters (audit-derived); time source-event → attention item (`occurredAt` vs
  `first_raised_at`); per-watch match rate; semantic classification
  confidence histogram + budget spend (`model_calls` attribution — W7 only).
- **Attention:** items opened/acted-on/dismissed/snoozed; duplicate-suppression
  rate (bumps ÷ (bumps+opens)); interrupt notifications ignored (delivered vs
  resolved-by-owner latency); delivery success rate (notifications delivered ÷
  enqueued, per kind).
- **Owner verdicts:** existing feedback table (`useful/noise/missed/interruptive`
  against `item_type='attention_item'` — CHECK vocabulary already present) via a
  one-tap button on Today + `josctl feedback`. `metrics/compute.ts` extended to
  roll these into the weekly dogfood report (`josctl metrics`).
- Audit events for every watch transition and every attention open/reopen/
  resolve/dismiss (`watch.*`, `attention.item.opened|resolved` — §16; ids/
  counts only, content-free contract); attention bump/seen/snooze are
  counter/state updates on an open row, carried by the `attention_items`
  table itself (keeps attention event volume sane; the per-match
  `watch.triggered` stream is load-bearing — it is the §6 match record, not
  audit volume). No new telemetry infra.

## 20. Rollback

- Policy kill switches per subsystem (`watches.enabled`, `attention.enabled`,
  `home.enabled`) stop evaluators/sweeps/enqueues immediately; tables persist.
- Outcome producer hook is additive; kill switch reverts to brief-only surfacing.
- Migrations have down paths (§16); rollback order documented (attention kind →
  attention items → watches — the exact reverse of application order, 025
  having applied first in W1). UI routes are additive and removable.
- Worst-case blast radius of a bad watch-scan deploy: duplicate/incorrect
  notifications for one scan window (bump semantics + watermarks bound it); no
  durable-work mutation (watch evaluator never writes outcomes/assignments).
- Notifications kind widening is CHECK-only, additive.

## 21. Phased build sequence

Wave order follows the owner's sequencing amendment (1): prove the **Attention
product** on existing Outcomes before building any Watch substrate, then add
deterministic Gmail Watches, and only then the rest. Each dogfood gate is a
go/no-go on continuing.

```
Attention + existing Outcomes + Today   (W1)  → DOGFOOD #1 (≈2.5–3.5 d)
        ↓
Gmail deterministic Watch kernel        (W2)
        ↓
Watch → Attention E2E + iMessage        (W3)  → DOGFOOD #2
        ↓
Minimal product UI (Watches/Missions)   (W4)
        ↓
Home Assistant edge                     (W5)
        ↓
Home actions                            (W6)
        ↓
Semantic watches (model-assisted)       (W7, only after dogfood verdict)
```

### W0 — evidence/architecture mapping *(complete: this plan + review)*
Exit: plan ratified by owner; ADR-0018/0019 drafted; **migration-025
late-landing scenario executed empirically on a scratch copy of live schema
state (§16 — including the checksum-guard tamper assertion; the proven
draft's sha256 recorded in ADR-0018) — pass required before W1 code**.

### W1 — Attention kernel + Outcome producer + minimal Today (first dogfood)
- **Files:** `packages/db/migrations/025_watches.sql`(+down — the W0-proven
  draft, committed and applied here per §16; table unused until W2);
  `029_attention_items.sql`(+down), `030_attention_kind.sql`(+down);
  `packages/core/src/attention/{service,salience,
  resolvers,actions-registry,types}.ts` + events catalog additions
  `attention.item.opened|resolved` emitted from `attention/service.ts` (§16);
  outcome producer hook in `outcomes/service.ts` (`emitOutcomeAttention`,
  +tests); notifications
  config/policy widening; `apps/api/src/routes/attention.ts` (JSON:
  list/snooze/dismiss/resolve/seen); minimal **Today** server-rendered page
  (`apps/api/src/routes/ui.ts`: open items + evidence links + [Snooze]/
  [Dismiss]/[Resolve] + one-tap verdict); notification rendering for
  kind=attention in edge-agent; Tailscale Serve setup (infra docs/script);
  root `package.json` `migrate` script; ADR-0018/0019 committed.
- **Tables/types:** `attention_items` (029); `NotificationKind += 'attention'`
  + auto-approve vocabulary widening (030 + `notifications/config.ts`);
  `watches` (025) applied but unused — W2 code is its first consumer.
- **Reused:** notifications queue, edge-agent loop, reminders quiet-hours
  constants, review_refs snooze semantics, briefs' outcome queries (evidence
  links), escalations delivery-gate pattern.
- **Worker/job changes:** `packages/workflow/src/attention-workflows.ts`
  (`attention-liveness`, cron `*/5` — resolver backstop, quiet-hours wake,
  terminal-row GC) + worker registration + policy `attention:` kill-switch.
- **UI changes:** minimal Today page (server-rendered, tailnet-served per §13).
- **Tests:** three-branch/liveness/salience/action-registry units + integration;
  outcome-hook transactionality (transition + item atomic); migration
  round-trip incl. committed-025 sha256 == the ADR-0018-recorded W0 draft
  hash (§16 — asserted before the first live `pnpm migrate`); §22 scenario B
  as a live script.
- **Migration/down:** 025/029/030 (025 down drops a provably empty table;
  029/030 downs restore prior CHECK vocabularies).
- **Security risks:** attention routes principal-scoped fail-closed;
  resolve/snooze/dismiss authority is the owner only; kind widening purely
  additive (attention never rides the reply conjunction); Today output
  encoding + CSRF + session-cookie flags (§13/§14) from day one.
- **Rollback:** kill switch + downs; outcome hook additive.
- **Exit criteria:** §22 scenario B passes end-to-end (delegate → ready →
  Today + iMessage → owner resolves → producer/lifecycle closes items);
  duplicate producer events collapse; failed delivery leaves item intact;
  owner checks Today daily. **DOGFOOD #1 STARTS — "research finished /
  blocked / needs judgment appears in Today" is useful with zero Watch code.**

### W2 — Watch kernel (deterministic only)
- **Files:** `packages/core/src/watches/{service,predicates,evaluator,types}.ts`
  (first consumer of the 025 table applied in W1 — §16);
  `packages/workflow/src/watch-workflows.ts` (scan/tick/reaper; the scan
  emits the §6 match-record `watch.triggered` events through `acceptEvent`);
  worker registration; events catalog additions; `josctl watch` CLI
  (list/create/pause/stop/export); policy `watches:` section.
- **Tables/types:** no new migration (`watches` = 025, applied in W1);
  predicate vocabulary v1.1 **deterministic
  types only** (`arrival`, `content_match`, `absence_past`, `outcome_state`;
  `duration` present-but-refused until W5; `semantic_relevance`
  present-but-refused until W7); watch event catalog additions.
- **Reused:** outcomes predicates vocabulary + validator, resume-scanner
  pattern, gmail content readers.
- **Worker/job changes:** `watch-scan`/`watch-tick`/`watch-reaper` registered
  (§17); gmail sync worker untouched.
- **UI changes:** `josctl watch` CLI only (structured web form is W4).
- **Tests:** predicate tables; scan idempotency + watermark-gap replay +
  initial-watermark (activation instant — pre-activation events never match,
  §6) + resume-after-pause replay; watch stop (`cancelled`) closes the
  watch's outstanding match and system items while **no** terminal transition
  does — `satisfied`, `expired`, and `failed` each leave open match and system
  items awaiting owner ack (§5.3's amended clause asserted in full);
  content-lane creation refusal; pending-evidence/`missed_evidence`-item
  integration.
- **Migration/down:** none new; 025 down remains available per §16 (owner
  exports via `josctl watch export` first once rows exist).
- **Security risks:** predicate parser fail-closed (unknown fields rejected,
  never coerced); watch-scan writes only watches/attention rows — never
  outcomes/assignments; creation authority owner-only (CLI).
- **Rollback:** kill switch; 025 down.
- **Exit criteria:** a gmail arrival watch created via CLI evaluates real sync
  events, records evidence, opens exactly one item, satisfies on
  completeOnMatch — with the match item staying open for owner ack (§5.3) —
  and stopping a watch closes its outstanding items; content-dependent legs
  behave per §7.2 (inconclusive → retry → visible `missed_evidence`, never a
  silent drop). **No model calls exist in the entire product at this point.**

### W3 — E2E Gmail watch + iMessage (second dogfood)
- **Files:** briefs "Attention" section; watch→iMessage delivery exercised
  end-to-end; **minimal server-rendered gmail-message evidence view** backing
  the §5 registry action `gmail.openMessage` (principal-scoped `gmail_messages`
  read inside the 7-day retention window, §14 output encoding — verified: no
  gmail route exists under `apps/api/src/routes/` today and no other wave
  lists one, yet §22 A's exit criterion asserts a "working evidence link");
  `josctl watch` polish (ref display, evidence inspection).
- **Tables/types:** none.
- **Reused:** briefs section machinery, edge-agent claim/render loop, iMessage
  delivery.
- **Worker/job changes:** none new — quiet-hours wake rides
  `attention-liveness` (§17).
- **UI changes:** Today gains the "Quietly watching" strip (active watches).
- **Tests:** §22 scenarios A and D as live scripts.
- **Migration/down:** none this wave.
- **Security risks:** none new (W2 surfaces already hardened).
- **Rollback:** kill switches.
- **Exit criteria:** §22 scenarios A and D pass on the live local stack.
  **DOGFOOD #2 — watches are in daily use.**

### W4 — Minimal product UI
- **Files:** Watches management UI (list/create-form/pause/stop); Missions
  read-only projection; Today polish (why-it-matters, occurrences, evidence
  deep-links); `josctl` parity checks; small reviewed **recipes** (GAIA
  pattern: "important-reply watch", "delegated work blocked/ready") offered as
  one-click creates, never auto-activated.
- **Tables/types:** none (recipes are canned validated WatchSpec rows, not
  schema).
- **Reused:** attention/watches route services; briefs outcome queries.
- **Worker/job changes:** none.
- **UI changes:** Watches create/edit/pause/stop; Missions read-only view;
  Today polish.
- **Tests:** server-side form-validation adversarial units (every predicate
  field); recipe idempotency.
- **Migration/down:** none.
- **Security risks:** server-side validation is the gate (the form is
  convenience only); recipes render as proposals requiring explicit owner
  activation — never auto-created.
- **Rollback:** routes additive, removable.
- **Exit criteria:** owner creates/pauses/stops watches purely through UI;
  Missions view answers "what's delegated and where is it"; no chat anywhere.

### W5 — Home Assistant edge
- **Files:** `packages/adapters/src/source-adapters/homeassistant.ts` + port;
  `apps/home-edge` persistent launchd process (§9); `031_home_entities.sql`;
  `home.entity.state_changed` events; duration/absence predicates wired in
  watch-tick; read-only Home view; tier classifier with monotonic-upgrade
  tests.
- **Tables/types:** `home_entities` normalized cache + tiers (031);
  `home.entity.state_changed` catalog entry; `duration` predicate activated.
- **Reused:** edge-agent long-running-process shape; watch-tick machinery.
- **Worker/job changes:** `home-edge-watchdog` cron (heartbeat detection
  only — the WS connection lives in the process, not the workflow).
- **UI changes:** read-only Home view (entity list + home watches).
- **Tests:** tier monotonic-upgrade adversarial suite ("config may never
  downgrade a lock"); duration `eval_state` carry; flap-within-cooldown bumps
  once (scenario C); watchdog surfaces a `system.*` item when the edge process
  dies.
- **Migration/down:** 031 down.
- **Security risks:** HA token Keychain-only (GMAIL_ACCESS_TOKEN discipline);
  unknown domains default-deny invisible; events content-free (ids/state
  only); WS reconnect must not silently drop tier state (re-merge through the
  monotonic gate).
- **Rollback:** `home.enabled` kill switch; 031 down.
- **Exit criteria:** §22 scenario C passes (garage-open-20m → one interrupt
  item, bypasses quiet hours, auto-resolves on state change); entity tiering
  adversarially tested (config cannot downgrade a lock; scene/script invisible).

### W6 — Home actions
- **Files:** `HomeAssistantPort.callService`; action_intents/confirm-token lane
  reuse; comfort-tier actions from Home view; security-tier behind confirm
  tokens; consent-class registration.
- **Tables/types:** action/consent vocabulary if needed (032).
- **Reused:** ADR-0011 `action_intents → action_attempts`; confirm-token lane;
  notification confirm.
- **Worker/job changes:** none new (attempts ride existing lanes).
- **UI changes:** action buttons on Home view + attention items (registry
  actions, §5).
- **Tests:** close-garage E2E (scenario C W6 leg); security action refuses
  without confirm token; batch partial-failure honesty.
- **Migration/down:** 032 down (if used).
- **Security risks:** monotonic tier gate re-run at action time; first-use-
  per-entity notification confirm; every attempt audited; no model anywhere
  in the action path.
- **Rollback:** policy disable of home actions; routes additive.
- **Exit criteria:** close-garage from an attention item's action button, full
  intent→attempt→audit trail; security action refuses without confirm token;
  monotonic-tier invariant test suite green.

### W7 — Semantic watches (post-dogfood enhancement, owner amendment 6)
- **Gate:** builds only after the dogfood verdict on W1–W6 is "this helps".
  If the deterministic product already meets the §24 bar, W7 waits until a
  real fuzzy-relevance need shows up in dogfood notes.
- **Files:** `semantic_relevance` predicate activation in
  `watches/predicates.ts`; classification step in watch-scan (§15);
  egress-gated model call; budget caps + `eval_error_budget` pause path.
- **Tables/types:** none (predicate vocabulary already carries the type,
  refused until this wave).
- **Reused:** egress registry, `model_calls` ledger, DATA BOUNDARY block
  formatting, parseRouteJson strict-parser discipline.
- **Worker/job changes:** none new (classification runs inside watch-scan).
- **UI changes:** semantic fields on the watch create form (W4 form extended).
- **Tests:** §15 boundary suite — strict-parser fail-closed, evidence-ref
  validation against candidate set, injection red-team fixtures,
  budget-cap pause, provenance audit.
- **Migration/down:** none.
- **Security risks:** the §15 boundary in full — classification is data,
  never authority; no side-effect surface in the path.
- **Rollback:** policy disable of semantic predicate type.
- **Exit criteria:** a semantic watch classifies with audited provenance and
  hard authority boundaries; false-positive rate judged acceptable in
  dogfood verdicts.

*(Nothing beyond W7 is planned in implementation detail.)*

## 22. E2E acceptance scripts

- **A — Gmail watch (disposable, W3):** create watch `fromDomain=plaid.com,
  threadRef=<security review thread>, completeOnMatch=true, level=inbox` →
  send/await real reply → assert: exactly one attention row (fingerprint
  `watch:<id>:match`), evidence refs contain eventId+messageId, watch
  `satisfied`, item visible in Today with working evidence link; notification
  delivered.   **Delivery-failure survival leg (brief §11 scenario A):** create
  a twin watch — same predicate, `completeOnMatch=false`, so it stays active
  to receive the second match (the original, now `satisfied`, is no longer
  evaluated, §4 — not because satisfaction would close the item: per §5.3
  match items persist through satisfaction, so a failed push cannot erase a
  disposable watch's news either) — then kill edge-agent and drive a second
  matching message → the twin's item opens
  and persists while the notification goes undelivered and its TTL lapses
  (default 240m, shortened via the `notifications:` policy section for the
  script's timescale; item untouched — §5.2); restart edge-agent → the §11
  liveness re-enqueue delivers the same open item exactly once (no second
  row, occurrences unchanged, no duplicate push). Finally, on the satisfied
  original watch, drive a third matching message → no new row and no
  re-delivery for `watch:<id>:match` (a satisfied watch is no longer
  evaluated; its occurrences stays 1 — the twin's bump is its own row, not a
  duplicate); no zombie delivery. Then the owner resolves the still-open
  match item in Today → `resolved_by='owner'`, watch row untouched —
  satisfaction and item resolution are independent lifecycles (§5.3), so the
  brief's "resolves/completes per policy" is demonstrated on both objects.
- **B — Delegated result (W1):** run existing delegate flow to `waiting_user` →
  assert item `outcome:<ref>:ready` opens in-transaction, Today shows "ready",
  iMessage delivers per policy; owner resolves via Today → item resolved,
  outcome untouched except through owner decision path; outcome cancelled →
  item auto-resolves (producer close), then reopen test on recurrence; outcome
  completed → **no attention item anywhere** (brief "resolved" section only).
- **C — Home watch (post-W5):** `duration` watch on garage cover
  `state=open ≥ 20m`, `safety_class=security` → simulate state_changed → after
  20m exactly one interrupt item bypassing quiet hours; [Close] (W6) or HA state
  change → item auto-resolves; duplicate state_changed flapping within cooldown
  bumps once.
- **D — Anti-spam regression (W3):** three distinct duplicate paths asserted:
   (i) the same event row re-scanned (overlapping window / watermark retry)
   matches exactly once — occurrences unchanged, no re-delivery (match-record
   idempotency, §6); (ii) 10 duplicate event rows for the same underlying
   occurrence, injected as a direct events-store fixture (gmail production
   cannot produce these — `acceptEvent` dedupes by externalId
   `gmail:<messageId>`; the case guards sources without that guarantee, e.g.
   HA reconnect replays, W5) → one row, occurrences=10, ≤1 delivery (same
   `change_fingerprint`, keyed to the messageId per §5); (iii) a **second
   genuinely new** Plaid reply with an identical rendered summary → bump
   **and** re-delivery (different `change_fingerprint` — owner amendment 5
   asserted, subject to the §12.4 cooldown for non-safety items);
   quiet-hours deferral wakes at the first `attention-liveness` tick after
   07:00 PT; liveness resolves orphaned items after underlying objects
   disappear.

## 23. Explicit deletions / non-goals (frozen)

No: conversational-cognition R&D, holdouts v6+, model bakeoffs,
CognitiveEnvelope work, Memory Graph, Finance Edge, generic automation DSL,
Control Room, browser automation, work-edge integration, self-modifying agent,
generalized salience LLM, generalized entity ontology, dozens of integrations,
chat-first homepage, activity firehose, analytics dashboards, model debug panels
in product UI, second mission/task store, NL watch drafting before the E2E slice
proves itself, **semantic/model-assisted watches before the deterministic Watch
product proves useful in dogfood (W7 gate)**, vendor-specific smart-home
adapters where HA normalizes, LLM polling of home state, PINs or secrets through
model context, public-internet exposure of the web UI (tailnet-private only).
This is not a platform rewrite: all durable-work, event, grant, notification,
and brief machinery is reused as-is.

## 24. Two-week dogfood protocol (starts at W1, expands at W3)

- **Days 1–N (from W1):** owner lives on Today + iMessage interrupts for
  Outcome-produced attention ("research ready / blocked / failed appears in
  Today"); every acted-on/dismissed item gets a one-tap verdict
  (useful / noise / missed / interruptive).
- **From W3:** watch-triggered attention joins the dogfood; watch-quality
  metrics join the weekly review.
- Weekly `josctl metrics` review: interventions count, verdict mix,
  duplicate-suppression rate, watch trigger quality (true-useful vs annoying),
  source-event→item latency, item→resolution latency, snooze/dismiss patterns.
- Week 1 baseline; week 2 tuning (cooldowns, levels, quiet hours, watch wording)
  via policy/config only — no new infrastructure in response to shortfalls.
- **Product bar:** ≥3–5 genuinely useful interventions/week the owner would
  otherwise have had to remember/check/do. If not met: adjust usage or stop —
  explicitly *not* "build more infrastructure".

## 25. Rough effort estimate

| Wave | Effort | Cumulative to dogfood-relevant exit |
| --- | --- | --- |
| W0 | done (plan + review + 025 empirical proof ≈0.5 d) | — |
| W1 | 2.5–3.5 d | **DOGFOOD #1 at ≈3–4 working days** (Attention + Outcomes + Today) |
| W2 | 2–3 d | — |
| W3 | 1–1.5 d | **DOGFOOD #2 at ≈6–8 working days** (Gmail watches live) |
| W4 | 2–3 d | ≈ 9–11 d |
| W5 | 2–3 d | ≈ 12–14 d |
| W6 | 1–2 d | ≈ 13–16 d |
| W7 | 1.5–2 d | post-dogfood, gated |

Single-owner sequential estimates including tests + migrations + down paths; W5/W6
assume the existing tito HA instance is reachable.

## 26. Top 5 risks

1. **Always-on-host gap (highest).** Every runtime in this plan (`watch-scan`,
   `home-edge` WS, edge-agent iMessage delivery) runs on the owner's laptop
   against dev Inngest + brew Postgres. A sleeping/closed host silently misses
   gmail watches, drops the HA stream, and withholds interrupts — the exact
   opposite of the product thesis ("tell it once, then stop thinking about it"
    fails if the system itself sleeps). *Mitigation:* the watermark-driven scan
    window replays the missed gap on wake up to the 24h cap; beyond the cap the
    skip surfaces as a visible `system.scan_gap` item, never silences (§6;
    single-effect via idempotent match records) — the mechanical half — plus
    dogfood keep-awake discipline (caffeinate/pmset) and uptime-gap awareness in §24
    metrics (expected-wakes vs delivered-interrupts) — the operational half; the
    systemic fix is the E2 hosting decision, deliberately out of scope for this
    plan.
2. **Owner stops looking at Today** (attention-surface decay). *Mitigation:*
   §24 dogfood bar + one-tap verdict loop; the protocol's response to
   shortfalls is usage adjustment, never more infrastructure.
3. **Semantic-watch false positives erode trust.** *Mitigation:* it is deferred
   behind the W7 dogfood gate (owner amendment 6) — the deterministic product
   must prove itself first; then conservative default confidence threshold,
   per-watch daily caps + `model_calls` ceiling, verdict feedback (`noise`),
   per-watch kill via pause/stop.
4. **watch-scan/watermark regressions drop or duplicate matches.**
   *Mitigation:* idempotent match records, watermark-advance-only-after-success,
   §18 integration suite (idempotency, replay safety, pending-evidence);
   §20 bounds blast radius to one scan window.
5. **iMessage delivery is best-effort on one machine.** *Mitigation:* the
   durable inbox is the record (§11), success-only delivery stamps, and the
   delivery-success metric (§19) surfaces degradation — worst case is a missed
   *push*, never a lost *issue*.

## 27. Independent review findings

Produced by the plan-review loop (drafter/proposer subagents, independent
models) against the owner's §19 attack list, in two passes: **pass 1** (turns
1–8, 14 proposals integrated — including the discovered gmail content-persist
non-atomicity, the watermark-gap hole after host sleep, a shipped-bug UTC cron,
and the Today output-encoding rule) and **pass 2** (post-owner-amendment
verification: all nine owner amendments confirmed integrated; one
cross-amendment consequence resolved — the amendment-1 wave reorder moves
025's live application into W1 so the W0-proven late-apply path remains the
real one, §16; eight further hardening fixes — the W0-proof→W1-commit
sha256 binding with a real checksum-tamper test (§16), occurrence-keyed
`change_fingerprint` reconciling the anti-spam keying across §5/§6/§12/§18/
§22 D, a constructible three-path scenario D, wave-assigned attention audit
events `attention.item.opened|resolved` (W1) closing the §16/§19 event-log
gap, terminal watch `cancelled` making `watch.cancelled` reachable, and the
safety-class cooldown exemption completing §12's suppression-gate ladder). A
final pass-2 round (turn 13) closed the last three gaps: the watch-scan
match-record mechanism is now concrete — each match emits `watch.triggered`
with `externalId watch:<watchId>:<sourceEventRowId>`, `acceptEvent`'s
idempotency dedupe is the match record, atomic with its attention write in
one transaction (§6; no new table, 025 untouched); §22 A now exercises the
failed-push survival leg live (twin watch + edge-agent kill + TTL lapse +
single re-delivery, per the brief's scenario A); and §17's no-UTC-cron rule
is re-attributed to its pass-1 provenance. A closing pass-2 round (turn 15)
resolved the last cross-section contradiction and two spec gaps: **watch
match items are occurrence-news, not held conditions** — §4/§5.3/§7.4/§10/
§13/§22 A now carry one rule (watch satisfaction never closes a match item;
owner `cancelled` closes the watch's outstanding match and system items,
mirroring §22 B's outcome-`cancelled` close; the watch liveness resolver
returns `gone` only for `cancelled`, missing row → `unknown`), which both
makes §22 A leg 1 ("watch `satisfied`, item visible in Today") satisfiable
as written and keeps the brief's §19 "failed push forgets an open issue"
attack defeated for its §6 disposable-watch case (auto-close-on-satisfaction
plus one failed push would erase the news — §11's re-enqueue duty covers
only open items). The
**initial watermark is defined as the activation instant** (service-layer
write on `draft → active`, so the W0-proven 025 SQL is untouched;
pause/resume rides the existing stale-watermark replay — §6, tested §18),
and **W3 owns the minimal gmail-message evidence view** that §22 A's
"working evidence link" and §5's `gmail.openMessage` registry action require
(repo-verified: no gmail route exists under `apps/api/src/routes/` and no
wave listed one). One proposer clause was amended in integration: watch
system items (`missed_evidence`/`scan_gap`) close on owner ack or watch
`cancelled` — not on any terminal status — because auto-closing them on a
later `satisfied`/`expired`/`failed` would silently swallow the very
blindness they exist to surface (§6/§7.2's "resolving it is an owner ack"
contract); **ratified by the proposer (turn 16)** — every terminal path would
swallow the blindness equally (`expired`/`failed` no less than `satisfied`),
and `cancelled` is an owner-confirmed abandonment (§13 confirm copy) whose
close is owner-initiated in effect. Every attack was attempted against the
plan text; the disposition table cites the section carrying each defense:

| §19 attack (prove it) | Disposition | Defeated in |
| --- | --- | --- |
| Watch is secretly just another chatbot | **Fails.** Typed predicates, owner-only creation (UI/API/CLI), no model in the watch lifecycle; NL drafting absent in v1 and deferred to a validated draft→confirm surface | §4, §13, §14, §23 |
| Attention Inbox is just an activity feed | **Fails.** Today renders only open needs-you items + a quiet watching strip; counts/event firehose explicitly banned | §13, §23 |
| Delivery and durable attention incorrectly coupled | **Fails.** Item = truth; delivery = best-effort projection; success-only `last_delivered_at` | §5, §11 |
| A failed push causes the system to forget an open issue | **Fails.** Notification expiry never touches the item; liveness re-delivery duty; match items persist through watch satisfaction (§5.3); tested | §5.2, §5.3, §11, §18, §22 A |
| Watch predicates become an unbounded DSL | **Fails.** Closed typed vocabulary (v1.1), versioned, unknown fields rejected — never coerced | §4 |
| Semantic Watch can fabricate evidence | **Fails.** Evidence refs validated against the actual candidate set; fabricated refs stripped, match fails closed | §7, §14, §15, §18 |
| Semantic evaluation gains mutation authority | **Fails.** Model output is data; evaluator only calls `openOrBumpOrReopen`; no side-effect surface exists in the path | §15.5, §14 |
| Gmail content triggers side effects via injection | **Fails.** Content reaches only deterministic term-match + classification context (ADR-0016 §2.6 extended); red-team fixtures assert no minting/mutation | §7, §14, §18 |
| Watches spam the user | **Fails.** Bump-not-spam dedupe, cooldown, meaningful-change rule, repetition suppression, fail-open gates bounded by one duplicate push | §5.1, §12, §22 D |
| Watches cannot auto-resolve / go stale | **Fails.** Completion/expiry policies + reaper retire the watch itself; items close via owner ack or watch stop (`cancelled`), liveness backstop sweeps the whole open set (`gone` only for cancelled) | §4, §5.3, §10, §17 |
| Multiple source events create duplicate rows | **Fails.** UNIQUE + 3-branch transactional write; §22 A/D assert it | §5.1, §22 |
| Quiet hours / cooldown make urgent alerts disappear | **Fails.** Safety class forces interrupt + bypass; every suppression gate fails open; deferred ≠ dropped (wake sweep + Today render) | §10, §12.2, §12.8, §17, §22 D |
| Outcome state duplicated rather than projected | **Fails.** Producer hook projects at transition; `outcome_state` watch only customizes levels; Missions view reuses brief queries read-only | §8, §13 |
| Smart Home bypasses permission/consent classes | **Fails.** Actions ride `action_intents` + grants + confirm tokens + consent classes; every attempt audited | §9, W6 |
| HA security entities accidentally downgraded | **Fails.** Monotonic tier-upgrade invariant at three independent gates + adversarial tests; unknown domains default-deny invisible | §9, W5 |
| The UI has become a giant dashboard | **Fails.** Four views, server-rendered, no SPA/build toolchain; banned-surface list frozen | §13, §23 |
| Rebuilding finance/chat/work-agent capabilities | **Fails.** Reuse table governs; durable work/event/grant/notification/brief machinery untouched | §2, §23 |
| Too large to get a useful E2E slice quickly | **Fails.** Amendment 1 inverts the order: Attention + existing Outcomes + minimal Today is the whole first slice — ≈3–4 working days to daily dogfood, before any Watch code | §21, §25 |

**Chat-removal test:** §1 answers it — PASS by construction (watches evaluate,
outcomes surface, Today renders, iMessage delivers, items resolve, all with
chat removed; chat is only an optional, deferred drafting surface).

## 28. Recommendation

**BUILD** — contingent on owner ratification of this plan and ADR-0018/0019. The
first useful vertical slice (Attention + existing Outcomes + minimal Today,
tailnet-served) is reachable in ≈3–4 working days with zero Watch code and zero
model calls; deterministic Gmail watches bring dogfood #2 at ≈6–8 days; semantic
watches wait behind a dogfood gate. The plan reuses proven machinery end-to-end,
resumes no frozen lane, and passes the chat-removal test by construction.

