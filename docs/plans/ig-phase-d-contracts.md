# Phase D contracts — bounded conversational threads

Parent: `docs/plans/imessage-gateway.md` §5.3, §7 (owner-approved sequence
2026-09-19: A → E → **D** → F → G → H). Owner framing encoded here:
**in-place thread turnover** — idle gap, turn cap, TTL; one rolling thread
per principal; explicit `/new` reset; history is working/episodic memory
ONLY, never silent semantic promotion **[ADR-0004]**. Phase E's
data-never-authority boundary extends to history blocks unchanged.

## 1. Scope

One migration (`012_interaction_threads.sql`, forward-only + tested down
path) + a thread service + integration into the existing `converseTurn`
loop. Adds: bounded persistence of turns, windowed history in the answer
pass, automatic turnover, `/new`. **Not in scope:** semantic promotion,
cross-surface merging, history search (§7).

## 2. Data model (plan §5.3 — columns exactly as sketched)

```
interaction_threads:  thread_id, principal_id, surface, created_at,
                      last_activity_at, working_context (bounded), ttl
interaction_messages: id, thread_id, principal_id, surface, direction,
                      source_ref, received_at, content_ref, trust_class
```

- One **rolling thread per (principal, surface)** — the active thread.
  Turnover closes it and opens a fresh one (in-place, no archive thread).
- `ttl` = absolute expiry timestamptz (`created_at + threads.ttl_hours`,
  never extended by activity — idle gap covers inactivity).
  ASSUMPTION: sketch's `ttl` read as a timestamp, not an interval.
- `working_context` stays **NULL in Phase D** — the window is derived from
  `interaction_messages` at each turn (no cache to drift). Column reserved
  per sketch. ASSUMPTION.
- `source_ref`: inbound = chat.db ROWID (raw stays external, per §5.3);
  outbound = notification id. No new raw-content store.
- `trust_class`: `user` (inbound) | `assistant` (model reply). Reserved:
  `external` (future surfaces). Added nothing beyond the sketch — turn
  count and token estimates are derived (COUNT + deterministic estimator),
  not columns.
- `interaction_messages` persists past thread close (canonical timeline,
  §5.3) under its own retention — see ESCALATE-1.

### 2.1 Content policy — ESCALATE-1 (owner-visible change)

Today's invariant: message content is TRANSIENT, never persisted in any
table. Phase D **deliberately changes this**, bounded:

| what | where | bound |
| --- | --- | --- |
| inbound turn text | `content_ref` | redacted + truncated to 2000 chars |
| reply text (as capped for the edge) | `content_ref` | ≤1500 chars (render cap) |
| raw transport bytes / attributedBody | nowhere | never copied — `source_ref` only |

- Redaction = denylist pass (card numbers, bearer/api-token shapes) masked
  before write; otherwise verbatim. ASSUMPTION (minimal stance, no
  munging that breaks loop-defense normalization lineage).
- Retention: rows hard-deleted `threads.retention_days` (default 30) after
  thread close; audit rows and event log stay content-free as today.
- Expired/closed-thread rows are **never injected** into any prompt —
  persistence is for the future cross-surface timeline, not memory.
- ESCALATE: owner must sign off flipping "never persisted" → "bounded,
  redacted, TTL-bounded, thread-scoped" for these two tables only.

## 3. Segmentation & turnover (config, not state — §5.4 pattern)

`policy.yaml` `gateway.threads` (fail-closed parse, strict keys):

| key | default | meaning |
| --- | --- | --- |
| `idle_hours` | 6 | gap ≥ this since `last_activity_at` → new thread |
| `max_messages` | 40 | thread reaching this on inbound → new thread |
| `max_thread_tokens` | 24000 | est. tokens across thread turns → new thread (derived via the deterministic estimator — no column) |
| `window_max_messages` | 24 | window injection cap (count) |
| `window_max_tokens` | 8000 | window injection cap (est. tokens) |
| `window_max_age_hours` | 24 | window injection cap (age of oldest turn) |
| `ttl_hours` | 72 | absolute thread expiry |
| `retention_days` | 30 | post-close row retention (ESCALATE-1) |

