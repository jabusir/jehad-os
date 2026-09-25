# Semantic contract — wave9-dev-final (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 46 · pass **93.5%** · spend $0.4731 · avg latency 6901ms

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 95.7% |
| read_selection | 100.0% |
| op_type | 100.0% |
| op_args | 100.0% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 97.8% |
| truthful_ack | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| calendar_today | 2/2 |
| chat_nomutate | 3/3 |
| checkin_reply | 2/2 |
| commitment_done | 3/3 |
| commitment_missed | 2/2 |
| delegate_intent | 2/2 |
| gmail_recent | 2/2 |
| gmail_search | 2/2 |
| injection_nomutate | 2/2 |
| list_commitments | 2/2 |
| memory_recall | 2/2 |
| occurrence_happened | 2/2 |
| occurrence_skipped | 2/2 |
| offer_apply | 1/2 |
| offer_decline | 2/2 |
| profile_address | 2/2 |
| profile_tone_brevity | 1/2 |
| reminder_create | 3/3 |
| reminder_datetime | 2/3 |
| reminder_renegotiate | 2/2 |
| task_capture | 2/2 |

## Failures

### reminder-datetime-01 [reminder_datetime]
- user: "ping me tomorrow around two about the tailor"
- verified: consistent
- ops: [{"type":"reminder_create","status":"failed","detail":"unsupported-when: tomorrow around two"}]
- - remindersArmed 0≠1
- reminderDueDate null≠2026-09-26
### profile-tone-01 [profile_tone_brevity]
- user: "keep your replies to one sentence, I'm busy today"
- verified: availability-notice
- ops: [{"type":"profile_update","status":"applied","detail":"profile version 2"}]
- - shipped=true verified=availability-notice
### offer-apply-02 [offer_apply]
- user: "go ahead"
- verified: availability-notice
- ops: []
- - shipped=true verified=availability-notice
