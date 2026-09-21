// W5(d) — plan divergence v1 (plan §7 W5(d); invariant §5-7, R1). Calendar
// status is Google's BELIEF and time passing is never evidence of
// occurrence: same-day calendar mutations are reported as PLAN CHURN —
// what changed in the plan — never as verified fact about the day. The
// rendered block is honesty-pinned: the words "happened"/"occurred" may
// appear ONLY inside the sanctioned caveat "what actually happened is
// unverified" (test pins this).
//
// Churn semantics reuse calendar/sync.ts's notions (E4-S disruptive-change
// filter): only start_end_changed ("moved") and cancelled observations
// count — attendees/summary edits change content_hash but are not plan
// divergence in v1. An observation counts when it landed inside the
// mutation window [windowStart, now] AND the event it names belonged to
// the civil day being closed (its previous OR new start fell inside the
// day — a block moved off the day still churned). Suppression (§31): a
// quiet day returns null and the caller renders nothing.
//
// plannedCount is the day's block set: non-cancelled projection rows
// starting in the day, union the churned events' google ids (a cancelled
// row keeps a nulled start; a moved-away row now starts outside the day —
// both were on the day's plan).

import { parseDateInput, type QueryExecutor } from "../queries/executor.js";
import { localDayBounds } from "../calendar/projection.js";
import { BRIEF_TIMEZONE } from "./timezone.js";

/** Structural DB slice. */
export type DivergenceDb = QueryExecutor;

/** The calendar sensor is v1 personal-domain only (same scope as sync). */
export const DIVERGENCE_DOMAIN_KEY = "personal";

export type DivergenceChangeKind = "moved" | "cancelled";

export interface DivergenceItem {
  readonly googleEventId: string;
  /** Event title; "(untitled)" when Google sent an empty summary. */
  readonly title: string;
  readonly changeKind: DivergenceChangeKind;
}

export interface DivergenceResult {
  /** Owner-local civil date (YYYY-MM-DD) of the day being closed. */
  readonly day: string;
  /** Distinct blocks moved or cancelled same-day. */
  readonly churnedCount: number;
  /** Blocks that were on the day's plan (remaining + churned). */
  readonly plannedCount: number;
  readonly items: readonly DivergenceItem[];
}

export interface PlanDivergenceOptions {
  /** Evaluation instant: scan upper bound + civil-day reference. */
  readonly now: Date | (() => Date);
  /** Exclusive mutation-scan lower bound (the evening close passes the day start). */
  readonly windowStart: Date | string;
  readonly domainId?: string;
}

/** One calendar observation event's payload slice (sync.ts payload shape). */
export interface CalendarObservation {
  readonly changeClass: string;
  readonly googleEventId: string;
  readonly summary: string;
  readonly start: string | null;
  readonly previousStart: string | null;
}

const OBSERVATIONS_SQL = `
  SELECT ev.payload
  FROM events ev
  JOIN domains dom ON dom.id = ev.domain_id
  WHERE dom.key = $1
    AND ev.type IN ('calendar.event.updated', 'calendar.event.cancelled')
    AND GREATEST(ev.occurred_at, ev.recorded_at) > $2::timestamptz
    AND GREATEST(ev.occurred_at, ev.recorded_at) <= $3::timestamptz
  ORDER BY GREATEST(ev.occurred_at, ev.recorded_at) ASC, ev.id ASC
`;

