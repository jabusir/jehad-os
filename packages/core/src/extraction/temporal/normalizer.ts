/**
 * Deterministic temporal normalizer (extraction v3; owner temporal directive
 * 2026-09-17).
 *
 * The LLM extracts the temporal EXPRESSION verbatim; THIS module resolves it.
 * Pure TypeScript, no model, no new dependencies — timezone math goes through
 * Intl only. Unknown is better than confidently wrong: ambiguous expressions
 * resolve to null + status, never a guessed date.
 *
 * DST safety: all arithmetic happens on civil calendar dates (year/month/day
 * integers projected through the anchor timezone), never on wall-clock
 * instants — a lost or gained hour cannot shift a resolved date. The single
 * instant-conversion step (civilToUtcInstant) uses the standard two-pass
 * offset method so a midnight deadline lands at midnight in the anchor
 * timezone on both sides of a DST transition.
 */

import type { TemporalProvenance } from "../../memory/candidate-contract.js";

/** Bumped when any resolution rule changes; stored per commitment (renormalizable). */
export const NORMALIZER_VERSION = "temporal-norm-v1";

/** Default anchor timezone; overridable via JEHAD_TZ (documented in proposal.ts). */
export const DEFAULT_ANCHOR_TIMEZONE = "UTC";

export class TemporalNormalizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemporalNormalizerError";
  }
}

export interface TemporalNormalizerInput {
  /** Verbatim temporal phrase from the text, or null when none was extracted. */
  readonly expression: string | null;
  /** ISO instant the expression resolves against (the event's occurredAt). */
  readonly anchorTime: string;
  readonly anchorTimezone: string;
}

interface CivilDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

interface RuleMatch {
  /** Named resolution method recorded in provenance (audit + renormalize). */
  readonly method: string;
  readonly date: CivilDate;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;
/** Undated hedges: recognized on purpose, never resolved (status ambiguous). */
const VAGUE_MARKERS = [
  "sometime",
  "soon",
  "when i get to it",
  "when i get a chance",
  "when i can",
  "eventually",
  "at some point",
  "next chance",
] as const;
const LATER_TODAY = [
  "later today",
  "this afternoon",
  "this evening",
  "tonight",
  "end of day",
  "eod",
] as const;

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = dateFormatterCache.get(tz);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    } catch {
      throw new TemporalNormalizerError(`invalid anchor timezone "${tz}"`);
    }
    dateFormatterCache.set(tz, fmt);
  }
  return fmt;
}

/** Anchor instant → civil date/time in the anchor timezone (DST-correct). */
function civilFromInstant(instant: Date, tz: string): CivilDate & { hour: number; minute: number; second: number } {
  const parts = dateFormatter(tz).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) {
      throw new TemporalNormalizerError(`timezone formatter produced no ${type}`);
    }
    return Number(part.value.replace(/\D/g, ""));
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // hourCycle quirks: 24 for midnight in some locales
    minute: get("minute"),
    second: get("second"),
  };
}

function toEpochDay(c: CivilDate): number {
  return Math.round(Date.UTC(c.year, c.month - 1, c.day) / DAY_MS);
}

