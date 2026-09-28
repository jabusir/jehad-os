# Semantic contract — w2a-pilot-targeted2 (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 6 · pass **0.0%** · common-control **0.0%** · spend $0.1008 · avg latency 17220ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 83.3% |
| tool_validity | 83.3% |
| read_selection | 100.0% |
| op_type | 33.3% |
| op_args | 33.3% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 33.3% |
| truthful_ack | 80.0% |
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

## Failures

### profile-address-01 [profile_address]
- user: "call me Ustadh from now on"
- verified: consistent
- ops: []
- - ops missing: profile_update
- op args/verb/title mismatch
- profileVersion 1<2
### profile-tone-01 [profile_tone_brevity]
- user: "keep your replies to one sentence, I'm busy today"
- verified: consistent
- ops: [{"type":"profile_update","status":"failed","detail":"invalid: profile.update arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"profile_update","status":"applied","detail":"OPERATION RESULT profile_update: applied (profile:v2) — profile version 2"}]
- - invalid tool calls: 1
### offer-apply-01 [offer_apply]
- user: "yes, track both"
- verified: availability-notice
- ops: []
- - flagged: contradicted_unresolved (draft lied twice): I can track both of those for you. What deadlines or details should I set for "book the barber" and "buy cufflinks"?
- shipped=true verified=availability-notice
- commitmentsOpen 0≠2
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
- verified: regenerated
- ops: []
- - turn 2 reads missing: gmail.read
- untruthful ack: The reply says no inbox messages have been pulled, but the read_evidence shows a Gmail search was already performed this turn.