function civilDateOf(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRIEF_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function toObservation(payload: Record<string, unknown>): CalendarObservation {
  return {
    changeClass: String(payload["changeClass"] ?? ""),
    googleEventId: String(payload["googleEventId"] ?? ""),
    summary: typeof payload["summary"] === "string" ? payload["summary"] : "",
    start: typeof payload["start"] === "string" ? payload["start"] : null,
    previousStart: typeof payload["previousStart"] === "string" ? payload["previousStart"] : null,
  };
}

function inDay(start: string | null, dayStart: number, dayEnd: number): boolean {
  if (start === null) return false;
  const instant = Date.parse(start);
  return Number.isFinite(instant) && instant >= dayStart && instant < dayEnd;
}

/**
 * PURE churn classifier over one civil day's observation payloads
 * (ordered oldest → newest; the latest observation of a google event
 * wins). Disruptive classes only (moved | cancelled); the event belongs
 * to the day when its previous OR new start fell inside [dayStart,
 * dayEnd). Returns items in observation order, deduped by google event.
 */
export function churnFromObservations(
  observations: readonly CalendarObservation[],
  dayBounds: { dayStart: number; dayEnd: number },
): DivergenceItem[] {
  const byGoogleId = new Map<string, DivergenceItem>();
  for (const obs of observations) {
    if (obs.googleEventId.length === 0) continue;
    const changeKind: DivergenceChangeKind | null =
      obs.changeClass === "start_end_changed"
        ? "moved"
        : obs.changeClass === "cancelled"
          ? "cancelled"
          : null;
    if (changeKind === null) continue; // attendees_changed/updated: not plan divergence v1
    const relevant =
      changeKind === "moved"
        ? [obs.start, obs.previousStart]
        : [obs.previousStart, obs.start];
    if (!relevant.some((start) => inDay(start, dayBounds.dayStart, dayBounds.dayEnd))) continue;
    byGoogleId.set(obs.googleEventId, {
      googleEventId: obs.googleEventId,
      title: obs.summary.length > 0 ? obs.summary : "(untitled)",
      changeKind,
    });
  }
  return [...byGoogleId.values()];
}

/**
 * Same-day plan churn for the civil day of `now`; null when nothing
 * churned (suppression — the caller says nothing).
 */
export async function planDivergence(
  db: DivergenceDb,
  opts: PlanDivergenceOptions,
): Promise<DivergenceResult | null> {
  const now = opts.now instanceof Date ? opts.now : opts.now();
  const windowStart = parseDateInput(opts.windowStart, "windowStart");
  if (windowStart.getTime() > now.getTime()) {
    throw new RangeError("planDivergence: windowStart must not be after now");
  }
  const { dayStart, dayEnd } = localDayBounds(now, BRIEF_TIMEZONE);
  const day = civilDateOf(now);

  const rows = await db.query(OBSERVATIONS_SQL, [
    opts.domainId ?? DIVERGENCE_DOMAIN_KEY,
    windowStart.toISOString(),
    now.toISOString(),
  ]);
  const observations = rows.rows.map((row) =>
    toObservation((row.payload ?? {}) as Record<string, unknown>),
  );
  const items = churnFromObservations(observations, {
    dayStart: dayStart.getTime(),
    dayEnd: dayEnd.getTime(),
  });
  if (items.length === 0) return null;

  // The day's block set: non-cancelled rows starting in the day, plus the
  // churned google ids that left that set (cancelled rows null their
  // start; moved-away rows start outside the day).
  const [remaining, churnedOnPlan] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS n FROM calendar_events
        WHERE start_time >= $1::timestamptz AND start_time < $2::timestamptz
          AND status <> 'cancelled'`,
      [dayStart.toISOString(), dayEnd.toISOString()],
    ),
    db.query(
      `SELECT count(*)::int AS n FROM calendar_events
        WHERE google_event_id = ANY($1::text[])
          AND NOT (start_time >= $2::timestamptz AND start_time < $3::timestamptz
                   AND status <> 'cancelled')`,
      [items.map((item) => item.googleEventId), dayStart.toISOString(), dayEnd.toISOString()],
    ),
  ]);
  const plannedCount =
    Number(remaining.rows[0]?.n ?? 0) + Number(churnedOnPlan.rows[0]?.n ?? 0);

  return {
    day,
    churnedCount: items.length,
    plannedCount: Math.max(plannedCount, items.length),
    items,
  };
}

/** How many churn items the block lists before "…and N more". */
export const DIVERGENCE_ITEM_LIMIT = 5;

/**
 * The honesty-pinned plan-churn block (pure). PLAN wording only: churn is
 * a fact about the PLAN (the event log observed the mutations); what
 * actually happened to the day is explicitly unverified. "happened" /
 * "occurred" appear ONLY inside the sanctioned caveat — pinned by test.
 */
export function renderDivergenceBlock(result: DivergenceResult): string[] {
  const lines = [
    "Plan churn",
    `- ${result.churnedCount} of ${result.plannedCount} blocks moved or cancelled same-day. That's plan divergence — what actually happened is unverified.`,
  ];
  for (const item of result.items.slice(0, DIVERGENCE_ITEM_LIMIT)) {
    lines.push(`- ${item.title} — ${item.changeKind}`);
  }
  if (result.items.length > DIVERGENCE_ITEM_LIMIT) {
    lines.push(`- …and ${result.items.length - DIVERGENCE_ITEM_LIMIT} more`);
  }
  return lines;
}
