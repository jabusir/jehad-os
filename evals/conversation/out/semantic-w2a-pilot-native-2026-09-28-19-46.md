# Semantic contract — w2a-pilot-native (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 1 · pass **0.0%** · common-control **0.0%** · spend $0 · avg latency 20ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 0.0% |
| tool_validity | 100.0% |
| read_selection | 100.0% |
| op_type | 0.0% |
| op_args | 0.0% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 0.0% |
| truthful_ack | 100.0% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| reminder_create | 0/1 |

## Failures

### reminder-create-01 [reminder_create]
- user: "remind me to call mom"
- verified: unknown
- ops: []
- - shipped=false verified=unknown
- ops missing: reminder_create
- op args/verb/title mismatch
- remindersArmed 0≠1
