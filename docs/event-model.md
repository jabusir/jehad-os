# Event Model — Jehad OS Kernel

- **Status:** Phase 0 artifact, derived from the Phase 0 plan (final, revision 3)
- **Source of truth:** `docs/plans/phase0.md` §8. This document derives; it does not
  design. Discrepancies are recorded in "Architectural concerns" below, never
  silently resolved here.
- **Citation convention** (same as the plan): bare `§N` = section N of the **directive**
  (`docs/directive/JEHAD_OS_BUILD_DIRECTIVE.md`); `plan §N` = the Phase 0 plan;
  `review §N` = the owner's external review (`docs/reviews/phase0-external-review.md`);
  `cleanup §N` = the owner's final-cleanup review
  (`docs/reviews/phase0-final-cleanup.md`).
- **Consumers:** M2 (event ingest API + idempotency + outbox + CLI capture adapter)
  is built from this document (plan §15 M2).

---

## 1. Purpose

Jehad OS is event-driven: every state change of consequence flows through the event
log with provenance (AGENTS.md; §6). External changes are normalized into a common
event model; the system is reconstructable from persisted state and events without
relying on a model remembering prior conversations (§3.1). Events are immutable once
accepted, attributable to a source, idempotent, replayable where feasible, and safe
to process more than once (§6).

## 2. Envelope

Stored verbatim in `events`, plus an `outbox` row for dispatch (plan §8; the
relational columns are defined in `docs/data-model.md` §5.3):

```json
{
  "id": "uuid-v7",
  "type": "commitment.detected",
  "schemaVersion": 1,
  "source": "cli.capture | openclaw.channel | adapter:<id> | internal",
  "occurredAt": "…", "recordedAt": "…",
  "domainId": "personal",
  "idempotencyKey": "sha256(source + external id)",
  "sensitivity": "normal",
  "payload": { },
  "runId": null
}
```

Field semantics:

| Field | Meaning |
| --- | --- |
| `id` | UUID v7 (time-ordered primary identity of this occurrence) |
| `type` | Catalog name, `<noun>.<verb_past>` (see §3–4) |
| `schemaVersion` | Payload schema version, integer, declared by every payload (review §18) |
| `source` | `cli.capture`, `openclaw.channel`, `adapter:<id>`, or `internal` — provenance attribution |
| `occurredAt` / `recordedAt` | When it happened in the world vs when the system accepted it — kept separate (review §19) |
| `domainId` | Domain the event belongs to; enforced on every read/write path (plan §10) |
| `idempotencyKey` | `sha256(source + external id)` — uniqueness enforced by constraint (see §5) |
| `sensitivity` | Sensitivity classification carried on the event (§5 provenance rule) |
| `payload` | Type-specific, versioned body |
| `runId` | Nullable — set when the event was produced inside a run |

## 3. Naming

`<noun>.<verb_past>` — noun-first for grouping (e.g. `commitment.detected`,
`decision.recorded`). The directive uses subject.verb; the plan inverts to noun-first
(D4, blessed by review §21). Noun-first is grouping-friendly and regret-free vs
subject-first, and it is now locked in by the compatibility contract (§6).

## 4. Catalog v1

All event types in catalog v1 (plan §8). This is the complete v1 list — consumers may
rely on exactly these names:

```text
capture.recorded       commitment.detected   commitment.due
commitment.overdue     decision.recorded     assumption.changed
memory.proposed        memory.promoted       run.started
run.completed          run.failed            verification.failed
escalation.raised      escalation.resolved   grant.issued
grant.revoked          brief.generated
```

17 types total, in plan order.

Directive §6 shows further normalized examples (email.received,
github.pr_opened, finance.transaction_posted, …) — those arrive with their sources in
Phase 2+ (E3 gate) and are **not** in catalog v1; adding them follows the
compatibility contract (§6), not this document.

## 5. Idempotency-key rules

