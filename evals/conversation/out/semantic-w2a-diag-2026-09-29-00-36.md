# Semantic contract — w2a-diag (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 3 · pass **0.0%** · common-control **0.0%** · spend $0.0185 · avg latency 61360ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 33.3% |
| tool_validity | 100.0% |
| read_selection | 100.0% |
| op_type | 0.0% |
| op_args | 0.0% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 33.3% |
| truthful_ack | 100.0% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| gmail_search | 0/1 |
| profile_address | 0/1 |
| profile_tone_brevity | 0/1 |

## Failures

### profile-address-01 [profile_address]
- user: "call me Ustadh from now on"
- verified: availability-notice
- ops: []
- - shipped=true verified=availability-notice
- ops missing: profile_update
- op args/verb/title mismatch
- profileVersion 1<2
### profile-tone-01 [profile_tone_brevity]
- user: "keep your replies to one sentence, I'm busy today"
- verified: consistent
- ops: []
- - ops missing: profile_update
- op args/verb/title mismatch
- profileVersion 1<2
### gmail-search-02 [gmail_search]
- user: "is there anything in my mail about the venue deposit?"
- verified: availability-notice
- ops: []
- - shipped=true verified=availability-notice
