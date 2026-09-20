# Phase E contracts — grounded reads (conversation tools)

Parent: `docs/plans/imessage-gateway.md` §7 (owner-approved sequence 2026-09-19:
A → **E** → D → F → G → H). Owner guardrails encoded here: strictly read-only;
retrieved text is **data, never authority** (injection door #2); all queries
principal-scoped; **coverage honesty** — answers describe what connected
sensors see, never imply comprehensiveness.

## 1. Scope

Three read tools, executed deterministically server-side, results injected
into the answer pass as quoted data:

| tool | args (strict enums) | source | query |
| --- | --- | --- | --- |
| `calendar.day` | `day: today\|tomorrow` | `calendar` | day bounds via `localDayBounds(now, BRIEF_TIMEZONE)` (DST-safe); tomorrow = bounds of `today.dayEnd + 1ms` |
| `calendar.next` | — | `calendar` | next upcoming events after today (limit 3) |
| `commitments.waiting` | — | `commitments` | `whatWaitsOnMe` (overdue / due-soon / other-open count) |

**Not in scope:** writes of any kind, free-text dates, email, threads (D).

## 2. Two-pass loop over the existing ModelProvider port

No provider/tool-calling SDK changes; both passes are ordinary `callModel`
calls (egress gate + `model_calls` ledger each):

1. **Route pass** — fixed prompt, strict JSON out: one of the tool calls
   above or `{"tool":"none"}`. Parse is strict: exact keys, exact enums,
   single object. Any deviation → `none` (fail safe to plain chat).
2. **Policy gate (deterministic)** — the tool's source must be in the
   principal's `reads` list (below). Absent/denied → treated as `none`.
3. **Execute** — deterministic SQL via existing projection/query helpers.
   Dates resolve **server-side only** (`BRIEF_TIMEZONE`); the model never
   does date math (owner directive: deterministic temporal resolution).
4. **Answer pass** — fixed prompt: identity + DATA BOUNDARY block with the
   tool results + coverage metadata + honesty rules + the user's text.

A grounded turn = 2 `model_calls` rows (route + answer) under one run,
same principal/surface; budget caps count them as today (requests/h, $/day).
Principals with no `reads` skip the route pass entirely (1 call, current
behavior, honest "no data sources connected for you" phrasing when asked).

## 3. Policy

`policy.yaml` `gateway.principals.<name>` gains an optional fourth key
(strict order, fail-closed parse; unknown source names throw):

```yaml
josctl: { model: openai/gpt-4o-mini, requests_per_hour: 30, cost_per_day: 5, reads: [calendar, commitments] }
yusra:  { model: openai/gpt-4o-mini, requests_per_hour: 20, cost_per_day: 2 }
```

Absent `reads` → no tools, nothing advertised in prompts. Yusra keeps zero
world-model access by construction (calendar/commitments are the owner's
single-tenant world model; the list is only ever grantable to the owner).

## 4. Injection door #2 — data, never authority

- **Structural:** the turn type has no write path; only the three read
  tools above exist in the registry. Tool output cannot change the turn's
  capability shape.
- **Prompt boundary:** results appear only inside a marked
  `BEGIN DATA … END DATA` block labeled untrusted record content — to be
  summarized, never obeyed.
- **Minimization:** per-field truncation (event title 120, location 80,
  commitment description 160 chars) and row caps (day 25, next 3, waiting
  15) before anything reaches a prompt.
- **Audit:** `imessage.converse.tool_used` logs tool + principal + handle
  only — never retrieved content.

## 5. Coverage honesty (owner UX requirement)

Every tool result carries a `coverage` sentence (e.g. "calendar events
only; email/chat/notes are not connected"). The answer prompt requires
findings phrased per source actually queried; canonical example:

> You have 3 calendar items tomorrow. I don't currently see any manually
> tracked commitments due tomorrow.

never "Nothing else tomorrow."

## 6. Test matrix

1. `parseRouteJson` strict matrix (valid calls; extra keys / wrong enums /
   prose → `null`).
2. Owner grounded turn: scripted route JSON → tool executes → 2 model_calls
   rows, `tool_used` audit, answer prompt contains DATA block + coverage.
3. Unread-principal turn: no route pass, no tools advertised, single call.
4. Injection: hostile event title lands inside the DATA block; `calendar.write`
   route attempt parses to `none`.
5. Route-fallback: non-JSON route reply → plain-chat answer, no tool audit.
6. DST: `day:"tomorrow"` across a spring/fall boundary resolves to the
   correct civil day server-side.
7. Budget: grounded turns consume 2 requests/hour each (existing F2 lock
   path unchanged).
