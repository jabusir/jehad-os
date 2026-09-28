# Semantic contract — cap-sol (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 9 · pass **66.7%** · common-control **66.7%** · spend $0.2231 · avg latency 9048ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 77.8% |
| read_selection | 100.0% |
| op_type | 77.8% |
| op_args | 77.8% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 77.8% |
| truthful_ack | 100.0% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| commitment_done | 1/1 |
| reminder_create | 3/3 |
| reminder_datetime | 2/3 |
| task_capture | 0/2 |

## Failures

### reminder-datetime-01 [reminder_datetime]
- user: "ping me tomorrow around two about the tailor"
- verified: availability-notice
- ops: [{"type":"reminder_create","status":"failed","detail":"unsupported-when: tomorrow around two"},{"type":"reminder_create","status":"applied","detail":"due 2026-09-26"}]
- - shipped=true verified=availability-notice
### task-capture-01 [task_capture]
- user: "track these for me: book the barber, buy cufflinks"
- verified: degraded-nonjson
- ops: []
- - ops missing: task_batch
- op args/verb/title mismatch
- no parked task_batch
### task-capture-02 [task_capture]
- user: "add to my list — email the venue, confirm the sound guy"
- verified: availability-notice
- ops: []
- - flagged: contradicted_unresolved (draft lied twice): I can't add those to your list right now—the system hit a limit this turn. Send another message and I'll capture both ta
- shipped=true verified=availability-notice
- ops missing: task_batch
- op args/verb/title mismatch
- no parked task_batch
