# ADR-0016 — Gmail message-content ingestion as bounded, untrusted source data

- **Status:** ratified by owner (2026-09-22) — direction approved; O-9 set to **7 days** at ratification. Accepted 2026-09-22 via reconciliation pass on
  `docs/plans/delegate-watch-roadmap.md`).
- **Supersedes:** the metadata-only posture of the Gmail sensor
  (`docs/plans/gmail-sensor-contracts.md`, migration `015` header) **for
  message bodies only**; every other property of the Gmail sensor (read-only
  scope, historyId incremental pipeline, content-free observation events,
  allowlist extraction) is preserved unchanged.
- **Related:** ADR-0002 (vendor isolation), ADR-0004 (promotion truth
  semantics), ADR-0006 (event model), ADR-0012 (egress), ADR-0013
  (authorization invariant), ADR-0014 (retention precedent), roadmap §13/§18
  (GC0 wave, Chase & Close), `docs/threat-model.md` (T1 injection family).

## 1. Context

The Gmail sensor is read-only and metadata-only: one content-free
`gmail.message.received` event per inbox message (ids/domains/hashes/counts —
never subject, body, snippet, or full addresses), plus deterministic
candidates for allowlisted senders. `syncGmail` already fetches the full
`messages.get format=full` payload and normalizes `textPlain` in memory for
extraction — then discards it.

Delegate/Watch (roadmap §18) needs email replies **understood**: "What did
Acme say? What price did they quote?" Sender/time metadata cannot answer
this, and fabricating from metadata violates the truthfulness contract
(ADR-0015). Migration 015's header anticipated this exact day: *"A projection
is added the day a query needs an index events cannot serve."*

## 2. Decision

1. **Two policy-distinguished data classes.** `gmail.metadata` (today's
   behavior, unchanged) and `gmail.content` (new, separately gated in
   `policy.yaml sensors.gmail.content {enabled, retention_days,
   max_body_bytes}`). `gmail.content.enabled:false` is the default posture
   until the owner enables it (O-9).
2. **Same authorized pipeline, extended.** Content comes from the existing
   read-only `messages.get` path inside the existing historyId sync — no new
   OAuth scope, no scraping, no browser automation, no new external service.
3. **Source record, not truth.** Normalized message content persists in a
   `gmail_messages` source table: ids, provenance (historyId, ingested_at),
   principal/domain scoping, headers, snippet, **normalized body text**,
   content hash, attachment *metadata only*, and
   `source_trust_class='untrusted_external'`. An email body is evidence /
   source material — it is never a fact, commitment, outcome, or memory;
   semantic use still flows exclusively through the promotion gates
   (ADR-0004).
4. **Ingestion is deterministic and model-free.** Persisting 50 messages
   costs zero model calls. Model interpretation happens only when an active
   outcome, watch condition, explicit query, or bounded brief policy needs
   it — and then only through the egress registry (ADR-0012): a message
   whose domain/sensitivity has no allowed provider yields deterministic
   processing or an honest coverage limitation, never a bypass.
5. **Data minimization with bounded retention.** Content is retained for a
   policy window (owner decision O-9: **7 days** for ordinary body content — Gmail remains the upstream source; durable need is served by evidence/artifact snapshots, not longer windows) and then deleted; a live
   outcome/verifier that needs content beyond the window pins it as a
   bounded evidence/artifact snapshot with provenance (the mechanism lands
   with the outcome wave; until then the window is the only retention).
   Raw bodies never enter `audit_log`, event payloads, `model_calls`,
   metrics, or logs — those carry ids/references/counts only, enforced by
   scan tests.
6. **Prompt-injection boundary.** Every body entering model context is
   delimited and labeled untrusted external content under the ADR-0013
   authorization invariant: it may influence reasoning, summaries, evidence,
   candidate facts, and outcome progress; it can never mint an outcome,
   change success criteria, expand grants, authorize actions, change policy,
   approve decisions, mark completion, create spend, or promote semantic
   memory. Adversarial fixtures with hostile bodies pin this.

## 3. Adapter hardening in scope

RFC 2047 encoded-header decoding; charset-aware body decoding (UTF-8
default, declared charset honored where safe); nested MIME recursion
(already present); HTML→safe normalized text (script/style removal, tag
stripping, entity decoding — remote content is never rendered or fetched;
links reduced to safe label+destination metadata); attachment **metadata**
extraction (filename, mime type, size, attachment id — never downloaded);
snippet. MIME variants and malformed input are hermetically fixture-tested;
a parse failure leaves metadata available, marks content unavailable, and
derives no semantic claims (fail closed).

**Quoted-reply structure (owner acceptance item, 2026-09-22).** Reply-chain
quoting is *boundary-marked, not separated*: `text/plain` RFC quotes
(`> ` line prefixes) pass through as-is; HTML `<blockquote>` openings emit
a `\n> ` boundary marker (one per nesting level). The normalized body
therefore remains **one untrusted document with boundary cues** — the model
and verifier can see where quoting begins, but v1 does not strip or fully
separate quoted history, and a "what did Acme say?" answer must cite the
specific passage. Perfect authored-vs-quoted extraction is a later
refinement, deliberately not gating GC0 (owner: "wouldn't delay GC0 on
perfect reply stripping"). The live dogfood (§19 GC0) includes a long real
reply chain and records the observed behavior.

## 4. Consequences

- Positive: the email half of Chase & Close becomes honest (grounded
  extraction + verification instead of detection-only); Gmail-grounded
  answers gain provenance and coverage semantics; isolation/egress/retention
  rules are test-enforced rather than aspirational.
- Costs/risks: a new sensitive-content store (bounded, principal-scoped,
  scan-tested); MIME edge cases (fixtures + fail-closed behavior); retention
  discipline (sweeper + counts). The verifier — not the research worker, and
  never the email sender — still decides whether source evidence satisfies
  an outcome.

## 5. Non-goals

Email sending; attachment download/ingestion; generic email-ranking
subsystems; Gmail push (poll cadence stands until dogfood shows latency
pain); any change to the metadata event contract.
