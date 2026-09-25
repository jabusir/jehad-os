# Semantic contract — baseline-dev (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 46 · pass **23.9%** · spend $0.3517 · avg latency 4783ms

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 67.4% |
| read_selection | 0.0% |
| op_type | 0.0% |
| op_args | 0.0% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 54.3% |
| truthful_ack | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| calendar_today | 0/2 |
| chat_nomutate | 3/3 |
| checkin_reply | 0/2 |
| commitment_done | 0/3 |
| commitment_missed | 0/2 |
| delegate_intent | 0/2 |
| gmail_recent | 2/2 |
| gmail_search | 0/2 |
| injection_nomutate | 2/2 |
| list_commitments | 0/2 |
| memory_recall | 2/2 |
| occurrence_happened | 0/2 |
| occurrence_skipped | 0/2 |
| offer_apply | 1/2 |
| offer_decline | 1/2 |
| profile_address | 0/2 |
| profile_tone_brevity | 0/2 |
| reminder_create | 0/3 |
| reminder_datetime | 0/3 |
| reminder_renegotiate | 0/2 |
| task_capture | 0/2 |

## Failures

### reminder-create-01 [reminder_create]
- user: "remind me to call mom"
- verified: regenerated
- ops: []
- - ops missing: reminder_create
- op args/verb/title mismatch
### reminder-create-02 [reminder_create]
- user: "set a reminder to water the plants"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
- ops missing: reminder_create
- op args/verb/title mismatch
### reminder-create-03 [reminder_create]
- user: "don't let me forget to charge the camera batteries"
- verified: regenerated
- ops: []
- - ops missing: reminder_create
- op args/verb/title mismatch
- remindersArmed 0≠1
### reminder-datetime-01 [reminder_datetime]
- user: "ping me tomorrow around two about the tailor"
- verified: consistent
- ops: []
- - ops missing: reminder_create
- op args/verb/title mismatch
### reminder-datetime-02 [reminder_datetime]
- user: "remind me to bring the marriage certificate tomorrow at 2PM"
- verified: consistent
- ops: []
- - ops missing: reminder_create
- op args/verb/title mismatch
### reminder-datetime-03 [reminder_datetime]
- user: "make sure I remember the tailor at 2 tomorrow"
- verified: consistent
- ops: []
- - ops missing: reminder_create
- op args/verb/title mismatch
- remindersArmed 0≠1
- reminderDueDate null≠2026-09-26
### task-capture-01 [task_capture]
- user: "track these for me: book the barber, buy cufflinks"
- verified: availability-notice
- ops: []
- - shipped=true verified=availability-notice
- ops missing: task_batch
- op args/verb/title mismatch
### task-capture-02 [task_capture]
- user: "add to my list — email the venue, confirm the sound guy"
- verified: regenerated
- ops: []
- - ops missing: task_batch
- op args/verb/title mismatch
### commitment-done-01 [commitment_done]
- user: "seating chart is done"
- verified: unverified
- ops: []
- - ops missing: commitment_transition
- op args/verb/title mismatch
- commitment "seating chart" = open ≠ met
### commitment-done-02 [commitment_done]
- user: "finished the seating chart"
- verified: unverified
- ops: []
- - ops missing: commitment_transition
- op args/verb/title mismatch
- commitment "seating chart" = open ≠ met
### commitment-done-03 [commitment_done]
- user: "cross seating chart off"
- verified: unverified
- ops: []
- - ops missing: commitment_transition
- op args/verb/title mismatch
- commitment "seating chart" = open ≠ met
### commitment-missed-01 [commitment_missed]
- user: "actually I missed the florist task"
- verified: regenerated
- ops: []
- - ops missing: commitment_transition
- op args/verb/title mismatch
- commitment "call the florist" = open ≠ missed
### commitment-missed-02 [commitment_missed]
- user: "never got around to calling the florist"
- verified: unverified
- ops: []
- - ops missing: commitment_transition
- op args/verb/title mismatch
- commitment "call the florist" = open ≠ missed
### reminder-renegotiate-01 [reminder_renegotiate]
- user: "move that reminder to tomorrow morning"
- verified: unverified
- ops: []
- - ops missing: reminder_reply
- op args/verb/title mismatch
- reminderDueDate 2026-09-25≠2026-09-26
### reminder-renegotiate-02 [reminder_renegotiate]
- user: "push the suit reminder to 9am tomorrow"
- verified: unverified
- ops: []
- - ops missing: reminder_reply
- op args/verb/title mismatch
- reminderDueDate 2026-09-25≠2026-09-26
### checkin-reply-01 [checkin_reply]
- user: "done"
- verified: unverified
- ops: []
- - ops missing: reminder_reply
- op args/verb/title mismatch
- remindersCompleted 0≠1
- commitment "seating chart finalized" = open ≠ met
### checkin-reply-02 [checkin_reply]
- user: "yep, all wrapped up"
- verified: unverified
- ops: []
- - ops missing: reminder_reply
- op args/verb/title mismatch
- remindersCompleted 0≠1
### occurrence-happened-01 [occurrence_happened]
- user: "I made it to the gym this morning"
- verified: unverified
- ops: []
- - ops missing: occurrence_update
- op args/verb/title mismatch
- occurrenceObserved 0≠1
### occurrence-happened-02 [occurrence_happened]
- user: "gym happened, barely"
- verified: unverified
- ops: []
- - ops missing: occurrence_update
- op args/verb/title mismatch
- occurrenceObserved 0≠1
### occurrence-skipped-01 [occurrence_skipped]
- user: "I skipped the 3pm dentist thing"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
- ops missing: occurrence_update
- op args/verb/title mismatch
- occurrenceMissed 0≠1
### occurrence-skipped-02 [occurrence_skipped]
- user: "not going to the dentist today after all"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
- ops missing: occurrence_update
- op args/verb/title mismatch
- occurrenceMissed 0≠1
### profile-address-01 [profile_address]
- user: "call me Ustadh from now on"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
- ops missing: profile_update
- op args/verb/title mismatch
- profileVersion 1<2
### profile-address-02 [profile_address]
- user: "actually address me as Sayyid, not Chief"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
- ops missing: profile_update
- op args/verb/title mismatch
- profileVersion 1<2
### profile-tone-01 [profile_tone_brevity]
- user: "keep your replies to one sentence, I'm busy today"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
- ops missing: profile_update
- op args/verb/title mismatch
- profileVersion 1<2
### profile-tone-02 [profile_tone_brevity]
- user: "be more playful, today is a good day"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
- ops missing: profile_update
- op args/verb/title mismatch
- profileVersion 1<2
### list-commitments-01 [list_commitments]
- user: "what's on my to do list?"
- verified: unverified
- ops: []
- - reads missing: commitments.waiting (got )
### list-commitments-02 [list_commitments]
- user: "what do i need to do today"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
- reads missing: commitments.waiting (got )
### calendar-today-01 [calendar_today]
- user: "what does my day look like"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
### calendar-today-02 [calendar_today]
- user: "anything on the calendar today?"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
### gmail-search-01 [gmail_search]
- user: "search my email for the venue invoice"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
### gmail-search-02 [gmail_search]
- user: "is there anything in my mail about the venue deposit?"
- verified: degraded-nonjson
- ops: []
- - shipped=true verified=degraded-nonjson
### offer-apply-02 [offer_apply]
- user: "go ahead"
- verified: availability-notice
- ops: []
- - shipped=true verified=availability-notice
### offer-decline-02 [offer_decline]
- user: "actually never mind on those"
- verified: availability-notice
- ops: []
- - shipped=true verified=availability-notice
### delegate-intent-01 [delegate_intent]
- user: "have one of your workers research caterers near San Jose and draft a shortlist with prices"
- verified: unverified
- ops: []
- - ops missing: outcome_spec
- op args/verb/title mismatch
- no parked outcome_spec
### delegate-intent-02 [delegate_intent]
- user: "delegate this: find the best rated tux cleaners in the south bay, criteria are ratings and turnaround time"
- verified: unverified
- ops: []
- - ops missing: outcome_spec
- op args/verb/title mismatch
- no parked outcome_spec
