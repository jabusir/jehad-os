# Wave F + T + SV: Feedback Pipeline, Presence, and Self-Verification

Status: proposed 2026-09-22; plan-review complete 2026-09-22 (drafter +
proposer both ready for build); awaiting owner ratification, then Landing
steps below.
Predecessors: docs/plans/w6-phase-2-reminders.md (landed), transcript autopsies 2026-09-21/22
(15:56, 20:56, 00:01–00:14), owner-ratified hybrid SV spec (verbatim in §SV).
Research basis: Reflexion (Shinn et al. 2023), CRITIC (Gou et al. ICLR 2024),
Anthropic "Building Effective Agents" (2024), LangGraph reflection patterns.

## North star: optimize for user experience

The owner experiences only five things. Every lane below serves one of them:

1. **Every reply is either true or silent.** No invented capability, no narrated
   writes, no phantom negatives.
2. **Consent is never a vocabulary quiz.** "Yes" means yes; the system speaks
   protocol, the model speaks human.
3. **The system feels alive.** Presence signals (typing) and honest latency;
   it never dies silently.
4. **Limits speak.** Budgets, outages, and expirations say so out loud, once,
   with a resume time.
5. **It notices its own failures before the owner has to.** Dead letters,
   broken promises, and lying attempts are self-detected, ledgered, and
   distilled into governed lessons.

Standing principle (from the autopsies): the model converses, code speaks
protocol. Self-correction is grounded in verifiers (DB, runtime state), never
in the model grading its own homework.

---

## Wave F — feedback pipeline repair (urgent; lands before Sep 26)

Root cause verified 2026-09-22: workflow notification paths call
`createNotification` WITHOUT the policy config, falling back to
`DEFAULT_NOTIFICATIONS_CONFIG.autoApproveKinds = ["brief"]`. The owner-ratified
`policy.yaml autoApproveKinds` (calibration, grant-reminder, calendar-change)
never governs. Both calibration prompts (Sep 16, Sep 21 20:30 PT) were created
`pending`, unclaimable by the edge (claims only `approved`), and expired.
Evidence: notifications 13c0310e / a6bb444f — `expired`, claimed_at NULL.

- **F1** Shared helper `enqueueWorkflowNotification(db, input)` (packages/core,
  notifications module) that calls the existing `loadNotificationsConfig`
  unchanged and passes its result to `createNotification`, preserving the
  loader's verified semantics (config.ts:84-93): malformed policy.yaml THROWS
  (loud); only a missing file (ENOENT) falls back to
  `DEFAULT_NOTIFICATIONS_CONFIG`. Convert EVERY workflow-created notification:
  calibration-workflows, grant-workflows (grant-expiry-reminder — fires ~Sep 26,
  hard deadline), calendar-change path, and briefs (explicit config instead of
  lucky default).
- **F2** Pins: for each ratified kind, workflow-path creation yields
  `status='approved'`; a seeded approved notification is returned by
  `POST /harness/notifications/claim`.
- **F3** Dead-letter sentinel: any `calibration`/`grant-reminder`/
  `calendar-change` notification that expires without `delivered_at` opens a
  `system_feedback` review item (migration-020 table, currently zero rows) and
  emits a tick-log line in the established convention —
  `console.log(JSON.stringify({ workflow: "dead-letter-sentinel", ... }))`, as
  the calibration workflows already do; no `console-alerts` mechanism exists
  in this repo. Lands with F1 so the sentinel would have caught this on
  Sep 16. Hook point: the sentinel fires at the status→`expired` transition,
  filtered to the ratified kinds — VERIFIED there are THREE expiry writers (the
  housekeeping sweep `expireOverdueNotifications`, service.ts:528, `RETURNING
  id`; the claim-race path inside `markDelivered`, :718-723, which expires an
  already-late approved row inline where the sweep can never match it again;
  and explicit admin `expireNotification`, :750), so implement as ONE shared
  internal expiry helper all three call rather than hooking the sweep alone —
  a sweep-only hook silently misses race-path dead letters (a claim that
  arrived after expires_at is the exact Sep-16 shape). Expired rows persist
  forever, so a re-scanning implementation would re-fire nightly. Pin: a
  seeded expired-undelivered `calibration` row produces exactly one
  `system_feedback` review row and one `dead-letter-sentinel` tick-log line —
  and re-running the sweep produces no duplicates.
