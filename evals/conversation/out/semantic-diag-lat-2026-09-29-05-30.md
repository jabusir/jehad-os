# Semantic contract — diag-lat (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 8 · pass **87.5%** · common-control **50.0%** · spend $0.171 · avg latency 31318ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 100.0% |
| tool_validity | 100.0% |
| read_selection | 100.0% |
| op_type | 100.0% |
| op_args | 100.0% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 100.0% |
| truthful_ack | 87.5% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| gmail_read_chain | 2/2 |
| gmail_search | 1/2 |
| profile_address | 2/2 |
| profile_tone_brevity | 2/2 |

## Failures

### gmail-search-01 [gmail_search]
- user: "search my email for the venue invoice"
- verified: regenerated
- ops: []
- - untruthful ack: The reply claims it searched the user's email, but the execution ledger shows that no action was taken this turn.
