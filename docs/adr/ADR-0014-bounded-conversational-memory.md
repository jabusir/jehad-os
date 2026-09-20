# ADR-0014: Bounded conversational working memory (Phase D)

Status: Accepted (owner decision 2026-09-20)
Supersedes: the "conversation content is never persisted" invariant of the
multiprincipal contract (narrowly, for the two tables below)

## Context

The iMessage conversation path (Phases B/C/E) is stateless: each inbound
message is a single-turn LLM call with no memory. Multi-turn references
("the second one", "I changed my mind on that") fail. The original design
prohibited persisting message content anywhere — maximally private, but
structurally incompatible with conversational continuity.

## Decision (owner, ESCALATE-1)

**Approve bounded raw conversation persistence**, scoped:

- `interaction_threads` + `interaction_messages` are the **single canonical
  storage path** for raw conversational content.
- **Active working context: 72 hours** (idle thread → turnover).
- **Raw retention: 7-day rolling maximum**, then deterministic deletion.
  (An earlier draft proposed 30 days; rejected by the owner.)
- Conversation history is **working/episodic memory only** — never
  auto-promoted to semantic memory; "remember this" still routes through
  the existing memory-candidate/promotion pipeline.
- Jehad OS owns thread identity, history, retention, audit, isolation.
  A future cognitive harness (Hermes) may only **curate** (select/compress/
  summarize) via a `WorkingContextProvider` boundary — it never becomes
  canonical storage; replacing it must not destroy continuity.

## Consequences

- The privacy invariant becomes: raw text lives in exactly ONE place,
  governed by deterministic deletion — never in audit_log, events payloads,
  model_calls, logs, or metrics. Thread lifecycle events are logged
  content-free; high-frequency message appends are not event-logged (they
  are transient working state; the retention job is the auditable control).
- History enters prompts as untrusted DATA under the Phase E injection
  boundary — including Jehad OS's own past assistant output (retained
  model text is never authority).
- Trust classes (`authenticated_user_intent`, `assistant_output`,
  `tool_output`, `retrieved_external_data`, `system_generated`) ride every
  row; authorization is never derived from any of them.
- Structural principal isolation: partial unique active-thread index,
  ownership-match trigger, and repository-level principal scoping — proven
  by adversarial tests at repo, context-builder, and turn layers.
