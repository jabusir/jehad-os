# Semantic contract — w2a-pilot-native (dev split)

- Model policy: repo policy.yaml gateway.passes (route gpt-4.1 / standard sonnet-4.5)
- Cases: 6 · pass **16.7%** · common-control **16.7%** · spend $0.1051 · avg latency 30430ms · judge_unavailable 0

## Metrics

| metric | rate |
| --- | --- |
| envelope_validity | 83.3% |
| tool_validity | 66.7% |
| read_selection | 100.0% |
| op_type | 100.0% |
| op_args | 16.7% |
| no_unauthorized_mutation | 100.0% |
| e2e_effects | 100.0% |
| truthful_ack | 100.0% |
| no_phantom_work | 100.0% |
| read_content | 100.0% |

## By behavior

| behavior | pass |
| --- | --- |
| reminder_create | 0/3 |
| reminder_datetime | 1/3 |

## Failures

### reminder-create-01 [reminder_create]
- user: "remind me to call mom"
- verified: consistent
- ops: [{"type":"reminder_create","status":"applied","detail":"OPERATION RESULT reminder_create: applied (957c61f5-c69a-4650-8e0a-23e2e54477e7) — due 2026-09-26"}]
- - op args/verb/title mismatch
### reminder-create-02 [reminder_create]
- user: "set a reminder to water the plants"
- verified: consistent
- ops: [{"type":"reminder_create","status":"failed","detail":"invalid: reminders.create arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"reminder_create","status":"applied","detail":"OPERATION RESULT reminder_create: applied (af381e0a-c1db-490e-9781-34da92a26907) — due 2026-09-26"}]
- - invalid tool calls: 1
- op args/verb/title mismatch
### reminder-create-03 [reminder_create]
- user: "don't let me forget to charge the camera batteries"
- verified: consistent
- ops: [{"type":"reminder_create","status":"failed","detail":"invalid: reminders.create arguments failed the schema — re-read the tool's parameter shape and retry once with corrected arguments"},{"type":"reminder_create","status":"applied","detail":"OPERATION RESULT reminder_create: applied (d66cbaf1-75cc-4772-a813-40c309fba9e3) — due 2026-09-26"}]
- - invalid tool calls: 1
- op args/verb/title mismatch
### reminder-datetime-01 [reminder_datetime]
- user: "ping me tomorrow around two about the tailor"
- verified: availability-notice
- ops: [{"type":"reminder_create","status":"failed","detail":"OPERATION RESULT reminder_create: failed — unsupported-when: tomorrow around two"},{"type":"reminder_create","status":"applied","detail":"OPERATION RESULT reminder_create: applied (79eee9d1-3802-4055-a75b-225c020f78f8) — due 2026-09-26"}]
- - flagged: contradicted_unresolved (draft lied twice): Set a reminder for tomorrow, Saturday, September 26 about the tailor, Chief. I couldn't capture the specific time, so yo
- shipped=true verified=availability-notice
- op args/verb/title mismatch
### reminder-datetime-02 [reminder_datetime]
- user: "remind me to bring the marriage certificate tomorrow at 2PM"
- verified: regenerated
- ops: [{"type":"reminder_create","status":"applied","detail":"OPERATION RESULT reminder_create: applied (30c35b4e-6c3d-4561-91d5-e2d869158873) — due 2026-09-26"}]
- - op args/verb/title mismatch