- **F4** Deploy + live check: tonight's 20:30 PT calibration prompt must show
  `prompt_sent` → `claimed` → `delivered` in the audit.
- **F5** Acceptance: the two expired rows remain as the golden failure record;
  new runs deliver; grant-reminder verified delivered (or scheduled < Sep 26).

### F0 — verified call-site inventory (repo-grounded 2026-09-22)

Mechanism confirmed at `packages/core/src/notifications/service.ts:374`
(`opts.config ?? DEFAULT_NOTIFICATIONS_CONFIG`). Non-test producers that
reach `createNotification` without a policy-loaded config:

| Call site | Kind | Action |
|---|---|---|
| `packages/core/src/calibration/service.ts:341` (`enqueueCalibrationNotification`) | `calibration` | Convert — this is the nightly path that failed Sep 16/21 |
| `packages/workflow/src/grant-workflows.ts:68` | `grant-reminder` | Convert — Sep 26 deadline path |
| `packages/core/src/calendar/sync.ts:270` | `calendar-change` | Convert — passes `opts.notificationConfig` (a test-only override); production callers leave it undefined → default fallback. Its doc comment claims "policy-file config" — stale; fix alongside |
| briefs via `enqueueBriefNotification` (`service.ts:862`) | `brief` | VERIFIED broken the same way: the hook passes `config: input.config` through (:884) and its production callers (`briefs/service.ts:45`, `:63`) pass no config → default fallback at :374. (Contrast: `enqueueEscalationNotification` :912 is the one producer hook that self-loads — `input.config ?? (await loadNotificationsConfig())` — exactly the pattern F1 generalizes.) Convert via the F1 helper |

Do NOT convert (review-governed by design, not workflow paths):

- `imessage/conversation.ts` reply notifications — kind `reply` is governed by
  `replyDecision`; `autoApproveKinds` never contains `reply` (pinned by
  reply-approval tests). Note (verified): both call sites (:2015, :2208) pass
  opts `{ actor, now }` with no config, so reply TTL rides
  `DEFAULT_NOTIFICATIONS_CONFIG.defaultTtlMinutes` (240), not policy — zero
  delta today (policy.yaml is also 240); revisit only if the owner tunes the
  policy TTL.
- `imessage/review-commands.ts:558` — kind `custom` (:561), genuinely
  review-governed; do not convert. `imessage/pairing.ts:365` — VERIFIED kind
  `brief` (:368), which sits in `autoApproveKinds` under BOTH default and
  ratified policy: the pairing security notice auto-approves and was never
  review-gated. F1 routes it through the helper (no behavior change) and flags
  the kind to the owner — a "revoke this identity" notice that bypasses review
  may deserve a non-auto-approved kind (owner decision; default = keep `brief`).

Resolved nuance (labeled default): `packages/workflow/src/calibration-workflows.ts:223`
(`sendCalibrationNotification`) uses kind `custom` — absent from every
autoApproveKinds list, so loading config alone leaves it pending. Its own doc
comment names a "RECONCILIATION POINT (lane C1)" to swap its body to the
`enqueueCalibrationNotification` hook. VERIFIED caller: exactly one —
`runWeeklyCalibrationTick` (calibration-workflows.ts:330); the nightly path
already routes through the core hook via `openCalibrationItem({ notify: true })`
(:273-277). Default (owner veto = change one line): change its kind to
`calibration` — the weekly rollup becomes auto-approvable under the ratified
policy and visible to the F3 sentinel exactly as scoped in F3. Retiring it
into the core hook converges both calibration paths on the same kind and
identical coverage; the core hook takes an item row while the weekly rollup
has none, so full consolidation stays with the lane-C1 reconciliation its
doc comment already names. Either way the F3 sentinel must cover the weekly
rollup path: expiry is kind-agnostic (`defaultTtlMinutes` stamps every kind,
service.ts:396-398; housekeeping expires pending AND approved, :527-537), so a
pending `custom` rollup dies silently in exactly the Sep-16 shape while
remaining invisible to the sentinel as currently scoped
(calibration/grant-reminder/calendar-change only).

