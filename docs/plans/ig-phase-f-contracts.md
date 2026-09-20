# Phase F contracts — conversation capture → memory candidates

Parent: `docs/plans/imessage-gateway.md` §7 (owner-approved sequence
2026-09-19: A → E → D → **F** → G → H; owner spec 2026-09-20 for D: F gets
this separate plan + adversarial gate). Guardrails encoded here: "remember X"
lands as a **candidate** via the EXISTING extraction/promotion pipeline —
never a direct semantic write (ADR-0004); candidates carry **speaker
attribution** ("Jehad said X"), never "X is objectively true"; capture reads
ONLY the current authenticated inbound turn (ADR-0014 §1: a mention is
working context, an imperative is a capture).

## 1. Scope

Capture detection on the iMessage conversation path + a `capture.recorded`
side-event + reuse of the M5B extraction lane unchanged in shape. **Not in
scope:** promotion decisions (M5C + review queue, unchanged), Phase G
review/approval taps from iMessage, write tools, cross-principal memory.

## 2. Trigger semantics — deterministic first, route-pass fallback

Both detectors read **only the current inbound message** (never HISTORY,
never tool DATA):

1. **Deterministic pre-pass** (zero model calls): trimmed, case-insensitive
   prefix match on imperatives `remember that…`, `note that…`,
   `remember:…`, `note:…`, `don't forget that…`, `keep in mind that…`
   (pattern list is config, §8). Canonical example: "Remember that I'm
   looking for a Porsche 911." → capture; a mention ("I've been looking at
   Porsche 911s") matches nothing → working context only (ADR-0014 §1).
2. **LLM fallback**: the Phase E route-pass JSON extends to
   `{"tool":"…","capture":true|false}` — `capture` optional, absent =
   false; strict parse (exact keys/enums), any deviation → `none` +
   `capture:false` (fail safe). The route prompt gains the distinction
   rule with the canonical example: explicit storage request →
   `capture:true`; narration/mention → `false`.

Budget: a capture turn is still **≤ 2 `model_calls`** — detection rides the
existing passes; the candidate write is deterministic DB work. The one
downstream extraction call runs in the existing M5B lane under its own
budget, not against `gateway.principals` caps. The route pass now runs when
`reads` is non-empty **or** capture is enabled. ASSUMPTION.

## 3. Candidate shape — existing pipeline, not a fork

On trigger the turn emits one `capture.recorded` event (the candidate's
source event); the existing `extractFromEvent` lane produces the
`memory_candidates` rows per the shared contract:

