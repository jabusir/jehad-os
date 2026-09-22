# ADR-0015: Send-time claim audit and governed lessons (Wave SV)

Date: 2026-09-22 · Status: accepted · Decides: docs/plans/feedback-and-self-verification.md §SV

## Decision

1. **Every model-prose reply passes a deterministic claim audit before delivery.**
   Protocol/system-state claims (persistence, negative pending-state,
   capability/connectivity, promised future actions, counts) verify against
   database facts gathered at send time. On mismatch the offending sentences
   are stripped and replaced with the action-oriented truthful line — **no
   model retry**; the database is authoritative. Deterministic (code-authored)
   replies never pass through the gate — they are true by construction.

2. **Substantive content claims (v1: waiting-relation claims about known
   counterparties) get exactly one verifier-grounded revise pass**, then a
   re-audit of the revision; failure falls back to deterministic grounded
   rendering. The revise pass is turn-local correction, not durable learning.

3. **Every mismatch is ledgered** (`converse.claim_audit`, structured JSONB:
   claim_type, original_claim, verification_basis, remediation,
   revision_attempted, revision_passed). Aggregations feed SV3.

4. **Lessons are earned and governed.** The nightly harvest distills ledger
   patterns into `proposed` lessons (feedback table, migration 022
   vocabulary); only `ratified` lessons render into the answer prompt's
   LESSONS block (provenance-stamped, char-budgeted). Ratification rides
   propose→confirm — the system drafts lessons, it never silently rewrites
   itself. No fine-tuning anywhere.

## Why

The 2026-09-21/22 transcripts showed a component-competent system lying at the
seams: "I'll capture all 9 items" (zero writes), "Nothing is waiting"
(a batch WAS pending), "Reply 'confirm'" (invented vocabulary), "can't reach
your calendar" (synced an hour prior). All four were deterministically
verifiable one query from the reply. Research consensus (Reflexion, CRITIC,
Anthropic agents engineering) is unambiguous: self-correction works only when
grounded in an external verifier; ungrounded self-critique does not help. Our
ground truth is sharper than most systems' — it is SQL.

## Alternatives rejected

- LLM-judge over every reply (cost, latency, and the judge is exactly the
  component that lied).
- Fine-tuning on failure transcripts (out of scope for a single-tenant system;
  protocol failures are not weight-shaped).
- Silent strip without replacement (leaves incoherent answers; UX contract
  requires the truth be stated, not just the lie removed).