All defaults ASSUMPTION. Turnover is **lazy**: evaluated at next inbound —
close + open happen inside that turn's lock; no reaper on the correctness
path (a hygiene job may delete expired rows later). Turnover side effects:
old thread closed (`working_context` stays NULL, rows retained per table),
new thread starts **empty — hard cut, no model-generated summary**
(a summary would be unreviewed model memory; contradicts ADR-0004 spirit).

`/new` — exact form (trimmed, case-insensitive), CONTROL-style: handled
deterministically **before** any model call — close thread, reply fixed
"Started a new conversation." No model call, no budget consumption (same
class as attachment-only). ASSUMPTION: no other slash commands in D.

## 4. Turn integration (existing two-pass loop, conversation.ts)

History enters **after** grant/budget/lock, as deterministic SQL + caps —
no model call of its own:

1. Resolve active thread (create if none); apply §3 turnover checks first.
2. Append inbound row; assemble the window (count/token/age caps, oldest
   dropped first) from `interaction_messages` — same thread only.
3. **Route pass stays history-free.** It classifies the *current* message
   against a fixed enum; history adds untrusted injection surface + cost
   to the one pass that cannot benefit: an anaphoric follow-up ("what
   about tomorrow?") misroutes to `none` and the history-bearing answer
   pass still answers or invites a direct ask. Fail-safe shape unchanged.
   ASSUMPTION — revisit with routing-miss telemetry.
4. **Answer pass**: bounded transcript injected as a marked
   `BEGIN HISTORY … END HISTORY` block inside the Phase E DATA-boundary
   discipline — prior turns labeled `trust_class`, to be treated as
   context, never instructions; then tool DATA block (if any); current
   message last, outside all blocks.
5. After reply: append outbound row, update `last_activity_at`.

Lock/budget interplay: thread read/append happens **inside** the existing
per-principal advisory turn lock (no lost appends under concurrent
inbound). A threaded turn costs exactly what it does today — 1 call
ungrounded, 2 grounded; history tokens ride the same `model_calls`
reservation; caps and the F2 check-then-dispatch serialization are
unchanged. `/new` and attachment-only turns: zero calls.

## 5. Trust — history is data, never authority

- Every stored turn carries `trust_class`; at read time **all** history is
  prompt *content*. Only the current authenticated message constitutes
  intent for this turn — even the principal's own old text is not
  re-executed as instructions (a planted "ignore previous rules" turn is
  quoted context, nothing more).
- History cannot create or expand authorization (§3.2 door two extended):
  threads add no tools, no write path, no capability shape; the Phase E
  registry is untouched. Stored text may influence the answer's phrasing
  only.
- Never semantic memory: no component reads `interaction_messages` except
  the window assembler; no promotion path touches it (ADR-0004 — capture
  is Phase F's pipeline, explicitly user-initiated).

## 6. Test matrix

1. Turnover boundaries: 40th-message close, idle 6h+1min close, token-cap
   close — each starts a fresh thread; answer prompt contains zero
   pre-turnover turns (hard cut).
2. `/new`: deterministic reply, no `model_calls` row, no budget consumed;
   next turn runs on an empty window; `"/New "` (trim/case) matches,
   `/newx` does not.
3. TTL expiry: thread past `ttl` treated as closed on next inbound; its
   rows never injected; retention delete removes content_ref rows.
4. Window caps: long/many turns — assembled history never exceeds
   count/token/age caps (deterministic estimator pinned in test).
5. Cross-principal isolation: yusra's thread never appears in a josctl
   prompt and vice versa (structural: window query is thread-scoped,
   thread is principal-scoped).
6. Injection via stored history: hostile instruction planted in an early
   turn lands only inside HISTORY block; route pass (history-free)
   unaffected; no capability/route expansion; reply may quote, never
   obeys.
7. Budget/lock unchanged: threaded grounded turn = 2 `model_calls` rows,
   same caps; concurrent inbound serializes under the advisory lock with
   no lost appends.
8. Content policy: stored text truncated (2000/1500) and denylist-masked;
   audit + event rows remain content-free.

## 7. Not-now

Semantic promotion of history (ADR-0004) · cross-surface thread merging
(schema is surface-agnostic; threads stay per-surface until web/voice
land) · search/retrieval over `interaction_messages` (window is
recency-only) · model-generated thread summaries on turnover · group
threads · any write tool.
