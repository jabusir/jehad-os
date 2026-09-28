# Semantic contract — w2a-pilot-targeted3 (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 6 · pass **33.3%** · common-control **100.0%** · spend $0.1167 · avg latency 31914ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 100.0% |
| tool_validity | 66.7% |
| read_selection | 100.0% |
| op_type | 100.0% |
| op_args | 100.0% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 83.3% |
| truthful_ack | 83.3% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| delegate_intent | 1/1 |
| gmail_read_chain | 0/1 |
| new_thread_survival | 1/1 |
| offer_apply | 0/1 |
| profile_address | 0/1 |
| profile_tone_brevity | 0/1 |

## Failures

### profile-address-01 [profile_address]
- user: "call me Ustadh from now on"
- verified: consistent
- ops: [{"type":"profile_update","status":"failed","detail":"invalid: profile.update arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"profile_update","status":"applied","detail":"OPERATION RESULT profile_update: applied (profile:v2) — profile version 2"}]
- - invalid tool calls: 1
### profile-tone-01 [profile_tone_brevity]
- user: "keep your replies to one sentence, I'm busy today"
- verified: consistent
- ops: [{"type":"profile_update","status":"failed","detail":"invalid: profile.update arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"profile_update","status":"applied","detail":"OPERATION RESULT profile_update: applied (profile:v2) — profile version 2"}]
- - invalid tool calls: 1
### offer-apply-01 [offer_apply]
- user: "yes, track both"
- verified: regenerated
- ops: []
- - commitmentsOpen 0≠2
### gmail-read-chain-01 [gmail_read_chain]
- user: "has the plumber said anything about my invoice? ⏎ open that one — what does it actually say?"
- verified: regenerated
- ops: []
- - turn 2 reads missing: gmail.read
- untruthful ack: The reply claims no inbox search has been performed yet, but the read evidence shows a Gmail search was executed this turn.
