# Semantic contract — w2a-pilot-targeted (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 7 · pass **14.3%** · common-control **0.0%** · spend $0.134 · avg latency 24157ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 100.0% |
| tool_validity | 71.4% |
| read_selection | 100.0% |
| op_type | 66.7% |
| op_args | 66.7% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 57.1% |
| truthful_ack | 100.0% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| delegate_intent | 0/1 |
| gmail_read_chain | 0/1 |
| new_thread_survival | 0/1 |
| offer_apply | 0/1 |
| profile_address | 0/1 |
| profile_tone_brevity | 0/1 |
| status_query | 1/1 |

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
### delegate-intent-01 [delegate_intent]
- user: "have one of your workers research caterers near San Jose and draft a shortlist with prices"
- verified: consistent
- ops: []
- - ops missing: outcome_spec
- op args/verb/title mismatch
- no parked outcome_spec
### new-thread-survival-01 [new_thread_survival]
- user: "delegate: research print-on-demand margins for me ⏎ /new ⏎ confirm {{confirm_token}}"
- verified: regenerated
- ops: []
- - turn 1 ops missing: outcome_spec
- outcomesActive 0≠1
### gmail-read-chain-01 [gmail_read_chain]
- user: "has the plumber said anything about my invoice? ⏎ open that one — what does it actually say?"
- verified: consistent
- ops: []
- - turn 1 reads missing: gmail.search
- turn 2 reads missing: gmail.read
