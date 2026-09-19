# Jehad OS — iMessage Gateway: Inbound Conversational & Control Surface

**Status:** draft (plan-review loop) · **Date:** 2026-09-18 · **ADR:** [ADR-0013]

## 1. Objective and non-goals

**Objective.** Turn iMessage into a general interaction surface for Jehad OS:
conversational access to the world model, deterministic control/approval of
pending actions, and capture — all behind the existing Principal/Capability,
policy, budget, and audit machinery. The phone becomes the mobile shell:
capture, chat, query, review, approval, notification surface.

**Non-goals (this plan).** Group chats. Attachments/ tapbacks/ edits. Inbound
from any sender other than paired identities. SMS (green) fallback. A chat UI
of our own. Direct tool execution from message text (see §3). Voice/web
surfaces (the thread model anticipates them; they are separate plans).

## 2. Current state (facts, verified 2026-09-18)

- E4 send-only iMessage edge agent is deployed and adversarially verified
  (7/7 attack classes held). Outbound path: notifications queue → policy
  approval → harness claim → Messages.app → delivered. Audit-complete.
- Messages.app on this Mac runs on a **dedicated Apple ID** (send-only
  account, distinct from the owner's personal iCloud). Test delivery to the
  owner's phone verified end-to-end.
- `callModel` (OpenRouter) exists with model allowlist, budget reservation
  (advisory lock), per-call audit. **[ADR-0007, ADR-0012]**
- Principals: `josctl` (CLI user), `imessage-local` (harness, delivery-only
  capability). Grants issued via Keychain-backed credentials with TTL.
- The E4 adversary verified inbound as *closed*. This plan opens it —
  deliberately, with new machinery, not by weakening E4 constraints.

## 3. Trust model

### 3.1 The ladder

```
incoming iMessage
  → transport-untrusted
  → authenticate sender (paired transport identity, §5.1)
  → authorized Jehad message            [user intent]
  → LLM interpretation                  [proposes capabilities]
  → policy evaluation                   [Jehad OS decides]
  → capability execution or denial
```

Authenticated user intent is **intent, not executable instructions**. The LLM
may interpret "what am I waiting on?" into a proposed
`query_commitments(direction=waiting_on)`; policy — not the message text —
decides whether it runs. This is the existing ActionIntent → policy →
approval → ActionAttempt chain with iMessage as a new request surface.

### 3.2 Two injection doors

1. **Inbound transport** — closed by allowlist: only paired identities reach
   the LLM. Everyone else: dropped + audited, never rendered, never
   forwarded.
2. **Tool output** (opens at Phase E) — world-model text retrieved by read
   tools originates from emails, docs, and third-party messages. Rule:
   *authenticated intent is intent; everything the LLM reads — including
   tool results — is data.* Tool results are delimited in context and never
   execute. Untrusted-origin content keeps its provenance through retrieval.

## 4. Architecture

```
Messages chat.db (read-only sensor, ROWID cursor)
  → transport identity normalization (phone ↔ Apple ID)
  → principal authentication (paired identity, fail-closed on drift)
  → interaction event (audited)
  → conversation router
      ├─ conversation mode → LLM (stateless → bounded threads)
      │    → capability proposals → policy → world model / workflows
      └─ control mode → deterministic resolver
           (principal + referenced object + allowed action = valid command)
  → notification queue → verified E4 send-only deliverer → iMessage
```

Outbound is **only** the existing verified chain. The gateway adds zero new
egress code; replies are notifications addressed to the requesting sender.

### 4.1 Modes

- **Conversation mode** — questions, research asks, capture. LLM path.
- **Control mode** — consequential verbs (`approve`, `reject`, `send`,
  `cancel`, verdict taps like `useful|noise|missed|incorrect`). Resolves
  deterministically against pending review items / ActionIntents. The LLM may
  interpret language ("yeah that's probably fine" → `approve`), but the final
  resolution is a data match on (principal, referenced object, allowed
  action) — never a vibe. "Probably fine" without exactly one pending object
  resolves to a clarification request, not an action.

## 5. Data model

### 5.1 Pairing & transport identities

`josctl imessage pair` → 6-digit code, 5-min TTL. Owner texts the code from
the phone; sensor observes it; system records:

```
transport_identities:
  principal_id, transport: imessage, handle(s), verified_at, last_seen_as
```

Handle normalization maps phone number ↔ Apple ID email to one identity.
**Identity drift fails closed**: a paired principal presenting via an
unrecognized handle is treated as unpaired (drop + audit + notify owner via
the E4 channel). Allowlist entries are *proven by pairing*, never configured
by hand.

### 5.2 Loop defense (two guards)

- Primary: `is_from_me` filter on the sensor.
- Secondary: `sent_message_fingerprints` — the deliverer records
  (recipient, content hash, delivery timestamp); the sensor correlates
  observed chat.db rows against fingerprints. Built and validated in
  Phase A, before any LLM exists (§7 exit criteria).

### 5.3 Interaction threads (Phase D)

`interaction_threads` — surface-agnostic, not gateway-owned:

```
thread_id, principal_id, surface, created_at, last_activity_at,
working_context (bounded), ttl
```

History window bounded by tokens, message count, and age. Conversation
history is working/episodic memory **only**; it never auto-promotes to
semantic memory — capture (Phase F) goes through the normal promotion
pipeline. **[ADR-0004]**

### 5.4 Spend & rate bounds: principal × surface

Caps are not global: `{principal, surface}` → requests/hour, tokens/day,
cost/day. iMessage gateway max loss is bounded (e.g. $5/day) independent of
the CLI's budget. Enforced at `callModel` reservation time; breaches audited
and surfaced to the owner over the E4 channel.

## 6. Identity ≠ authorization (surface capability matrix)

Same principal, different surface risk:

```
jehad via CLI        → broad developer capabilities
jehad via iMessage   → conversational + review capabilities (this plan)
OpenClaw harness     → delivery only (unchanged, E4)
future: voice/web    → capture/query (separate plans)
```

iMessage-surface capabilities grow phase by phase (§7); each consequential
capability is an individual grant, revocable independently.

## 7. Phases (each boundary gets an adversarial pass)

| Phase | Adds | Trust machinery live | Exit criteria |
|---|---|---|---|
| **A — Observe** | read-only chat.db sensor, allowlist, audit log, `sent_message_fingerprints` | transport-untrusted only | ≥7 days observation; sensor correctly classified 100% of our own deliveries as outbound across ≥50 deliveries; schema-drift alerting tested; catalog of Messages weirdness (edits, tapbacks, dupes, null text, service rows) documented |
| **A′ — Spike** (may run inside A) | FDA-under-launchd wrapper, sleep/caffeinate policy, chat.db schema pinning | — | sensor survives reboot + display sleep; FDA survives OS point update drill; documented recovery runbook |
| **B — Canned loop** | full loop, no LLM: paired sender texts `ping`, gets deterministic ack | **pairing live**; fail-closed drift | owner paired; `ping`→ack < 60s round-trip; unpaired sender gets nothing; adversarial pass #1 |
| **C — Stateless chat** | LLM answers with current message + small system context only | principal×surface caps, spend/day | reliable question→answer over iMessage; budget breach test trips and notifies; adversarial pass #2 |
| **D — Bounded threads** | `interaction_threads`, windowed history | working-memory-only policy | multi-turn conversations hold context; TTL/size bounds enforced; no history leakage across principals |
| **E — Read tools** | query_commitments/calendar/decisions/attention/runs/projects, search evidence | **tool-output-as-data boundary** | answers grounded in real state; injection attempt via seeded malicious email in world model fails (red-team test); adversarial pass #3 |
| **F — Capture** | propose-memory → promotion pipeline (never direct writes) | writes via promotion rules only | "remember X" lands as candidate, appears in `feedback --candidates`, promotes correctly |
| **G — Review/feedback** | deterministic resolver over review queue + feedback verdicts from iMessage | control mode | verdict taps from phone resolve pending items; ambiguous refusals ask for clarification; shares one resolver with CLI feedback (tested once, inherited by both) |
| **H — Consequential tools** | move events, send email, cancel subscription via ActionIntent chain | per-action grants + approval | each action individually granted; approval from iMessage uses control mode; adversarial pass #4 |

Phases A–C are the committed scope of this plan; D–H are sequenced intent,
each opening its own implementation plan when its predecessor soaks clean.

## 8. Threat model additions (full matrix → `docs/threat-model.md` at build)

- **Drive-by LLM faucet** — unpaired sender reaches OpenRouter. Mitigation:
  allowlist-by-pairing only; unpaired never reaches an LLM.
- **Sender spoof / handle games** — paired principal's number re-presented
  from a new handle. Mitigation: normalized identity, fail-closed drift,
  re-pair required.
- **Self-reply loop** — our sends re-enter as input. Mitigation: §5.2 dual
  guards; Phase A exit criterion makes this empirical, not assumed.
- **Injection via tool output** — malicious third-party text in world model
  executes via LLM. Mitigation: §3.2 door two; Phase E red-team test.
- **Budget bleed** — runaway conversation consumes OpenRouter budget.
  Mitigation: §5.4 principal×surface caps, $-bounded max loss.
- **Control-mode misresolution** — "probably fine" approves the wrong thing.
  Mitigation: deterministic (principal, object, action) match; ambiguity →
  clarification, never action.
- **chat.db schema drift / FDA loss** — sensor silently dies. Mitigation:
  health-checked sensor (heartbeat metric), schema pinning, alerting over
  E4 channel; Phase A′ runbook.
- **Dedicated Apple ID compromise** — someone signs into the account
  elsewhere. Mitigation: account is receive+send for this channel only;
  drift detection on device registration is a documented residual risk
  (owner monitors Apple ID alerts); pairing identity is per-device cursor.

## 9. Observability

- Every inbound: audited with transport identity, resolution (dropped /
  unpaired / conversation / control), and outcome.
- Every LLM call: existing `model_calls` audit + surface tag.
- Sensor heartbeat metric (rows seen, cursor lag, fingerprint match rate) in
  `josctl metrics`; anomalies notify the owner over E4.

## 10. Not-now list

Group chats · attachments/tapbacks/edits parsing · SMS fallback · outbound
messages to third parties initiated from iMessage conversations · voice/web
surfaces · auto-promotion of conversation history to semantic memory · model
selection as user-facing UX (capability routing chooses; `/model` remains a
debug override).

## 11. Assumptions (chosen, not asked — flag any wrong one)

1. chat.db remains readable with FDA on current macOS; A′ validates before
   commitment.
2. The dedicated Apple ID can receive iMessages from the owner's phone
   (verified once in Phase B; if Apple restricts, pairing falls back to a
   code shown by `josctl` and entered in a reply).
3. 1:1 text-only is sufficient value for Phases A–G; multi-party is a
   different threat surface entirely.
4. OpenRouter remains the sole model provider for this surface (ADR-0007
   interface makes swapping mechanical if not).

## 12. ADR

**[ADR-0013]** — iMessage inbound gateway: paired transport identities,
intent-vs-instruction ladder, conversation/control mode split, policy-gated
capability proposals, principal×surface spend bounds; outbound unchanged
(E4 send-only deliverer remains the sole egress).
