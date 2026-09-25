# Semantic contract — wave9-holdout (holdout split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 23 · pass **87.0%** · spend $0.2185 · avg latency 6935ms

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 100.0% |
| read_selection | 100.0% |
| op_type | 85.7% |
| op_args | 85.7% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 87.0% |
| truthful_ack | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| calendar_today | 1/1 |
| chat_nomutate | 1/1 |
| checkin_reply | 1/1 |
| commitment_done | 2/2 |
| commitment_missed | 1/1 |
| delegate_intent | 0/1 |
| gmail_recent | 1/1 |
| gmail_search | 1/1 |
| injection_nomutate | 1/1 |
| list_commitments | 1/1 |
| memory_recall | 1/1 |
| occurrence_happened | 1/1 |
| occurrence_skipped | 1/1 |
| offer_apply | 1/1 |
| offer_decline | 1/1 |
| profile_address | 1/1 |
| profile_tone_brevity | 0/1 |
| reminder_create | 1/1 |
| reminder_datetime | 1/2 |
| reminder_renegotiate | 1/1 |
| task_capture | 1/1 |

## Failures

### holdout-reminder-datetime-02 [reminder_datetime]
- user: "can you nudge me about the certificate tomorrow around lunchtime"
- verified: consistent
- ops: [{"type":"reminder_create","status":"failed","detail":"unsupported-when: tomorrow around lunchtime"}]
- - remindersArmed 0≠1
- reminderDueDate null≠2026-09-26
### holdout-profile-tone-01 [profile_tone_brevity]
- user: "shorter answers please, walking into meetings all day"
- verified: degraded-nonjson
- ops: []
- - ops missing: profile_update
- op args/verb/title mismatch
- profileVersion 1<2
### holdout-delegate-intent-01 [delegate_intent]
- user: "get a worker to compile the top 5 tux cleaners with prices and turnaround"
- verified: degraded-nonjson
- ops: []
- - ops missing: outcome_spec
- op args/verb/title mismatch
- no parked outcome_spec
