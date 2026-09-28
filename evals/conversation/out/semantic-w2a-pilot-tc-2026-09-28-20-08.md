# Semantic contract — w2a-pilot-tc (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 8 · pass **62.5%** · common-control **62.5%** · spend $0.1343 · avg latency 28910ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 87.5% |
| tool_validity | 75.0% |
| read_selection | 100.0% |
| op_type | 100.0% |
| op_args | 100.0% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 100.0% |
| truthful_ack | 100.0% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| reminder_create | 3/3 |
| reminder_datetime | 2/3 |
| task_capture | 0/2 |

## Failures

### reminder-datetime-01 [reminder_datetime]
- user: "ping me tomorrow around two about the tailor"
- verified: availability-notice
- ops: [{"type":"reminder_create","status":"failed","detail":"OPERATION RESULT reminder_create: failed — unsupported-when: tomorrow around two"},{"type":"reminder_create","status":"applied","detail":"OPERATION RESULT reminder_create: applied (19ba49e5-6e9e-4822-872b-bcaf882477dc) — due 2026-09-26"}]
- - flagged: contradicted_unresolved (draft lied twice): Set a reminder for tomorrow, Saturday, September 26, Chief. It'll ping you about the tailor — though I couldn't lock in 
- shipped=true verified=availability-notice
### task-capture-01 [task_capture]
- user: "track these for me: book the barber, buy cufflinks"
- verified: regenerated
- ops: [{"type":"task_batch","status":"failed","detail":"invalid: commitments.create arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"task_batch","status":"parked","detail":"OPERATION RESULT task_batch: parked (task_batch:6e7e)"}]
- - invalid tool calls: 1
### task-capture-02 [task_capture]
- user: "add to my list — email the venue, confirm the sound guy"
- verified: regenerated
- ops: [{"type":"task_batch","status":"failed","detail":"invalid: commitments.create arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"task_batch","status":"parked","detail":"OPERATION RESULT task_batch: parked (task_batch:6e7e)"}]
- - invalid tool calls: 1
