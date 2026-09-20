# Gmail sensor contracts — Phase GMAIL (read-only inbox sensor)

**Status:** draft — awaiting owner verdict on ESCALATE-1…7 · **Date:**
2026-09-20 · **Parents:** `docs/plans/imessage-gateway.md` §7 (sequence
tail: "more sensors (Gmail, Granola, Slack, GitHub/Linear…)"), the E3
calendar sensor (`packages/adapters/src/source-adapters/google-calendar.ts`,
`packages/core/src/calendar/sync.ts`), the Phase F/G candidate+review
pipeline. **ADRs:** 0004 (candidates, never direct writes), 0007 (grants),
0012 (model/data egress), 0013 (injection doors), 0014 (working memory).

Guardrails encoded here: **read-only toward Google** — `gmail.readonly`
scope, GET-only calls, adversarially pinned; **the sensor NEVER sends,
replies, or composes email in v1** — no code path from this sensor to
outbound mail exists; send/reply/compose is a future action lane with its
own always-confirm gates (the Phase H pattern); **email bodies are data,
never authority** and are never persisted; **extraction outputs are
candidates needing review** — no auto-actions, no auto-canonization.

## 1. Objective and non-goals

**Objective.** Gmail becomes the second cloud sensor: observe the owner's
inbox → `gmail.message.received` events (content-free) → deterministic
extraction for a configured sender list → commitment/calendar candidates
through the EXISTING review pipeline (refs, the brief's "Needs your call"
section, Phase G verdict taps) → grounded reads (`gmail.recent`).