F2 gains a regression pin: no workflow-path `createNotification(` call site
omits an explicit config (grep/allowlist pin: tests + the review-governed set
above), so the lucky default cannot silently return.

Other named artifacts verified present: `system_feedback` (migration-020,
down path included), `truthful-ux.ts` + tests, `interaction_threads.metadata.pendingProposal`,
`audit_log.outputs_ref` JSONB, and policy
`autoApproveKinds = [brief, calendar-change, calibration, grant-reminder]`.

---

## Wave T — typing simulation (presence; independent, any time after F)

Apple provides no typing-indicator API. The bubble appears only when someone is
physically typing into a Messages compose field. Design (edge-only; no server
changes). Implementation note: all of Wave T lands in the edge repo
(`/Users/Shared/tito`, per AGENTS.md); this plan records the design and the
pins only — nothing in jehad-os changes:

- **T1** Opt-in edge-agent mode (`JEHAD_TYPING_SIMULATION=1`, DEFAULT OFF until
  the owner enables): on claim, activate Messages via System Events, focus the
  owner's thread, type the text in human-paced chunks (Option+Return for
  newlines so the message never sends mid-text), then Return to send.
  Recipient sees genuine typing bubbles during composition.
- **T2** Resilience: ANY UI-scripting failure → immediate fallback to the
  existing direct osascript send (current behavior); a kill switch env flag;
  N consecutive UI failures auto-disable the mode and audit
  `edge.typing_mode_disabled`.
- **T3** Permissions/focus: requires Accessibility grant for the edge-agent
  process; keystrokes steal focus on the dedicated Mac (accepted — it is a
  headless server box).
- **T4** Honest scope: v1 bubbles appear only during compose-and-send (2–5s);
  the model-thinking window stays silent (no composing primitive exists to
  send before text is ready). A typed-then-deleted placeholder ping is v2.
- **T5** Pins: send-only invariant holds (typing adds keystrokes, never reads —
  the send-only test gains a scoped exception with the same allowlist rigor);
  fallback path test; kill-switch test.

---

## Wave SV — self-verification (the ratified hybrid)

Owner's formalization (verbatim contract):

```
PROTOCOL / SYSTEM-STATE CLAIM
→ deterministic verification
→ mismatch
→ deterministic replacement
→ SEND

SUBSTANTIVE CONTENT CLAIM
→ grounded verification
→ mismatch
→ exactly ONE revision
→ re-audit
→ if valid: SEND
→ if still invalid: deterministic safe rendering
```

- The revise pass is turn-local correction, NOT durable learning. SV1 makes
  this answer truthful; SV3 learns why we keep making this class of mistake.
- Claim classification is STRUCTURAL (by claim class, not prose heuristics).
- The claim-audit gate applies to MODEL-PROSE replies only. Deterministic
  replies are code-authored from verified state — true by construction, zero
  gate cost.

### SV1 — protocol/state claims: verify → replace, no retry

Claim classes and their deterministic verification bases (all live in Postgres
or runtime state — one query from every reply):

| Claim class (structural) | Trigger shapes (examples) | Verification basis |
|---|---|---|
| persistence | "tracked/captured/created/scheduled/done/logged X" | commitment/reminder/event row delta this turn (commitments.created_at, reminders, audit writes) |
| negative pending-state | "nothing is waiting/awaiting confirmation" | interaction_threads.metadata.pendingProposal |
| negative capability/connectivity | "I can't reach/no access to X" | source freshness (same data the self-brief renders) |
| promised future action | "I'll text you at 2 PM / tomorrow morning" | reminders row written this turn matches the promised moment; budget notice ↔ audit |
| counts | "tracked all 8 / 3 due Wednesday" | COUNT over this turn's writes |
| delivery state | "I sent/message sent" | notification row + status |

Mismatch handling: strip the offending sentence(s), replace with the truthful
deterministic line, send. **Replacement copy is action-oriented, not a bare
correction** (UX): "I haven't tracked those yet. Reply 'track them' to save all
eight." / "You have a 9-item batch awaiting confirmation — reply 'track them'."
Replacement templates live beside the scrubber (truthful-ux.ts), pinned by
tests.