function fromEpochDay(epochDay: number): CivilDate {
  const d = new Date(epochDay * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday, for the civil (calendar) date. */
function weekdayOf(c: CivilDate): number {
  return new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoOf(c: CivilDate): string {
  return `${c.year}-${pad2(c.month)}-${pad2(c.day)}`;
}

function isValidCivil(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  );
}

function addDays(c: CivilDate, days: number): CivilDate {
  return fromEpochDay(toEpochDay(c) + days);
}

/** Next occurrence of `weekday` STRICTLY after the anchor date. */
function nextWeekdayAfter(c: CivilDate, weekday: number): CivilDate {
  let d = c;
  do {
    d = addDays(d, 1);
  } while (weekdayOf(d) !== weekday);
  return d;
}

/** First occurrence of `weekday` on or after the anchor date (this weekend/end of week). */
function weekdayOnOrAfter(c: CivilDate, weekday: number): CivilDate {
  let d = c;
  while (weekdayOf(d) !== weekday) {
    d = addDays(d, 1);
  }
  return d;
}

/** Monday of the ISO week the anchor date belongs to. */
function mondayOf(c: CivilDate): CivilDate {
  return addDays(c, -((weekdayOf(c) + 6) % 7));
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Civil date in `tz` → UTC instant at that civil midnight (two-pass offset
 * solve: correct on both sides of a DST transition).
 */
export function civilToUtcInstant(c: CivilDate, tz: string): string {
  const guess = Date.UTC(c.year, c.month - 1, c.day, 0, 0, 0);
  const offsetAt = (utcMs: number): number => {
    const civil = civilFromInstant(new Date(utcMs), tz);
    const asUtc = Date.UTC(
      civil.year,
      civil.month - 1,
      civil.day,
      civil.hour,
      civil.minute,
      civil.second,
    );
    return asUtc - utcMs;
  };
  const offset1 = offsetAt(guess);
  let target = guess - offset1;
  const offset2 = offsetAt(target);
  if (offset2 !== offset1) target = guess - offset2;
  return new Date(target).toISOString();
}

/** normalizedTime (YYYY-MM-DD) in `tz` → UTC instant string (writer due_at). */
export function normalizedTimeToInstant(normalizedTime: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizedTime);
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isValidCivil(year, month, day)) return null;
  return civilToUtcInstant({ year, month, day }, tz);
}

function normalizeExpression(expression: string): string {
  return expression
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(by|on|before|until|till|no later than) /, "");
}

/** "April 15" → next future occurrence, rolling the year (Feb 29 rolls to the next leap year). */
function monthDayMatch(text: string, anchor: CivilDate): RuleMatch | null {
  for (let i = 0; i < MONTHS.length; i += 1) {
    const month = MONTHS[i]!;
    const short = month.slice(0, 3);
    const m = new RegExp(`\\b(${month}|${short})\\.? (\\d{1,2})\\b`).exec(text);
    if (m === null) continue;
    const day = Number(m[2]);
    if (day < 1 || day > 31) return null;
    for (let year = anchor.year; year <= anchor.year + 8; year += 1) {
      if (!isValidCivil(year, i + 1, day)) continue;
      const candidate: CivilDate = { year, month: i + 1, day };
      if (toEpochDay(candidate) > toEpochDay(anchor)) {
        return { method: "month-day", date: candidate };
      }
    }
    return null;
  }
  return null;
}

/**
 * Ordered rule pipeline over the normalized expression. First deterministic
 * match wins; every rule match carries resolutionConfidence 1.0 — ambiguity
 * is expressed via status, never via fake confidence.
 */