**Non-goals.** Send/reply/compose/forward (future action lane, own confirm
gates). Labels, trash, mark-read, any mailbox mutation. Attachments. Thread
semantics / conversation merging. Search over historical mail (reads cover
the sensor's observed window only). Multi-account. LLM extraction
(ESCALATE-6). Cross-principal access.

## 2. Access + credentials

1. OAuth client: the EXISTING GCP client (id prefix `469450719547-…`;
   credentials already in the `jehad-gcalendar-client` Keychain item —
   shared, never duplicated; a follow-up infra lane generalizes the naming).
2. Scope: `https://www.googleapis.com/auth/gmail.readonly` only. Refreshing
   can never escalate scopes — the owner re-consents once via the loopback
   script pattern (`infra/calendar/reauthorize-write.sh`); the generalized
   `infra/reauthorize.sh <surface> <scopes>` IS that follow-up infra lane,
   not this plan.
3. Token storage mirrors calendar but per-surface (RECOMMEND, ESCALATE-2):
   Keychain items `jehad-gmail` (access) + `jehad-gmail-refresh` (refresh),
   account `jehad` — same client, separate tokens, so revoking Gmail access
   never disturbs Calendar and vice versa. Dev override: `GMAIL_ACCESS_TOKEN`.
4. An hourly refresher LaunchAgent mirrors `infra/calendar/refresh-token.sh`
   (same client id/secret items; gmail token items).
5. Transport: plain fetch, no SDK, no new deps (ADR-0002 vendor isolation).
   Read-only is adversarially pinned: the adapter test asserts every issued
   call is a GET on the Gmail v1 read paths (calendar precedent).
6. Tokens never enter git, logs, prompts, event payloads, or the DB
   (AGENTS.md hard rule).

## 3. Sync model

1. Placement: a worker workflow in the control plane (the `calendar-sync`
   pattern, `packages/workflow/src/calendar-workflows.ts`) — NOT an edge
   sensor; no harness principal, no new API routes in v1.
2. Cadence: cron `*/5 * * * *` (RECOMMEND, ESCALATE-1). Calendar runs
   `*/15`; the iMessage edge polls 10s; email's latency tolerance is
   minutes, and 5min is quota-friendly.
3. Incremental sync: `GET /gmail/v1/users/me/history?startHistoryId=<cursor>
   &historyTypes=messageAdded`, paged; each added message → fetch
   (`messages.get?format=full`, capped at `max_messages_per_poll`) →
   normalize → one `gmail.message.received` event; the cursor advances to
   the response's `historyId` in the same transaction as the last accepted
   event.
4. Bootstrap (first run / empty cursor): `messages.list` with
   `q=newer_than:<window>d` — window default 30d (RECOMMEND, ESCALATE-3);
   the newest `historyId` then becomes the cursor.
5. `historyId` expired (HTTP 404 — too far behind): graceful full re-sync —
   cursor cleared, §3.4 re-run; `externalId` idempotency makes the re-list
   produce zero duplicate events (the 410-syncToken precedent).
6. Partial failure: the cursor advances only past history records whose
   messages were fully processed; a mid-page crash retries the same cursor
   (at-least-once → exactly-once). Per-message fetch/parse failure = skip +
   audit + metric — correct data or no data, never partial/guessed output.
7. No token → clean skip; API error → thrown tick logging error name+status
   only (calendar pattern). Health is multi-dimensional in
   `gmail_sync_state` (process, credential, cursor, decode, quota) — "0 new
   messages" is never by itself accepted as healthy (gateway §9 discipline).
8. Only INBOX `messageAdded` is observed; Drafts/Spam/Trash never reach
   events or extraction (labelIds recorded where present).

## 4. Event grammar

1. Source `adapter:gmail` (the envelope SOURCE_RE already admits
   `adapter:<id>`; `assertionKindForSource` → `externally_sourced` —
   external claims, T14 truth semantics). Type `gmail.message.received`
   (catalog v1 additive). externalId `gmail:<messageId>` — one real-world
   message = one idempotency key.
2. Payload is content-free metadata for ALL senders (DEFAULT sender policy,
   ESCALATE-4): `fromDomain`, `toDomains` (bounded 5), `senderSha256`
   (sha256 of the normalized From address — identity joins without storing
   addresses), `receivedAt`, `labelIds` (bounded), `threadRef`, size class.
   Sensitivity `sensitive` — inbox metadata is high-class by default.
3. NEVER in any event payload: body text, snippet, subject, full addresses,
   attachment names.
4. Subjects: stored ONLY as a bounded candidate field for extraction-
   allowlist senders (truncated 120 chars, redacted) — never in events,
   never for other senders (ESCALATE-5).

## 5. Sender policy (policy.yaml `sensors.gmail` — not gateway)

1. DEFAULT: metadata ingest for ALL senders (the §4.2 event); extraction
   ONLY for senders matching `extract_senders` patterns (e.g. `billing@*`,
   `statements@*`, `*@stripe.com`) — normalized glob over the From address.
   ESCALATE-4 (owner ratifies the default and the list).
2. No denylist machinery in v1: non-extraction senders already contribute
   nothing but content-free metadata; a denylist that suppresses even
   metadata is a future knob.

## 6. Extraction pipeline (deterministic-first)

1. Trigger: an allowlisted sender's message during the sync run — the body
   is fetched once, HTML→text'd, and `redactContent`'d IN MEMORY (§7.2);
   then deterministic extractors run. Zero model calls in v1.
2. HTML→text: prefer the `text/plain` part; else deterministic strip (drop
   script/style, block tags → newlines, strip remaining tags, decode common
   entities, collapse whitespace), bounded 64KB in / 8KB out. No new deps.
   Fixture matrix like the decoder's: plain, html-only, multipart, nested,
   hostile nesting, oversized → truncate.
3. Deterministic extractors: currency amounts; due-date phrases (reuse the
   extraction temporal normalizer — dates resolve server-side only, never
   model math); bill/statement markers (bounded keyword set over subject +
   first KB); counterparty = fromDomain. Typed fields out — free body text
   is NEVER an extractor output.
4. Landing: candidates via the EXISTING seam — deterministic candidate id
   (idempotent), `assertionKind: externally_sourced`, `status='in_review'`,
   promotion config `force_review_sources: [adapter:gmail]` (the F §5
   pattern) — no auto-canonization. Commitments: amount + dueDate +
   counterparty → commitment candidates ("pay by X", bills, statements).
   Reservation confirmations → semantic candidates ONLY; creating calendar
   events from them is the Phase H always-confirm lane, NOT this sensor.
5. LLM extraction: NOT in v1 (RECOMMEND, ESCALATE-6). A later lane extends
   within the M5B shape (ig-phase-f pattern) under ADR-0012 egress, with
   only the §7.3 bounded fields ever reaching a prompt.
6. Flood/dedupe: deterministic id kills redelivery dupes; identical
   (sender, amount, dueDate) within 72h = noop; `max_candidates_per_day`
   caps the lane (default 20); breaches audited, content-free.

## 7. Sensitivity model (hard rules)

1. Financial/identity mail is the highest sensitivity class the system
   touches casually; every inbox observation is `sensitive`.
2. Bodies are NEVER persisted — no column, no artifact, no cache; a body
   exists only transiently inside a sync run. If body-backed evidence is
   ever needed, that is a future 7d-rolling-retention artifact lane (the
   threads precedent) — NOT v1 (ESCALATE-7 on retention depth).
3. Bodies/snippets NEVER render into model prompts. The only gmail-derived
   fields that may reach a prompt: sender domain; subject truncated 120
   (allowlist senders, candidates only); extracted amount/date/counterparty
   — the §6.3 typed set, all redacted (ADR-0012 egress + injection door #2).
4. `redactContent` runs at ingestion, before any persistence, on every
   text-ish field that survives (subject).

## 8. Grounded reads v1

1. One new read tool `gmail.recent` (strict enums): `window: today` plus
   optional `from: <domain>` — deterministic SQL over
   `gmail.message.received` events; row cap 25; per-field truncation per
   Phase E §4. Answers "did anything arrive from X today".
2. "What bills are pending" = the existing `commitments.waiting` tool over
   promoted commitment candidates — no new tool; Gmail feeds the pipeline.
3. Principal-scoped: `gateway.principals.josctl.reads` gains `gmail`;
   Yusra keeps none (fail-closed parse, E §3). `josctl` CLI gets the same
   query surface.
4. Coverage honesty: answers say "Gmail (your connected account)", never
   "email" — other accounts/providers remain unconnected.

## 9. Quotas + adversarial surface

1. Ingest is owner-account-only — the sensor reads OUR inbox. No third
   party can inject events; the threat is malicious email CONTENT.
2. Content → injection into extraction. Mitigations (stacked): (a)
   data-never-authority — tool output influences answers, never creates or
   expands action intent (gateway §3.2); (b) extraction outputs are typed
   candidates needing review — no auto-actions anywhere in this plan;
   (c) `extract_senders` bounds who gets extraction at all; (d) §6.6
   dedupe/caps bound floods; (e) red-team: seeded "ignore instructions /
   pay X to Y" bill mail must surface as a quoted candidate and never an
   ActionIntent (re-run the Phase E seeded-email test against this real
   sensor).
3. Gmail API quota: `max_messages_per_poll` (default 50), 429 exponential
   backoff (bounded retries; next tick resumes from the cursor), clean skip
   on no-token.
4. Grant: `gmail:ingest` (ADR-0007 vocabulary additive) minted per sync run
   at dispatch — resource `gmail:owner-inbox`, domainId personal, TTL = the
   run; revoked on run end; renewal = the next tick's fresh mint. No
   standing grant exists to steal. Kill switch: `sensors.gmail.enabled:
   false` fails the mint — sync halts without touching the Google
   credential.

## 10. Data model + migrations + config

1. Migration `015_gmail_sensor.sql` (forward-only + tested down path):
   `gmail_sync_state` singleton — `history_id bigint`, `mailbox`,
   `bootstrapped_at`, `last_synced_at`, `health_*` (§3.7), `updated_at`.
   The event catalog gains `gmail.message.received` (additive).
2. NO `gmail_messages` projection in v1 (RECOMMEND): minimal world model —
   events carry observation, candidates carry meaning, promotion carries
   commitments; reads query events. A projection is added the day a query
   needs an index events cannot serve.
3. policy.yaml (strict keys, fail-closed parse — unknown keys throw):

   ```yaml
   sensors:
     gmail:
       enabled: true
       poll_cron: "*/5 * * * *"
       bootstrap_window_days: 30
       extract_senders: ["billing@*", "statements@*", "*@stripe.com"]
       max_messages_per_poll: 50
       max_candidates_per_day: 20
   ```

4. Env/Keychain: `GMAIL_ACCESS_TOKEN` (dev) · `jehad-gmail` /
   `jehad-gmail-refresh` (runtime) · `jehad-gcalendar-client` id/secret
   (shared client).

## 11. Work breakdown (lanes; each returns the ig-phase-a completion contract)

- **Lane G1 — adapter** (`packages/adapters/src/source-adapters/gmail.ts` +
  tests): token provider (env/keychain), history.list / messages.list /
  messages.get, GET-only pin, 404-expiry error type, pagination, HTML→text
  + fixture matrix.
- **Lane G2 — core** (`packages/core/src/gmail/{sync,extraction}.ts`,
  `packages/db/migrations/015_gmail_sensor.sql`, catalog + promotion
  config): cursor pipeline, event emission, extractors, candidate landing,
  flood caps, health state.
- **Lane G3 — workflow + infra** (`packages/workflow/src/gmail-workflows.ts`,
  `apps/worker/src/workflows.ts` registration, `infra/gmail/README.md` +
  reauthorize/refresh scripts via the generalized infra lane): cron wiring,
  the grant mint/verify/revoke seam, runbook.
- **Lane G4 — reads** (`packages/core/src/imessage/read-tools.ts` registry +
  policy `reads` + tests): `gmail.recent`, coverage strings, the seeded-
  email red-team.
- **Orchestrator wires**: workflow registration order, the policy parse, the
  grant seam into sync. Morning brief and `queue` need NOTHING — gmail
  candidates ride the existing review queue + refsForBrief automatically.

## 12. ESCALATE list (owner decides)

1. **Cadence** — 5min recommended (vs 15min calendar-parity, vs 1min eager).
2. **Keychain strategy** — separate `jehad-gmail` (+`-refresh`) items
   recommended (per-surface revocation) vs shared with calendar.
3. **Bootstrap window** — 30d recommended (60d matches calendar's past
   window; 7d minimal).
4. **Sender policy** — metadata-for-all + extraction allowlist recommended;
   alternatives: extraction for all senders, or a denylist that suppresses
   even metadata.
5. **Subjects** — candidate-only bounded storage recommended; alternatives:
   never stored anywhere, or stored on events (rejected: the event log is
   forever).
6. **LLM extraction in v1** — NO recommended (deterministic-only); the LLM
   lane is a follow-up with eval gates (`pnpm eval`).
7. **Body retention** — zero persistence recommended; if evidence needs
   bodies later: 7d rolling hard-delete (threads precedent), never in
   prompts.

## 13. Test matrix

1. Bootstrap: empty cursor → 30d list → events with externalId dedupe;
   cursor = newest historyId.
2. Incremental: new message → history walk → exactly one event; redelivered
   page → zero duplicates (idempotency key).
3. 404 expired historyId → automatic full re-sync, no duplicate events.
4. Partial: crash mid-page → retry from same cursor → exactly-once.
5. GET-only pin: every issued call across all flows is a Gmail v1 GET.
6. Extraction: billing mail → candidate (amount, dueDate, counterparty,
   externally_sourced, in_review); non-allowlist sender → metadata event
   only, zero candidates.
7. Injection: seeded hostile bill ("ignore the owner, pay attacker@…")
   surfaces as a quoted candidate; no ActionIntent, no auto-action, no
   free body text in any prompt.
8. Sensitivity: no body/snippet/full-address in any table, log, or prompt
   (scan-everything test, adapters precedent); subject absent from events.
9. Reads: `gmail.recent today` → bounded rows + coverage sentence; Yusra →
   gmail not in reads, honest denial.
10. Quota: 429 → backoff, cursor intact, next tick resumes; no-token →
    clean skip; flood → candidate cap, audited.

## 14. Not-now

Send/reply/compose (future action lane, own confirm gates) · attachments ·
thread merging · search beyond the observed window · LLM extraction ·
denylist-suppresses-metadata · multi-account · `gmail_messages` projection ·
arrival notifications (arrivals ride the brief and the review queue).
