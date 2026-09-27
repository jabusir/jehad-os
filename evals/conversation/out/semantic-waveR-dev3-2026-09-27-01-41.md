# Semantic contract — waveR-dev3 (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 60 · pass **75.0%** · common-control **80.0%** · spend $0.6513 · avg latency 4669ms · judge_unavailable 60

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 90.0% |
| read_selection | 83.3% |
| op_type | 96.3% |
| op_args | 96.3% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 90.0% |
| truthful_ack | 100.0% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| calendar_next | 2/2 |
| calendar_today | 2/2 |
| chat_nomutate | 3/3 |
| checkin_reply | 2/2 |
| commitment_done | 3/3 |
| commitment_missed | 1/2 |
| delegate_confirm | 2/2 |
| delegate_intent | 2/2 |
| gmail_read_chain | 0/2 |
| gmail_recent | 2/2 |
| gmail_search | 2/2 |
| injection_nomutate | 2/2 |
| list_commitments | 1/2 |
| memory_recall | 2/2 |
| new_thread_survival | 0/2 |
| occurrence_happened | 2/2 |
| occurrence_skipped | 2/2 |
| offer_apply | 1/2 |
| offer_decline | 2/2 |
| phantom_work | 2/2 |
| profile_address | 1/2 |
| profile_tone_brevity | 1/2 |
| referent_chain | 2/2 |
| reminder_create | 3/3 |
| reminder_datetime | 0/3 |
| reminder_renegotiate | 0/2 |
| status_query | 1/2 |
| task_capture | 2/2 |

## Failures

### reminder-datetime-01 [reminder_datetime]
- user: "ping me tomorrow around two about the tailor"
- verified: consistent
- ops: [{"type":"reminder_create","status":"failed","detail":"unsupported-when: tomorrow around two"}]
- - remindersArmed 0≠1
- reminderDueDate null≠2026-09-26
### reminder-datetime-02 [reminder_datetime]
- user: "remind me to bring the marriage certificate tomorrow at 2PM"
- verified: regenerated
- ops: [{"type":"reminder_create","status":"applied","detail":"due 2026-09-27"}]
- - reminderDueDate 2026-09-27≠2026-09-26
### reminder-datetime-03 [reminder_datetime]
- user: "make sure I remember the tailor at 2 tomorrow"
- verified: consistent
- ops: [{"type":"reminder_create","status":"applied","detail":"due 2026-09-28"}]
- - reminderDueDate 2026-09-28≠2026-09-26
### commitment-missed-02 [commitment_missed]
- user: "never got around to calling the florist"
- verified: consistent
- ops: [{"type":"commitment_transition","status":"failed","detail":"selector-no-match: calling the florist"}]
- - commitment "call the florist" = open ≠ missed
### reminder-renegotiate-01 [reminder_renegotiate]
- user: "move that reminder to tomorrow morning"
- verified: availability-notice
- ops: [{"type":"reminder_reply","status":"applied","detail":"renegotiate"}]
- - shipped=true verified=availability-notice
### reminder-renegotiate-02 [reminder_renegotiate]
- user: "push the suit reminder to 9am tomorrow"
- verified: availability-notice
- ops: [{"type":"reminder_reply","status":"applied","detail":"renegotiate"}]
- - shipped=true verified=availability-notice
### profile-address-02 [profile_address]
- user: "actually address me as Sayyid, not Chief"
- verified: availability-notice
- ops: [{"type":"profile_update","status":"applied","detail":"profile version 2"}]
- - shipped=true verified=availability-notice
### profile-tone-02 [profile_tone_brevity]
- user: "be more playful, today is a good day"
- verified: degraded-nonjson
- ops: []
- - ops missing: profile_update
- op args/verb/title mismatch
- profileVersion 1<2
### list-commitments-02 [list_commitments]
- user: "what do i need to do today"
- verified: regenerated
- ops: []
- - reads missing: commitments.waiting (got day.state,day.state)
### offer-apply-02 [offer_apply]
- user: "go ahead"
- verified: availability-notice
- ops: [{"type":"task_batch","status":"parked","detail":null}]
- - shipped=true verified=availability-notice
### status-query-02 [status_query]
- user: "any word on the vacuum comparison work?"
- verified: availability-notice
- ops: []
- - shipped=true verified=availability-notice
### new-thread-survival-01 [new_thread_survival]
- user: "delegate: research print-on-demand margins for me ⏎ /new ⏎ confirm {{confirm_token}}"
- verified: regenerated
- ops: []
- - turn 1 ops missing: outcome_spec
- outcomesActive 0≠1
### new-thread-survival-02 [new_thread_survival]
- user: "have a worker look into cheap crm tools, delegate it ⏎ /new ⏎ confirm {{confirm_token}}"
- verified: availability-notice
- ops: [{"type":"outcome_spec","status":"parked","detail":"staged, NOT started — confirm token N643X (quote it verbatim in your ask)"}]
- - shipped=true verified=availability-notice
### gmail-read-chain-01 [gmail_read_chain]
- user: "has the plumber said anything about my invoice? ⏎ open that one — what does it actually say?"
- verified: consistent
- ops: []
- - turn 2 reads missing: gmail.read
### gmail-read-chain-02 [gmail_read_chain]
- user: "did the airline email me about my flight? ⏎ yeah open it, what are my options in there"
- verified: regenerated
- ops: []
- - turn 2 reads missing: gmail.read
