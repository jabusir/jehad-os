# W6-phase-2: Reminder Lifecycle (follow-through)

Status: spec'd from owner conversation 2026-09-21 (verbatim behavior contract below), build in progress.
Predecessor: docs/plans/jarvis-v1.md W6 (turn-to-state proposals, landed) and 058fc63 (explicit "remind me" capture).

## The contract (owner's words, formalized)

> "tomorrow morning, it'll remind me at like 9AM the start of the work day.
> then later in the afternoon, it'll text me again and ask me 'hey did you do
> that thing i reminded you of'. and then when i say yes, it'll mark it
> resolved. otherwise it'll nudge me more urgently. or if i say, i'm gonna do
> it tomorrow, it'll abide."

A reminder is NOT a record. It is a proactive promise: the system initiates
contact at chosen moments, probes for completion, and shepherds the obligation
to resolution — negotiating, escalating, and parking. One object, three phases:
remind → probe → resolve/escalate/renegotiate.

## Lifecycle state machine

```
"remind me to X [when]"  (explicit ask; deterministic, zero model calls)
  → commitment (user_declared) + reminder armed

morning ~09:00 PT (workday start; or explicit "at 3pm" time):
  touch #1 (morning): "Reminder: {title} — today."

afternoon ~15:30 PT (or explicit-time + 3h, capped 20:00):
  touch #2 (probe):   "Did you get to {title}?"
  thread metadata pendingProbe = { reminderId } — replies resolve in-thread.

probe reply (deterministic pre-pass, no LLM):
  yes/done/yep            → commitment met (user_declared), reminder completed.
                            Light ack: "Marked done — {title}."
  "gonna do it tomorrow"  → ABIDE: due moves, cadence FORGIVES (escalations
                            reset to 0). Ack: "Moved to Wednesday — I'll
                            check back then." Renegotiation is user_declared
                            state; never argued with.
  no / not yet / silence  → escalation: next-day 09:00 nudge, firmer tone.
  "stop reminding me"     → cancelled instantly, ack: "Parked — I'll stop
                            texting about it."

nudge 1 (09:00): "Still open: {title}. Want to lock a time for it?"
nudge 2 (09:00): "Second nudge — {title} is still open. Say 'stop' and I'll park it."
nudge cap = 2 → PARKED: no more texts; surfaces once in the evening brief
("I stopped texting about {title} — still open").
```

## Scheduling rules (deterministic, tz America/Los_Angeles)

- Workday start 09:00; probe 15:30; quiet hours 22:00–07:00 (ratified).
- Fuzzy when ("tomorrow") → due date; first touch = due date 09:00.
- Explicit clock ("at 3pm") → first touch at that time, honored exactly.
  Explicit time inside quiet hours → 09:00 next day, ack says so.
- Probe time: 15:30 if first touch ≤ 15:30, else first touch + 3h capped 20:00.
- Unanswered probe pre-schedules next-day 09:00 nudge; resolution cancels or
  lets it fire. "no"/silence are the same escalation path.
- Renegotiation resets escalations to 0 (abide = forgiveness) and reschedules
  per the new when-words (same normalizer as capture; weekdays, "tomorrow",
  "tonight"→20:00, explicit "at H:MM").
- No reminder touch may be an LLM call. Templates only. Every touch audited.

## Interruption policy interaction

- User-requested touches are SOLICITED: they bypass the ≤3 unsolicited/day
  budget but never quiet hours.
- Reminders always send standalone texts (never ride the brief) — a reminder
  buried in a brief doesn't feel kept. Exception: PARKED reminders surface in
  the evening brief (that's a system-initiated mention, counts against budget).

## Consent boundary

Reminders are created ONLY by explicit ask ("remind me …", "nudge me …").
No inferred reminders in v1. Commitments inferred by the interpreter stay
commitments (offer→confirm), unchanged.

## Acceptance criteria (eval + verifier)

1. "remind me to call sheikh jamaal tomorrow" at 20:56 PT → 1 commitment +
   1 armed reminder; ack names task + promise ("I'll text you tomorrow
   morning").
2. 09:00 → "Reminder: call Sheikh Jamaal — today."
3. 15:30 → "Did you get to call Sheikh Jamaal?" + pendingProbe on thread.
4. Bare "yep" on that thread → commitment met (user_declared), completed.
5. "gonna do it tomorrow" → due moved, escalations 0, abide ack.
6. silence → next-day nudge 1, then nudge 2, then parked + evening brief line.
7. "stop reminding me" → cancelled, ack, no further touches.
8. "remind me at 3pm" → 15:00 exactly. Quiet-hours ask → next 09:00, said so.
9. Zero LLM calls in the touch path; all touches audited (audit kind
   `reminder.touch`); probe replies resolve only against the thread holding
   pendingProbe; principal isolation everywhere; titles sanitized.

## Lanes

- R1 db: migration 021 `reminders` + `packages/core/src/reminders/queries.ts`.
- R2 core: `packages/core/src/reminders/lifecycle.ts` — pure schedule math,
  state transitions, touch templates (tz-injected, no DB, no LLM).
- R3 worker: `reminder-sweep` (15-min cadence) + delivery via existing edge
  notification path + pendingProbe thread metadata + `reminder.touch` audits.
- R5 briefs: evening brief parked section; day.state armed-reminder count.
- R4 (lead): conversation.ts probe-reply pre-pass, renegotiation verbs,
  capture→reminder wiring, self-brief/system-state mention, eval scenarios.

Open params (defaults ratified in conversation, owner may adjust):
probe 15:30 · nudge cap 2 · standalone texts · workday 09:00 · PT timezone.

## Verifier wave (post-merge, 7789ca8)

Verdict FIX-FIRST → all D-items fixed in the follow-up commit:
D1 profile-override writer preserves pendingProbe · D2 late-touch probe falls
to next workday start (never quiet/past) · D3 capture rolls past explicit
times with the promise naming the actual day · D4 explicit clock times
parseable at capture · D5 titles redacted at capture · D6 claim-before-send
CAS (atomic touch claim; audit at claim time). Also: C7 negation beats the
date tail in probe replies; C10 unsupported when-words get an honest reject
("next week" etc.); N13 getReminder liveness is principal-scoped.

Deferred (known limitations, by design for v1):
- C8: one pendingProbe slot per thread — same-afternoon probes for multiple
  reminders overwrite each other (v2: batch one message, list resolution).
- C9: thread-metadata writers are read-modify-write, not transactional
  (repo-wide latent pattern; shared turn lock covers the common case).
- N11: parked-reminder brief line uses a 24h window (can double-surface on
  brief-time drift; watermark later).
- N12: /new turnover orphans a pending probe (reminder keeps escalating;
  probe lives on the active thread by design).