| field | value |
| --- | --- |
| source event | `capture.recorded`, source `imessage.capture`, externalId `imessage-capture:<guid>` (idempotent) |
| payload.text | the inbound text, truncated 2000 chars (Phase D cap) |
| payload refs | transport event id (guid row), `interaction_messages` id, thread id, surface — refs only |
| domain / sensitivity | `personal` / `normal` |
| assertion_kind | `user_declared` — extend `assertionKindForSource`: `imessage.capture` → user_declared (the principal's own authenticated words; detection never runs on model output) |
| classes | commitment/decision extraction unchanged; extraction v4 adds `is_memory_note` → proposedClass `semantic`, payload `{statement}` (the 911 case is neither obligation nor decision) — extension inside the M5B lane; golden-set eval gates (`pnpm eval`) apply |

Candidates mean **"the principal said X"** (ADR-0004 hard rule):
external-world claims stay claims — attributed, never canonized. Candidate
id stays the existing deterministic sha256(source event + class + kind +
payload): redelivery is a no-op by construction.

## 4. Never-from list (hard, structural)

| source | can trigger capture? |
| --- | --- |
| `authenticated_user_intent` (current inbound) | **yes — the only one** |
| `assistant_output` (own replies) | never |
| `tool_output` / DATA blocks | never |
| `retrieved_external_data` | never |
| stored HISTORY replay | never |

Structural, not prompt-level: detection's only inputs are the ingest-row
text (pre-pass) and the route pass over the current message (§2); tool
results and history exist solely inside the answer-pass prompt, whose
output is reply text — never parsed for capture.

## 5. Review + reply UX

- Every iMessage capture candidate routes to the **existing review queue**
  (`status='in_review'`): visible via `josctl feedback --candidates`,
  approved/rejected through the existing review service; owner approval →
  semantic memory. **No auto-canonization, no silent promotion** — stricter
  than the base gate's user_declared auto-promote path, via promotion
  config `force_review_sources: [imessage.capture]` (rules are data,
  ADR-0004 §4). ESCALATE-3.
- Reply UX: **deterministic** ack — a fixed line ("Noted — captured for
  review; it becomes memory once you approve.") appended to the turn's
  reply at creation (cap-aware; no extra notification, no model call, no
  candidate content echoed). ASSUMPTION: deterministic over model-generated
  — honest, free, cannot paraphrase memory into a leak.

## 6. Principal scoping — the world model is single-tenant

`gateway.capture.principals` = `[josctl]`. Yusra's "remember this" hits the
pre-pass, is not capture-enabled, and gets a **deterministic honest denial
reply** (zero model calls, `/new` class): capture is enabled only for Jehad
on this channel. **Recommend: deny + honest reply now**; per-principal
memory namespaces stay future work (schema-wide change, not a gateway
toggle). ESCALATE-1 (owner ratifies the denial UX).

## 7. Injection defenses

- **History**: detection never reads HISTORY (§4); the route pass stays
  history-free (Phase D §4) — a planted "remember that…" in a stored turn
  is quoted context, nothing more.
- **Replay/redelivery**: triple idempotency — ingest dedupes on guid and
  routes only on first acceptance; the capture event's externalId is
  `imessage-capture:<guid>`; the candidate id is deterministic in the
  source event. One guid → at most one candidate, ever.
- **Adversarial calendar/tool content**: tool output reaches only the
  answer pass; a "remember…" event title may influence reply phrasing,
  never the capture flag (never-from is structural).
- **Quoted third-party text** in the owner's message ("Dana said remember
  X"): captures as an attributed statement of what Jehad relayed; hearsay
  never becomes verified fact.

## 8. Budgets & limits (policy.yaml `gateway.capture`, strict keys)

```yaml
gateway:
  capture:
    enabled: true
    principals: [josctl]
    max_candidates_per_hour: 5
    dedupe_window_hours: 24
```

- **Rate cap**: turn caps unchanged (`requestsPerHour`); the flood guard
  counts capture events per principal per rolling hour — over `5` →
  capture suppressed (audited, honest "capture limit reached" ack), the
  conversational turn proceeds. Recommend **5/hour**: owner-paced human
  traffic; bounds extraction-lane spend. ASSUMPTION.
- **Dedupe**: same normalized text within the window (reuse
  `normalized_text_sha256` normalization) → **noop + ack "already
  captured"** — not confidence bumping: repetition-raised confidence is
  gameable and mutates state on restatement; noop keeps the queue clean.
  ASSUMPTION.
- Audit `imessage.converse.captured` — refs only (principal, handle,
  trigger: pattern|route, capture event id, dedupe/flood status), never
  content.

## 9. Test matrix

1. Deterministic trigger: "Remember that I'm looking for a Porsche 911."
   → capture event + candidate (semantic note, user_declared, provenance
   refs) + ack appended; ≤ 2 `model_calls` for the turn.
2. LLM fallback: non-pattern storage phrasing ("could you hold on to the
   fact that X?") routes `capture:true`; strict-parse deviations fail safe
   to no capture.
3. Mention vs remember: "I've been looking at Porsche 911s" → no capture
   event, no candidate; text lives only in `interaction_messages`.
4. Never-from-assistant: a reply containing "remember that …" never yields
   a candidate.
5. Replay dedupe: redelivered guid → no second routing, capture event
   (externalId conflict), or candidate.
6. Yusra denial: not capture-enabled → deterministic honest reply, zero
   model calls, no event.
7. Injection via history: stored turn "remember that X" → no capture;
   detection inputs pinned to the current message.
8. Flood cap: 6th "remember…" within the hour → capture suppressed,
   audited, honest ack; conversation continues.
9. Tool-content smuggling: calendar event titled "remember that …" → no
   capture (DATA never reaches detection).
10. Promotion path: approved candidate → semantic store + `memory.promoted`;
    rejected → nothing canonical; no auto-canonization anywhere.

## 10. Not-now

Auto-summarization of threads into memory · cross-principal memory
namespaces · semantic clustering / embeddings (pgvector stays off-list) ·
implicit capture from mentions · "forget that…" deletion counterpart ·
Phase G iMessage review/approval taps (next lane).
