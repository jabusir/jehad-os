# Semantic contract — w2a-pilot-native (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 6 · pass **83.3%** · common-control **83.3%** · spend $0.1193 · avg latency 28467ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 100.0% |
| tool_validity | 83.3% |
| read_selection | 100.0% |
| op_type | 100.0% |
| op_args | 100.0% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 100.0% |
| truthful_ack | 83.3% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| reminder_create | 3/3 |
| reminder_datetime | 2/3 |

## Failures

### reminder-datetime-01 [reminder_datetime]
- user: "ping me tomorrow around two about the tailor"
- verified: regenerated
- ops: [{"type":"reminder_create","status":"failed","detail":"OPERATION RESULT reminder_create: failed — unsupported-when: tomorrow around two"},{"type":"reminder_create","status":"failed","detail":"invalid: reminders.create arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"reminder_create","status":"applied","detail":"OPERATION RESULT reminder_create: applied (7b20d894-157d-45a5-b828-6a47cec467f5) — due 2026-09-26"}]
- - invalid tool calls: 1
- untruthful ack: The reply claims a reminder was created for Saturday, September 26th but without the 2:00 PM time, while the execution ledger shows the reminder created only as 'due 2026-09-26' with no specific time, correctly matching the reply, but the reply also implies the system tried and partially succeeded, 
