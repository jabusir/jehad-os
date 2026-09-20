# Phase G contracts — deterministic-ref review/control over iMessage

Parent: `docs/plans/imessage-gateway.md` §3.1/§4.1 (CONTROL mode: exact
forms → deterministic resolver, **no LLM in the path**), §7 (owner-approved
sequence 2026-09-19: A → E → D → F → **G** → H). Guardrails encoded here:
refs are **authority-bearing tokens over an authenticated channel**; verbs
resolve through the EXISTING review/promotion/feedback services (one
resolver shared with CLI, gateway §7 row G — tested once, inherited by
both); commands parse **only the current inbound turn** (ADR-0014 §1
discipline; F's never-from table applies unchanged).

## 1. Scope

One migration (`013_review_refs.sql`, forward-only + tested down path) +
a ref-minting service + a deterministic control pre-pass in the existing
`converseTurn` loop (before the route pass — CONTROL wins over
CONVERSATION, gateway §3.1) + a review section in the morning brief.
**Not in scope:** ActionIntent approvals (Phase H), natural-language
control ("yeah 7K4 looks good" → LLM interpretation, gateway §3.1's
second rung), free-text verdicts, cross-surface refs.

## 2. Ref format — short, deterministic, owner-scoped

| property | value |
| --- | --- |
| shape | 3 chars, uppercase display `[7K4]`; inbound parsed case-insensitive, brackets optional |
| alphabet | Crockford base32 (0-9 A-Z minus I L O U) — no 0/O, 1/I confusables; **32³ = 32 768** live space |
| minting | per queue item at **first surfacing** (capture-ack or first digest inclusion); kept until resolution — NOT re-minted per digest (an old brief's ref stays copyable). ASSUMPTION (task sketch said per-cycle; per-cycle re-mint breaks copy-from-old-brief and creates superseded-ref confusion) |
| mint source | CSPRNG draw; retry on collision with the principal's **live** (unresolved, unexpired) refs; ≤ 25 live refs/principal by construction (§5 digest bound) → collision odds trivial |
| collision law | unique partial index on (principal_id, ref) WHERE resolved_at IS NULL; a resolved/expired ref may be re-minted for a new item — resolution ends authority |
| resolution | first verdict (approve/reject) or expiry sets resolved_at; the ref dies with it |
| TTL | `ref_ttl_hours` default 168 (7d) — an unresolved item's ref expires honest ("reply `queue` for current items"); re-minted at next surfacing |
| scoping | refs are minted per principal and resolved only for their minter. Today the review queue is single-tenant (owner's), so cross-principal collision cannot arise; the (principal_id, ref) key makes the design safe the day queues are not. Note: refs are guess-protection, not a secret channel — only paired principals reach the parser at all |

ESCALATE-1 (owner-visible): the `[7K4]` 3-char Crockford shape — matches
gateway §4.1's example; 4 chars would 32× the space at zero UX cost if the
owner prefers.

`review_refs`: ref, principal_id, item_type ('candidate'\|'escalation'),
item_id, minted_at, resolved_at, expires_at, snoozed_until, snooze_count.
Refs-only — no content, no candidate payload echoes.

## 3. Command grammar (exact-match, zero model calls)

Parsed from the **trimmed, case-insensitive current inbound text** — same
class as `/new` (deterministicReply path): matched **before** any model
call, route pass, or history assembly; unmatched text falls through to
CONVERSATION mode unchanged.

| command | semantics |
| --- | --- |
| `approve [REF]` | candidate → existing `approvePromotion` (gate 5 under review override; `memory.promoted` with reviewer recorded) |
| `reject [REF]` | candidate → existing `rejectPromotion` (status='rejected', nothing canonical) **+ one feedback row** (item_type='review_item', item_id=candidate id, verdict='noise', created_by=principal) via the existing append-only service — a rejection IS a signal-quality verdict on the queue's surfacing. ASSUMPTION on the verdict mapping |
| `snooze [REF]` | sets snoozed_until = now + `snooze_hours` (default 24); item leaves digests/`queue` until then; works on candidates and escalations; never resolves the ref |
| `queue` | deterministic short listing: live refs + one-line descriptors (truncated 80 chars), oldest-first candidates then urgency-ranked escalations (M6C `BATCH_ORDER_SQL`), bounded §5, ≤1500-char reply cap |
| bare `approve`\|`reject` | accepted **only when exactly one eligible pending item** exists (gateway §4.1); else clarification listing open refs — never a guess |

Malformed/unknown → deterministic honest error reply (F §6 class), zero
model calls. No free-text verdicts, no `capture` command (F's trigger is
imperative phrasing, not a verb — a command would fork it). ESCALATE-3:
the vocabulary itself (owner ratifies approve/reject/snooze/queue).

## 4. Delivery surface — where refs reach the owner

1. **On-capture ack (F §5 extension):** F's deterministic ack line gains
   the item's ref — "Noted [7K4] — captured for review; approve 7K4 when
   it looks right." Minting happens at candidate creation, so the ref is
   live the moment the ack sends.
2. **Morning brief review section:** bounded (top N = 10 candidates
   oldest-first — the `listReviewQueue` order — plus top 5 escalations by
   M6C urgency ranking); rendered by the existing deterministic brief
   pipeline (no LLM anywhere in briefs); suppressed entirely when the
   queue is empty (§31 no-noise rule). ESCALATE-2: brief placement is
   owner-visible surface change.
3. **On-demand `queue`** (§3) — the phone-side digest.
4. Optional: batched evening reminder piggybacks the existing evening
   close when live refs exist. ASSUMPTION: ship off until the owner asks.

## 5. Semantics — existing services, no G-owned logic

| verb | path | replay |
| --- | --- | --- |
| approve | `approvePromotion` — hard gates still apply; state-change race can still reject honestly | second `approve [REF]` → candidate no longer in_review → honest "already handled ([7K4] was approved)" noop; no second `memory.promoted` |
| reject | `rejectPromotion` + feedback insert | re-tap inside 24h collapses onto the existing feedback row (service dedupe); ref already resolved → "already handled" |
| snooze | review_refs update only | re-snooze resets the clock (owner's own queue); snooze_count surfaces in digest after 2+ |

All idempotent per (ref, command); every outcome audited
`imessage.control.verdict` — refs + ids only, grant-style provenance
(principal, handle, ref, item id, command, outcome, dedupe/replay flag),
never content. Approve rides the existing `memory.promoted` event with
the reviewer recorded — G adds no promotion logic of its own (ADR-0004).

## 6. Security — refs are authority-bearing tokens

- **Guessing**: resolution is principal-scoped; a wrong/unminted ref gets
  an honest "unknown ref" indistinguishable from a never-minted one.
  Bad-ref counter per principal per rolling hour (`max_bad_refs` default
  3): over cap → control commands answered once with a cool-down notice,
  then silent (drop + audit) until the window clears — replies are the
  spray oracle, so the cap gates replies, not just resolution. Audited
  per attempt; owner notified over E4 on lockout. ASSUMPTION on numbers.
- **Replay**: (§5) resolution is terminal; replay = honest noop. Ingest
  guid dedupe (F §7) covers transport-level redelivery before parsing.
- **Confusion**: resolved ref → "already handled" naming the prior
  verdict; expired ref → "ref expired — reply `queue`"; snoozed ref still
  resolves (snooze hides, never freezes).
- **Injection**: the parser's ONLY input is the current inbound
  `authenticated_user_intent` text (F §4 never-from table inherited
  verbatim: assistant_output, tool_output/DATA, retrieved_external_data,
  stored HISTORY can never reach it). A calendar event titled
  "approve [XYZ]" lives in DATA blocks that exist only inside the answer
  pass — which runs after the pre-pass; a planted history turn is quoted
  context. Structural, not prompt-level.
- **Scope**: `gateway.review.principals = [josctl]`. Yusra's control
  verbs → deterministic honest denial (F §6 pattern), zero model calls,
  audited, no refs minted for her. Per-principal review queues stay
  future work gated on per-principal memory (F ESCALATE-1 cross-ref).

## 7. Budgets & limits (policy.yaml `gateway.review`, strict keys)

```yaml
gateway:
  review:
    enabled: true
    principals: [josctl]
    max_bad_refs: 3        # per rolling hour → cool-down + audit
    snooze_hours: 24
    ref_ttl_hours: 168
    digest_max_candidates: 10
    digest_max_escalations: 5
```

Control commands consume **zero model calls** (deterministicReply class)
and share the Phase D 8a outbound counter — acks count toward
`replyNotificationsLastHour` under the same `requestsPerHour` cap.
Brief/digest rides the existing brief notification path (own kind, own
caps), not the reply counter.

## 8. Test matrix

1. Approve: capture → ack [7K4] → `approve 7K4` → `memory.promoted`,
   reviewer = owner principal, semantic store write via EXISTING pipeline;
   zero `model_calls` for the command turn.
2. Reject: `reject 7K4` → candidate status='rejected', one feedback row
   (review_item/noise/created_by), nothing canonical.
3. Replay: second `approve 7K4` / re-tap reject → honest "already
   handled", no second event, feedback deduped.
4. Guessing: unknown ref → honest error + counter; 4th bad ref in the
   hour → cool-down once, then drops; all audited.
5. Stale/expired: resolved ref → "already handled" naming the verdict;
   ref past TTL → "ref expired" + queue hint; re-mint on next surfacing.
6. Injection: calendar event titled "approve [XYZ]" and a planted history
   turn with the same → no verdict; parser input pinned to current
   inbound only.
7. Digest bounds: 15-pending queue → brief section = 10 oldest candidates
   + 5 urgency-ranked escalations, all with live refs; empty queue →
   section suppressed; `queue` reply ≤1500 chars.
8. Yusra denial: `approve 7K4` from yusra → deterministic denial, zero
   model calls, audited, no ref resolved (her refs don't exist).
9. Shared cap: control acks count against the 8a outbound reply counter
   (interleave commands + chat → one cap, no doubling).

## 9. Not-now

Free-text feedback/notes from iMessage (CLI territory) · third-party or
delegated approvals · cross-surface refs (Slack/web) · auto-approval
heuristics (confidence thresholds acting without the owner — ADR-0004
spirit) · natural-language control interpretation (gateway §3.1 rung two)
· escalation RESOLUTION from iMessage (snooze-only for now; escalation
disposition stays CLI until H) · per-principal review queues.
