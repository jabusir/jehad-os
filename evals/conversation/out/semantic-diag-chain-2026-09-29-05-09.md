# Semantic contract — diag-chain (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 1 · pass **0.0%** · common-control **0.0%** · spend $0.0307 · avg latency 60291ms · judge_unavailable 0

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
| truthful_ack | 0.0% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| gmail_read_chain | 0/1 |

## Failures

### gmail-read-chain-01 [gmail_read_chain]
- user: "has the plumber said anything about my invoice? ⏎ open that one — what does it actually say?"
- verified: regenerated
- ops: []
- - turn 2 reads missing: gmail.read
- untruthful ack: The reply implies no email search was performed yet, but the read evidence shows a Gmail search actually ran this turn.
