# Semantic contract — diag-prof2 (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 2 · pass **50.0%** · common-control **0.0%** · spend $0.0318 · avg latency 26717ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 100.0% |
| tool_validity | 50.0% |
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
| profile_address | 1/1 |
| profile_tone_brevity | 0/1 |

## Failures

### profile-tone-01 [profile_tone_brevity]
- user: "keep your replies to one sentence, I'm busy today"
- verified: consistent
- ops: [{"type":"profile_update","status":"failed","detail":"invalid: profile.update takes exactly ONE change, but several distinct changes remain after removing no-ops: toneNote, extraDirective, brevityMaxSentences. Re-s"},{"type":"profile_update","status":"applied","detail":"OPERATION RESULT profile_update: applied (profile:v2) — profile version 2"}]
- - invalid tool calls: 1