function matchRule(text: string, anchor: CivilDate): RuleMatch | "ambiguous" | null {
  // 1. explicit-iso: calendar-native passthrough (validated real date).
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso !== null) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (isValidCivil(year, month, day)) {
      return { method: "explicit-iso", date: { year, month, day } };
    }
    return null; // ISO-shaped but impossible (e.g. 2026-02-30) → unsupported
  }

  // 2. vague hedges — recognized, never resolved.
  for (const marker of VAGUE_MARKERS) {
    if (text.includes(marker)) return "ambiguous";
  }

  // 2b. day-ambiguous qualifiers on week phrases: "early/late next week"
  // pins no specific day — preserve ambiguity (owner directive).
  if (/\b(early|late) (next|this|last) week\b/.test(text)) return "ambiguous";

  // 3. same-day references.
  if (LATER_TODAY.includes(text as (typeof LATER_TODAY)[number])) {
    return { method: "later-today", date: anchor };
  }
  if (text === "today") return { method: "today", date: anchor };
  // "tomorrow morning/afternoon/evening/night" — time-of-day is noise at
  // date granularity; the date is still tomorrow.
  if (/^(tomorrow|tmrw)\b/.test(text)) {
    return { method: "tomorrow", date: addDays(anchor, 1) };
  }

  // 4. "next <weekday>" — the week AFTER the upcoming one.
  for (let i = 0; i < WEEKDAYS.length; i += 1) {
    if (new RegExp(`\\bnext ${WEEKDAYS[i]!}\\b`).test(text)) {
      return { method: "next-weekday", date: addDays(nextWeekdayAfter(anchor, i), 7) };
    }
  }

  // 5. bare weekday — next occurrence strictly after the anchor.
  for (let i = 0; i < WEEKDAYS.length; i += 1) {
    if (new RegExp(`\\b${WEEKDAYS[i]!}\\b`).test(text)) {
      return { method: "weekday", date: nextWeekdayAfter(anchor, i) };
    }
  }

  // 6. "in N days/weeks" — digits or word numbers ("in two weeks").
  const inN = /\bin (a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+) (day|week)s?\b/.exec(text);
  if (inN !== null) {
    const wordNums: Record<string, number> = {
      a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    };
    const n = /^\d+$/.test(inN[1]!) ? Number(inN[1]) : (wordNums[inN[1]!] ?? 0);
    if (n > 0) {
      const days = inN[2] === "week" ? n * 7 : n;
      return { method: inN[2] === "week" ? "in-n-weeks" : "in-n-days", date: addDays(anchor, days) };
    }
  }

  // 6b. "within N days/weeks" / "within a week" — deadline framing, same math.
  const withinN = /\bwithin (a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+) (day|week)s?\b/.exec(text);
  if (withinN !== null) {
    const wordNums: Record<string, number> = {
      a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    };
    const n = /^\d+$/.test(withinN[1]!) ? Number(withinN[1]) : (wordNums[withinN[1]!] ?? 0);
    if (n > 0) {
      const days = withinN[2] === "week" ? n * 7 : n;
      return { method: `within-n-${withinN[2] === "week" ? "weeks" : "days"}`, date: addDays(anchor, days) };
    }
  }

  // 7. this weekend — the coming Saturday (today counts when it IS Saturday).
  if (/\bweekend\b/.test(text)) {
    return { method: "this-weekend", date: weekdayOnOrAfter(anchor, 6) };
  }

  // 8. next week — Monday of next week.
  if (/\bnext week\b/.test(text)) {
    return { method: "next-week", date: addDays(mondayOf(anchor), 7) };
  }

  // 9. end of week — the coming Friday (today counts when it IS Friday).
  if (/\bend of (the )?week\b|\beow\b/.test(text)) {
    return { method: "end-of-week", date: weekdayOnOrAfter(anchor, 5) };
  }

  // 10. end of month — last civil day of the anchor month.
  if (/\bend of (the )?month\b/.test(text)) {
    return {
      method: "end-of-month",
      date: { year: anchor.year, month: anchor.month, day: lastDayOfMonth(anchor.year, anchor.month) },
    };
  }

  // 11. month-day ("April 15") — next future occurrence, rolling the year.
  return monthDayMatch(text, anchor);
}

/**
 * Resolves one extracted temporal expression against its anchor. Pure: same
 * (expression, anchorTime, anchorTimezone) always yields the same provenance.
 */
export function normalizeTemporalExpression(input: TemporalNormalizerInput): TemporalProvenance {
  const base = {
    rawExpression:
      typeof input.expression === "string" && input.expression.trim().length > 0
        ? input.expression.trim()
        : null,
    anchorTime: input.anchorTime,
    anchorTimezone: input.anchorTimezone,
    normalizerVersion: NORMALIZER_VERSION,
  };

  const anchorInstant = new Date(input.anchorTime);
  if (Number.isNaN(anchorInstant.getTime())) {
    throw new TemporalNormalizerError(`invalid anchorTime "${input.anchorTime}"`);
  }
  // Timezone validity is enforced here (Intl throws on garbage) — fail loud,
  // never silently fall back to a wrong zone.
  const anchor = civilFromInstant(anchorInstant, input.anchorTimezone);
  const anchorDate: CivilDate = { year: anchor.year, month: anchor.month, day: anchor.day };

  if (base.rawExpression === null) {
    return {
      ...base,
      normalizedTime: null,
      resolutionStatus: "none",
      resolutionConfidence: 0,
      resolutionMethod: null,
    };
  }

  const match = matchRule(normalizeExpression(base.rawExpression), anchorDate);
  if (match === "ambiguous") {
    return {
      ...base,
      normalizedTime: null,
      resolutionStatus: "ambiguous",
      resolutionConfidence: 1,
      resolutionMethod: "vague",
    };
  }
  if (match === null) {
    return {
      ...base,
      normalizedTime: null,
      resolutionStatus: "unsupported",
      resolutionConfidence: 0,
      resolutionMethod: null,
    };
  }
  return {
    ...base,
    normalizedTime: isoOf(match.date),
    resolutionStatus: "resolved",
    resolutionConfidence: 1,
    resolutionMethod: match.method,
  };
}
