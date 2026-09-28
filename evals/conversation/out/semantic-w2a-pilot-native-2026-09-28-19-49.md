# Semantic contract — w2a-pilot-native (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 3 · pass **0.0%** · common-control **0.0%** · spend $0.0597 · avg latency 33922ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 100.0% |
| tool_validity | 33.3% |
| read_selection | 100.0% |
| op_type | 66.7% |
| op_args | 0.0% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 66.7% |
| truthful_ack | 100.0% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| reminder_create | 0/3 |

## Failures

### reminder-create-01 [reminder_create]
- user: "remind me to call mom"
- verified: regenerated
- ops: [{"type":"reminder_create","status":"failed","detail":"invalid: reminders.create arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"reminder_create","status":"applied","detail":"OPERATION RESULT reminder_create: applied (b3a67465-046e-4d75-a5fe-c4548741d285) — due 2026-09-26"}]
- - invalid tool calls: 1
- op args/verb/title mismatch
### reminder-create-02 [reminder_create]
- user: "set a reminder to water the plants"
- verified: consistent
- ops: [{"type":"reminder_create","status":"failed","detail":"invalid: reminders.create arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"reminder_create","status":"applied","detail":"OPERATION RESULT reminder_create: applied (78acb831-b926-4dc0-aa19-d67a5645fa9e) — due 2026-09-26"}]
- - invalid tool calls: 1
- op args/verb/title mismatch
### reminder-create-03 [reminder_create]
- user: "don't let me forget to charge the camera batteries"
- verified: regenerated
- ops: []
- - ops missing: reminder_create
- op args/verb/title mismatch
- remindersArmed 0≠1
