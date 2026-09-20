import { BRIEF_TIMEZONE } from "../briefs/timezone.js";
import { resolveDayBounds } from "./read-tools.js";

// ------------------------------------------------------------- constants

/** Deterministic ask-for-time reply — the flow never invents a default time. */
export const PROPOSE_CLARIFICATION_TIME =
  "What time should I put it at? Reply like: at 7pm.";

/** Duration fallback when the extraction carries none (contract minutes). */
export const PROPOSE_DEFAULT_DURATION_MINUTES = 60;

// ------------------------------------------------------------- parsing

/** Strict wall-clock parse ("7", "7pm", "7:30 pm", "7Pm", "19:00", "09:00"); null = unparsable. */
export function parseWallClock(text: string): { hour: number; minute: number } | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 8) return null;
  const bare = bareHourOf(trimmed);
  if (bare !== null) return { hour: bare, minute: 0 };
  const meridiem = /^(\d{1,2})(?::(\d{2}))?\s?(am|pm)$/i.exec(trimmed);
  if (meridiem !== null) {
    const hour = Number(meridiem[1]);
    const minute = meridiem[2] === undefined ? 0 : Number(meridiem[2]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = meridiem[3]?.toLowerCase() === "pm";
    const resolved = hour === 12 ? (pm ? 12 : 0) : pm ? hour + 12 : hour;
    return { hour: resolved, minute };
  }
  const clock24 = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (clock24 !== null) {
    const hour = Number(clock24[1]);
    const minute = Number(clock24[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

/** Bare-hour form ("7", "23") as a 0-23 hour; null when the text is not one. */
function bareHourOf(trimmed: string): number | null {
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const hour = Number(trimmed);
  return hour <= 23 ? hour : null;
}

// ------------------------------------------------------------- wall-time instants

function offsetMinutesAt(instant: number): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: BRIEF_TIMEZONE, timeZoneName: "longOffset" })
      .formatToParts(new Date(instant))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (m === null) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/** Civil wall time → instant; ambiguous → first occurrence, gap → shifted instant. */
function wallTimeToInstant(
  year: number,
  month: number,
  dayOfMonth: number,
  hour: number,
  minute: number,
): Date {
  const wallUtc = Date.UTC(year, month - 1, dayOfMonth, hour, minute, 0, 0);
  const before = offsetMinutesAt(wallUtc - 24 * 60 * 60 * 1000);
  const after = offsetMinutesAt(wallUtc + 24 * 60 * 60 * 1000);
  const first = wallUtc - before * 60_000;
  const second = wallUtc - after * 60_000;
  if (offsetMinutesAt(first) === before) return new Date(first);
  if (offsetMinutesAt(second) === after) return new Date(second);
  return new Date(first);
}

/** Civil date parts of a YYYY-MM-DD string (from resolveDayBounds). */
function civilDateOf(dateIso: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (m === null) throw new Error(`propose-schedule: bad dateIso ${dateIso}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Next civil calendar date (pure Date.UTC arithmetic, no timezone math). */
function nextCivilDate(d: { year: number; month: number; day: number }): {
  year: number;
  month: number;
  day: number;
} {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Civil date (YYYY-MM-DD) of an instant in BRIEF_TIMEZONE. */
function dayIsoOf(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRIEF_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

// ------------------------------------------------------------- resolution

export interface ResolveProposedScheduleInput {
  readonly day: "today" | "tomorrow";
  readonly time: string | null;
  readonly endTime: string | null;
  readonly durationMinutes: number | null;
}

export type ResolvedProposedSchedule =
  | { readonly ok: true; readonly startIso: string; readonly endIso: string; readonly dateIso: string }
  | { readonly ok: false; readonly reason: "time-missing" | "time-unparsable" | "end-unparsable" | "range-invalid" };

/**
 * Resolve the propose flow's day + wall-clock string to absolute ISO instants
 * in BRIEF_TIMEZONE; bare hours resolve to their next occurrence (am or pm,
 * whichever is future and sooner; both past → tomorrow's am hour).
 */
export function resolveProposedSchedule(
  input: ResolveProposedScheduleInput,
  now: Date,
): ResolvedProposedSchedule {
  if (input.time === null) return { ok: false, reason: "time-missing" };
  const parsed = parseWallClock(input.time);
  if (parsed === null) return { ok: false, reason: "time-unparsable" };
  const anchor = civilDateOf(resolveDayBounds(input.day, now).dateIso);
  const isBare = bareHourOf(input.time.trim()) !== null;
  let start = isBare
    ? nextBareHourOccurrence(anchor, parsed.hour, now)
    : wallTimeToInstant(anchor.year, anchor.month, anchor.day, parsed.hour, parsed.minute);
  // Verifier fix (11pm asymmetry): a PINNED wall time on "today" that is
  // already past rolls to tomorrow's same wall time — bare hours roll by
  // construction. DST note: +24h on the INSTANT keeps elapsed duration
  // exact; the render shows the civil time honestly either way.
  if (!isBare && input.day === "today" && start.getTime() <= now.getTime()) {
    start = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  }
  let durationMinutes = input.durationMinutes ?? PROPOSE_DEFAULT_DURATION_MINUTES;
  if (input.endTime != null) {
    const parsedEnd = parseWallClock(input.endTime);
    if (parsedEnd === null) return { ok: false, reason: "end-unparsable" };
    let endInstant = wallTimeToInstant(
      anchor.year,
      anchor.month,
      anchor.day,
      parsedEnd.hour,
      parsedEnd.minute,
    );
    if (endInstant.getTime() <= start.getTime()) {
      // Overnight range ("9pm to 2am") — roll the end past midnight.
      endInstant = new Date(endInstant.getTime() + 24 * 60 * 60 * 1000);
    }
    const derived = Math.round((endInstant.getTime() - start.getTime()) / 60_000);
    if (derived < 15 || derived > 720) return { ok: false, reason: "range-invalid" };
    durationMinutes = derived;
  }
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return {
    ok: true,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dateIso: dayIsoOf(start),
  };
}

/** Next occurrence of a bare hour's candidate wall times (h∈1-12 am/pm; 0/13-23 single). */
function nextBareHourOccurrence(
  anchor: { year: number; month: number; day: number },
  hour: number,
  now: Date,
): Date {
  const amHour = hour % 12;
  const ambiguous = hour >= 1 && hour <= 12;
  const candidates = (ambiguous ? [amHour, hour === 12 ? 12 : hour + 12] : [hour])
    .map((h) => wallTimeToInstant(anchor.year, anchor.month, anchor.day, h, 0))
    .filter((t) => t.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  const soonest = candidates[0];
  if (soonest !== undefined) return soonest;
  const next = nextCivilDate(anchor);
  return wallTimeToInstant(next.year, next.month, next.day, ambiguous ? amHour : hour, 0);
}
