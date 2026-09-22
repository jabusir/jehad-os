# Wave F + T + SV: Feedback Pipeline, Presence, and Self-Verification

Status: proposed 2026-09-22, plan-review in progress.
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
  notifications module) that loads `loadNotificationsConfig` from the repo
  policy (fail-closed to defaults on parse failure) and passes it to
  `createNotification`. Convert EVERY workflow-created notification:
  calibration-workflows, grant-workflows (grant-expiry-reminder — fires ~Sep 26,
  hard deadline), calendar-change path, and briefs (explicit config instead of
  lucky default).
- **F2** Pins: for each ratified kind, workflow-path creation yields
  `status='approved'`; a seeded approved notification is returned by
  `POST /harness/notifications/claim`.
- **F3** Dead-letter sentinel: any `calibration`/`grant-reminder`/
  `calendar-change` notification that expires without `delivered_at` opens a
  `system_feedback` review item (migration-020 table, currently zero rows) and
  console-alerts. Lands with F1 so the sentinel would have caught this on
  Sep 16.
- **F4** Deploy + live check: tonight's 20:30 PT calibration prompt must show
  `prompt_sent` → `claimed` → `delivered` in the audit.
- **F5** Acceptance: the two expired rows remain as the golden failure record;
  new runs deliver; grant-reminder verified delivered (or scheduled < Sep 26).

---

## Wave T — typing simulation (presence; independent, any time after F)

Apple provides no typing-indicator API. The bubble appears only when someone is
physically typing into a Messages compose field. Design (edge-only; no server
changes):

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
  references known counterparties/commitments, ONE FAST-model call extracts
  (entity, relation, count) candidate claims; verified against `commitments`
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
