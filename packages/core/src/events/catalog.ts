/**
 * Event catalog v1 (docs/event-model.md §4; plan §8; ADR-0006).
 *
 * The complete v1 list — consumers may rely on exactly these names. Names are
 * immutable contracts once released (compatibility contract, event-model §6);
 * adding a type extends this tuple, renaming/removing never happens.
 */

export const EVENT_CATALOG_V1 = [
  "capture.recorded",
  "commitment.detected",
  "commitment.due",
  "commitment.overdue",
  "decision.recorded",
  "assumption.changed",
  "memory.proposed",
  "memory.promoted",
  "run.started",
  "run.completed",
  "run.failed",
  "verification.failed",
  "escalation.raised",
  "escalation.resolved",
  "grant.issued",
  "grant.revoked",
  "brief.generated",
  // E3 additive (calendar sensor): one observation type per real-world change
  // kind; field-level detail (start_end_changed vs attendees_changed …) rides
  // in payload.changeClass. Additive names only (ADR-0006); schemaVersion
  // stays 1 — additive types are allowed without a payload-schema bump.
  "calendar.event.created",
  "calendar.event.updated",
  "calendar.event.cancelled",
  // GMAIL additive (inbox sensor): ONE observation type per received
  // message; payload is content-free metadata for ALL senders (plan §4 —
  // never body text, snippet, subject, or full addresses). Additive name
  // only (ADR-0006); schemaVersion stays 1.
  "gmail.message.received",
  // W5(c) additive (commitment verbs): ONE observation type per applied
  // commitment transition; payload carries ids/statuses/verb + the
  // REDACTED principal note (capture.recorded precedent for content).
  // Additive name only (ADR-0006); schemaVersion stays 1.
  "commitment.transitioned",
  // D0 additive (Delegate/Watch roadmap §5; ADR-0017): the Outcome lifecycle.
  // Payloads carry ids/refs/statuses/counts — never owner directive text
  // beyond the confirmed title (provenance lives on the outcomes row and,
  // for criteria, in evidence). Additive names only (ADR-0006).
  "outcome.created",
  "outcome.accepted",
  "outcome.status_changed",
  "outcome.criteria_updated",
  "outcome.wait_started",
  "outcome.wait_satisfied",
  "outcome.blocked",
  "outcome.escalated",
  "outcome.completed",
  "outcome.failed",
  "outcome.cancelled",
  // D1 — the worker contract (roadmap §8): assignment lifecycle events.
  // Additive only (ADR-0006); existing consumers unaffected.
  "assignment.created",
  "assignment.status_changed",
  "assignment.succeeded",
  "assignment.failed",
  "assignment.blocked",
] as const;

export type EventTypeName = (typeof EVENT_CATALOG_V1)[number];

const CATALOG_V1_NAMES = new Set<string>(EVENT_CATALOG_V1);

export function isCatalogV1EventTypeName(value: unknown): value is EventTypeName {
  return typeof value === "string" && CATALOG_V1_NAMES.has(value);
}

/**
 * Highest payload schema version this kernel understands at ingest
 * (compatibility contract rule 4: breaking payload changes require a NEW
 * version; until one is defined, versions above this are unsupported).
 */
export const LATEST_PAYLOAD_SCHEMA_VERSION = 1;
