// Typed wait/watch predicates (roadmap §5.5; ADR-0017 §1.2).
//
// `outcome_waits.predicate` and (in W0) `watches.condition` validate against
// THIS vocabulary — versioned, validator-enforced, matcher-implemented.
// Rejected outright: arbitrary SQL, model-supplied JSONPath, user-defined
// executable expressions, eval(), rules-engine DSLs. A model may PROPOSE a
// condition; this module validates and canonicalizes it or refuses it.
//
// V1 matcher coverage:
//   arrival      — event-matched by the resume router (gmail/calendar).
//   state_change — event-matched (canonical outcome.status_changed events).
//   absence_past — poll-evaluated (W0 watch evaluator; creation is refused
//                  for outcome_waits until then — fail closed, no silent
//                  no-op waits).
//   threshold    — evaluated by the budget lane (D1); refused for
//                  outcome_waits until then.

export type WaitEventType =
  | "gmail.message.received"
  | "calendar.event.created"
  | "calendar.event.updated"
  | "outcome.status_changed";

export type OutcomeWaitPredicate =
  | ArrivalConditionV1
  | StateChangeConditionV1
  | AbsencePastConditionV1
  | ThresholdConditionV1;

export interface ArrivalConditionV1 {
  readonly v: 1;
  readonly type: "arrival";
  readonly source: "gmail" | "calendar";
  /** Lowercased sender DOMAIN for gmail arrival (metadata events carry domains, never addresses). */
  readonly fromDomain?: string;
}

export interface StateChangeConditionV1 {
  readonly v: 1;
  readonly type: "state_change";
  readonly entity: "outcome";
  /** The other outcome whose status change wakes this wait. */
  readonly outcomeRef?: string;
  /** Only wake when the other outcome lands in this status. */
  readonly toStatus?: string;
}

export interface AbsencePastConditionV1 {
  readonly v: 1;
  readonly type: "absence_past";
  readonly subject: "commitment" | "reminder" | "outcome";
  readonly olderThanHours: number;
}

export interface ThresholdConditionV1 {
  readonly v: 1;
  readonly type: "threshold";
  readonly metric: "outcome_spend_usd";
  readonly gt: number;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const OUTCOME_STATUSES = new Set([
  "proposed", "accepted", "queued", "running", "waiting_external",
  "waiting_user", "blocked", "verifying", "completed", "failed", "cancelled",
]);

/** Predicate types whose event matcher the resume router implements today. */
export const MATCHABLE_PREDICATE_TYPES: readonly string[] = ["arrival", "state_change"];

export function isOutcomeWaitEventType(value: unknown): value is WaitEventType {
  return (
    value === "gmail.message.received" ||
    value === "calendar.event.created" ||
    value === "calendar.event.updated" ||
    value === "outcome.status_changed"
  );
}

/**
 * Validates and canonicalizes an untrusted candidate (model-proposed or
 * owner-typed) into a versioned predicate. Returns null on ANY deviation —
 * callers refuse the wait honestly rather than loosening the parse.
 */
export function parseOutcomeWaitPredicate(raw: unknown): OutcomeWaitPredicate | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  switch (r.type) {
    case "arrival": {
      if (r.source !== "gmail" && r.source !== "calendar") return null;
      const out: { v: 1; type: "arrival"; source: "gmail" | "calendar"; fromDomain?: string } = {
        v: 1, type: "arrival", source: r.source,
      };
      if (r.fromDomain !== undefined) {
        if (typeof r.fromDomain !== "string" || !DOMAIN_RE.test(r.fromDomain)) return null;
        out.fromDomain = r.fromDomain.toLowerCase();
      }
      if (out.source === "gmail" && out.fromDomain === undefined) return null; // gmail arrival needs a sender scope
      return out;
    }
    case "state_change": {
      if (r.entity !== "outcome") return null;
      if (r.outcomeRef !== undefined && (typeof r.outcomeRef !== "string" || !/^[A-Z0-9]{2,8}$/.test(r.outcomeRef))) return null;
      if (r.toStatus !== undefined && (typeof r.toStatus !== "string" || !OUTCOME_STATUSES.has(r.toStatus))) return null;
      if (r.outcomeRef === undefined && r.toStatus === undefined) return null;
      return {
        v: 1, type: "state_change", entity: "outcome",
        ...(r.outcomeRef !== undefined ? { outcomeRef: r.outcomeRef } : {}),
        ...(r.toStatus !== undefined ? { toStatus: r.toStatus } : {}),
      };
    }
    case "absence_past": {
      if (r.subject !== "commitment" && r.subject !== "reminder" && r.subject !== "outcome") return null;
      if (typeof r.olderThanHours !== "number" || !Number.isFinite(r.olderThanHours) || r.olderThanHours <= 0) return null;
      return { v: 1, type: "absence_past", subject: r.subject, olderThanHours: r.olderThanHours };
    }
    case "threshold": {
      if (r.metric !== "outcome_spend_usd") return null;
      if (typeof r.gt !== "number" || !Number.isFinite(r.gt) || r.gt < 0) return null;
      return { v: 1, type: "threshold", metric: "outcome_spend_usd", gt: r.gt };
    }
    default:
      return null;
  }
}

/**
 * Event-matcher for the resume router. Pure over the canonical event
 * envelope — no DB access (content-level matching, e.g. sender addresses
 * from gmail_messages, is a D4 grounded-predicate concern, documented in
 * the roadmap).
 */
export function predicateMatchesEvent(
  predicate: OutcomeWaitPredicate,
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  switch (predicate.type) {
    case "arrival": {
      if (eventType !== "gmail.message.received" && eventType !== "calendar.event.created" && eventType !== "calendar.event.updated") {
        return false;
      }
      if (predicate.source === "gmail") {
        if (eventType !== "gmail.message.received") return false;
        if (predicate.fromDomain !== undefined && payload.fromDomain !== predicate.fromDomain) return false;
        return true;
      }
      // calendar arrival: any created/updated event matches (V1 has no
      // per-event filter — calendar-change noise gates live sensor-side).
      return eventType === "calendar.event.created" || eventType === "calendar.event.updated";
    }
    case "state_change": {
      if (eventType !== "outcome.status_changed") return false;
      if (predicate.toStatus !== undefined && payload.toStatus !== predicate.toStatus) return false;
      if (predicate.outcomeRef !== undefined && payload.ref !== predicate.outcomeRef) return false;
      return true;
    }
    case "absence_past":
    case "threshold":
      // Poll-evaluated lanes (W0 / D1). The router must never be asked —
      // wait creation refuses these types (fail closed, no silent waits).
      return false;
  }
}