### SV2 — substantive content claims: one grounded revise, re-audit, fallback

- v1 grounded scope = the commitment/waiting-entity class (the "Tayyab is
  waiting on it / two downstream commitments" failure): when a model reply
  references known   counterparties/commitments, ONE FAST-model call extracts
  (entity, relation, count) candidate claims (through the existing model
  adapter in `packages/adapters` — the claim-audit gate is domain code and
  never imports a provider SDK directly); verified against `commitments`
  / day.state.
- Mismatch → exactly one revise pass: "Revise this answer using these verifier
  findings. Do not dispute or reinterpret the findings." → re-run the claim
  audit on the revision (the fixer gets audited too) → if still invalid,
  deterministic safe rendering (grounded facts + honest gap statement).
- Claims the verifier cannot ground → PASS, logged `unverified`. We never
  block what we cannot check; we count it.
- Cost: the extraction call fires only when the reply references known
  counterparties (rare); protocol-path replies never pay anything.

### Ledger

Every mismatch → audit action `converse.claim_audit`, structured JSONB:

```
claim_type, original_claim, verification_basis,
remediation = deterministic_replace | model_revision | safe_fallback,
revision_attempted, revision_passed
```

No new migration (audit_log.outputs_ref JSONB). SV3 aggregates
("what kinds of lies does Jarvis attempt most often?") from this ledger.

### SV3 — nightly grounded harvest → LESSONS (Reflexion, governed)

The calibration-daily job (existing 20:30 workflow) gains a grounded pass over
the day's transcript WITH DB facts attached: claim-audit ledger, user
call-outs (contradiction patterns), dead letters (F3), denials, broken
promises (SV4). Distills candidate LESSONS ("never invent reply words — any
affirmative means yes") into `system_feedback` rows. Confirmed lessons render
into a `LESSONS` block injected like the self-brief — provenance-stamped,
installed only through the W4 propose→confirm gate. The system drafts its
lessons; it never silently rewrites itself.

### SV4 — sentinels (fold F3 in)

Expired-undelivered ratified notifications, promise-without-artifact (SV1
class, caught at send AND reconciled nightly), denial spikes,
prompt_sent→delivered breaks → review items + the nightly drift report.

### Acceptance criteria (eval pins)

1. Scripted lying model ("I tracked all 8" with zero writes) → delivered text
   is the truthful action-oriented replacement; audit shows
   `deterministic_replace`; zero extra model calls.
2. "Nothing is waiting" with a pending batch → replaced with the
   action-oriented pending line.
3. Content mismatch (Tayyab case) → one revise → re-audit passes → revision
   delivered; ledger shows `model_revision, revision_passed`.
4. Revision introduces a NEW bad claim → re-audit fails → deterministic safe
   rendering delivered; ledger shows `safe_fallback`.
5. Unverifiable content claim → delivered unchanged, ledger `unverified`.
6. Deterministic replies: zero gate invocations (perf pin).
7. Golden walkthrough (multi-turn): the full 9-item-list journey — offer,
   "yes capture… thursday default", confirm, named ack — passes end-to-end
   with zero model-prose protocol.

---

## Sequencing and non-goals

- Order: **F → T → SV** (F before Sep 26; T is independent and tiny; SV is the
  full wave).
- Non-goals: no fine-tuning, no auto-tuning of prompts, no blocking of
  unverifiable content, no silent self-modification (LESSONS ride
  propose→confirm), typing simulation default-off until the owner enables it.
- Owner decisions encoded as defaults (veto = change one line): replacement
  copy is action-oriented; Accessibility + focus-steal accepted on the
  dedicated Mac.
- Landing: when ratified, sync this revision into the canonical
  `docs/plans/feedback-and-self-verification.md` (`.review/` is plan-review
  runtime state and never gets committed, per AGENTS.md), and record an ADR in
  `docs/adr/` for the SV claim-audit gate contract
  (verify→deterministic-replace / one-revise-then-safe-fallback) per the
  "ADRs for every meaningful decision" rule.