- `idempotency_key` is **unique, enforced by constraint**; a duplicate delivery of the
  same key is accepted as a 200-noop, never a second state change (plan §8; plan §15
  M2 acceptance).
- **Every source defines its external id.** The key is
  `sha256(source + external id)`.
- Adapter **retries reuse** the same external id (and thus the same key) — a redelivery
  of one real-world occurrence dedupes.
- **Distinct real-world occurrences get a new key.** The CLI mints a **fresh uuid per
  `capture`/`decide` invocation**, so identical words captured twice are two events,
  never a dedupe (plan §8).
- Handlers are idempotent (safe to replay); outbox dispatch is at-least-once
  (plan §8). Mitigates duplicate/replayed events from adapter retries (T5, plan §11).

## 6. Compatibility contract (review §18; ADR-0006)

Enforced from the **first event** — before OpenClaw, remote work domains, or multiple
workers consume the stream:

1. **Event names are immutable contracts once released.** A name is never renamed,
   repurposed, or deleted.
2. **Every payload declares `schemaVersion`** (envelope field; mirrored as
   `events.schema_version int`).
3. **Consumers tolerate additive fields** — new optional fields within the same
   schema version must not break any consumer.
4. **Breaking payload changes require a new schema version** (or a new event type).

## 7. Durability and delivery semantics

- Events are immutable once accepted (§6; plan §8).
- Accepted events are recorded in `events` with an `outbox` row (status
  pending/dispatched/failed, attempts, last_error, dispatched_at) — dispatch is
  at-least-once; replay of the outbox is safe (plan §15 M2 acceptance).
- Events store **references, not bodies, where sensitive** (T4, plan §11); secrets
  never enter event payloads (AGENTS.md).
- Workflows are dispatched from events: `Jehad OS event → workflow dispatch → runtime
  execution → state mutation through domain services only` (plan §12). The event log
  stays canonical in Postgres; it is never duplicated inside the workflow runtime.

## 8. Future observation layer (design note — architecture now, wiring later; cleanup §8)

No real sources are wired in Phase 1 (E3 is the standing authorization gate; plan §19),
but the SourceAdapter/event design must stay sufficient for the eventual source
universe:

- **Source universe:** Calendar, Email, Slack, Granola/meeting notes,
  iMessage/messaging, GitHub, Linear, financial accounts, voice/manual capture,
  public web/research, home/device events.
- **Product model:**

```text
authorized source → SourceAdapter → normalized observation/event
  → extraction/policy → world-model update → watcher/workflow
  → action or attention item
```

- **Observation mechanisms:** push/webhook, poll/cursor, explicit user capture,
  derived state change.
- **Connector rule:** a connector is built **only when the system knows what useful
  state it intends to derive from it** — never ingest merely because a connector
  exists (cleanup §8). Do not ingest everything merely because a connector exists.

Architecture now, wiring later: no Phase-1 integration work is implied by this note
(cleanup §8; plan §16).

## 9. Architectural concerns (flagged, not resolved)

1. **Envelope camelCase vs column snake_case.** `schemaVersion`/`occurredAt`
   (envelope) vs `schema_version`/`occurred_at` (columns). The envelope is the wire
   and verbatim-stored form; columns are the relational projection. M2 must define
   the single mapping point. Noted also in `docs/data-model.md` §9.
2. **`source` vocabulary vs `SourceAdapter` ids.** `adapter:<id>` is the escape hatch
   for future adapters; `cli.capture` and `openclaw.channel` are named specially
   today. When the first real IntegrationAdapter lands (E3/Phase 2, plan §15), the
   M2 implementer should confirm whether the CLI keeps its special-cased source
   string or becomes `adapter:cli`. No change made here.
3. **Catalog v1 omits a `domain`/`schema.changed` style administrative event** for
   schema-version transitions; the compatibility contract (§6) governs such changes
   without defining an event for announcing them. If consumers later need an
   in-stream announcement, it must be added as a **new** event type per contract rule
   1. Flagged only.
