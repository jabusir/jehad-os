// Reminder lifecycle (W6 phase 2) — the PURE lane: scheduling math, state
// transitions, and touch/ack templates for armed reminders. No DB, no LLM,
// no I/O, no wall-clock reads: every function that needs time takes `now`
// (or a concrete instant) as a parameter, so the worker/data lanes own the
// clock and tests pin exact Dates.
//
// DST safety: wall-clock times are constructed through the policy timezone
// with the two-pass offset solve (the technique of the extraction
// normalizer's civilToUtcInstant, generalized from civil midnight to
// arbitrary hour/minute), and day arithmetic happens on CIVIL calendar
// dates — a lost or gained hour can never shift a scheduled touch.
//
// Grammar note: resolveWhenWords mirrors the capture lane's deterministic
// weekday/tomorrow resolver (extraction/temporal/normalizer.ts, wired
// through imessage/turn-interpretation.ts). Those helpers are
// module-private there and the public normalizer is date-only (no
// time-of-day, no relative hours), so the small overlap (preposition
// stripping, strictly-after weekday, BRIEF_TIMEZONE anchor) is
// re-implemented here; turn-interpretation.ts is NOT edited.

import { BRIEF_TIMEZONE } from "../briefs/timezone.js";

export type TouchKind = "morning" | "probe" | "nudge";

export interface ReminderPolicy {
  timeZone: string;
  workdayStartHour: number;
  probeTime: { hour: number; minute: number };
  probeOffsetHours: number;
  probeLatestHour: number;
  quietStartHour: number;
  quietEndHour: number;
  nudgeCap: number;
}

/** Owner defaults — tz matches the briefs lane's DST-safe convention. */
export const REMINDER_POLICY: ReminderPolicy = {
  timeZone: BRIEF_TIMEZONE,
  workdayStartHour: 9,
  probeTime: { hour: 15, minute: 30 },
  probeOffsetHours: 3,
  probeLatestHour: 20,
  quietStartHour: 22,
  quietEndHour: 7,
  nudgeCap: 2,
};

// -------------------------------------------------------------------
// Timezone machinery (pure; Intl only; two-pass DST-safe construction)
// -------------------------------------------------------------------

interface WallClock {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number;
  readonly minute: number;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

/** Instant → civil wall clock in `tz` (DST-correct). */
function wallClockOf(instant: Date, tz: string): WallClock {
  const parts = tzFormatter(tz).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) throw new Error(`timezone "${tz}" formatter produced no ${type}`);
    return Number(part.value.replace(/\D/g, ""));
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // hourCycle quirk: 24 for midnight in some engines
    minute: get("minute"),
  };
}

/**
 * Civil wall clock in `tz` → instant (two-pass offset solve: correct on
 * both sides of a DST transition; a nonexistent local time lands just
 * after the gap, an ambiguous one on its first occurrence).
 */
function instantOfWallClock(w: WallClock, tz: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const offsetAt = (utcMs: number): number => {
    const c = wallClockOf(new Date(utcMs), tz);
    return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute) - utcMs;
  };
  const offset1 = offsetAt(guess);
  let target = guess - offset1;
  const offset2 = offsetAt(target);
  if (offset2 !== offset1) target = guess - offset2;
  return new Date(target);
}

// ---------------------------------------------------------------
// Civil-date helpers (calendar arithmetic, never instant + 24h)
// ---------------------------------------------------------------

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function dateIsoOf(c: CivilDate): string {
  return `${c.year}-${pad2(c.month)}-${pad2(c.day)}`;
}

function parseDateIso(dateIso: string, label = "date"): CivilDate {
  const m = DATE_RE.exec(dateIso);
  if (m === null) throw new Error(`${label} must be "YYYY-MM-DD", got "${dateIso}"`);
  const civil = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const check = new Date(Date.UTC(civil.year, civil.month - 1, civil.day));
  if (
    check.getUTCFullYear() !== civil.year ||
    check.getUTCMonth() !== civil.month - 1 ||
    check.getUTCDate() !== civil.day
  ) {
    throw new Error(`${label} is not a real calendar date: "${dateIso}"`);
  }
  return civil;
}

function epochDayOf(c: CivilDate): number {
  return Math.round(Date.UTC(c.year, c.month - 1, c.day) / DAY_MS);
}

function civilFromEpochDay(epochDay: number): CivilDate {
  const d = new Date(epochDay * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function addDaysToIso(dateIso: string, days: number): string {
  return dateIsoOf(civilFromEpochDay(epochDayOf(parseDateIso(dateIso)) + days));
}

/** 0 = Sunday … 6 = Saturday, of the civil date itself. */
function weekdayOfIso(dateIso: string): number {
  const c = parseDateIso(dateIso);
  return new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();
}

/** Next occurrence of `weekday` STRICTLY after the civil date (capture grammar). */
function nextWeekdayAfterIso(dateIso: string, weekday: number): string {
  let iso = dateIso;
  do {
    iso = addDaysToIso(iso, 1);
  } while (weekdayOfIso(iso) !== weekday);
  return iso;
}

/** Weekday word of a civil date, computed at local noon (DST-proof). */
function weekdayNameOf(dateIso: string, tz: string): string {
  const c = parseDateIso(dateIso);
  const noon = instantOfWallClock({ ...c, hour: 12, minute: 0 }, tz);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(noon);
}

function civilTodayOf(now: Date, tz: string): string {
  return dateIsoOf(wallClockOf(now, tz));
}

// -------------------------------------------------------------------
// Policy application
// -------------------------------------------------------------------

function minutesOfDay(hour: number, minute: number): number {
  return hour * 60 + minute;
}

/** Quiet window is [quietStart, next-day quietEnd) — end exclusive. */
function isQuietHour(hour: number, policy: ReminderPolicy): boolean {
  return hour >= policy.quietStartHour || hour < policy.quietEndHour;
}

function atWallClock(dateIso: string, hour: number, minute: number, tz: string): Date {
  return instantOfWallClock({ ...parseDateIso(dateIso), hour, minute }, tz);
}

function atWorkdayStart(dateIso: string, policy: ReminderPolicy): Date {
  return atWallClock(dateIso, policy.workdayStartHour, 0, policy.timeZone);
}

// -------------------------------------------------------------------
// First touch
// -------------------------------------------------------------------

/** Fallback when every candidate moment is already past: now + 10 min. */
const FIRST_TOUCH_FALLBACK_MINUTES = 10;

/**
 * First touch for an armed reminder. With a dueTime the reminder touches at
 * that exact wall-clock time — unless it lands in the quiet window
 * [quietStart, next-day quietEnd), in which case it shifts to the NEXT
 * day's workdayStart and is flagged quietShifted. Without a dueTime the
 * touch is dueDate at workdayStart; when that moment is already past
 * ("remind me today" created at noon) it falls to the same-day probeTime,
 * or now + 10 minutes when even that is behind — and that fallback is
 * quiet-checked exactly like an explicit time. Pure: now is injected.
 */
export function computeFirstTouch(input: {
  dueDate: string;
  dueTime: { hour: number; minute: number } | null;
  now: Date;
  policy?: ReminderPolicy;
}): { at: Date; kind: "morning"; quietShifted: boolean } {
  const policy = input.policy ?? REMINDER_POLICY;
  const tz = policy.timeZone;
  parseDateIso(input.dueDate, "dueDate"); // fail loud on a malformed dueDate

  let candidate: Date;
  if (input.dueTime !== null) {
    candidate = atWallClock(input.dueDate, input.dueTime.hour, input.dueTime.minute, tz);
  } else {
    const morning = atWorkdayStart(input.dueDate, policy);
    if (morning.getTime() > input.now.getTime()) {
      candidate = morning;
    } else {
      const probe = atWallClock(
        input.dueDate,
        policy.probeTime.hour,
        policy.probeTime.minute,
        tz,
      );
      candidate =
        probe.getTime() > input.now.getTime()
          ? probe
          : new Date(input.now.getTime() + FIRST_TOUCH_FALLBACK_MINUTES * 60_000);
    }
  }

  if (isQuietHour(wallClockOf(candidate, tz).hour, policy)) {
    const shifted = addDaysToIso(civilTodayOf(candidate, tz), 1);
    return { at: atWorkdayStart(shifted, policy), kind: "morning", quietShifted: true };
  }
  return { at: candidate, kind: "morning", quietShifted: false };
}

// -------------------------------------------------------------------
// After-touch transitions
// -------------------------------------------------------------------

/**
 * What fires after an unanswered touch. morning → same-day probe (the
 * policy probeTime; a morning touch that landed LATER than probeTime
 * probes at touch + probeOffsetHours, capped at probeLatestHour). probe →
 * next-day nudge at workdayStart (pre-scheduled; resolution cancels). A
 * nudge re-nudges next day while escalations < nudgeCap - 1; at the cap
 * it returns null — the caller parks the reminder.
 */
export function scheduleAfterTouch(
  prev: { kind: TouchKind; at: Date; escalations: number },
  policy: ReminderPolicy = REMINDER_POLICY,
): { at: Date; kind: TouchKind } | null {
  const tz = policy.timeZone;
  if (prev.kind === "morning") {
    const wc = wallClockOf(prev.at, tz);
    const today = dateIsoOf(wc);
    if (minutesOfDay(wc.hour, wc.minute) <= minutesOfDay(policy.probeTime.hour, policy.probeTime.minute)) {
      return {
        at: atWallClock(today, policy.probeTime.hour, policy.probeTime.minute, tz),
        kind: "probe",
      };
    }
    const offset = wallClockOf(
      new Date(prev.at.getTime() + policy.probeOffsetHours * 3_600_000),
      tz,
    );
    const capped =
      offset.hour > policy.probeLatestHour
        ? { ...offset, hour: policy.probeLatestHour, minute: 0 }
        : offset;
    return { at: instantOfWallClock(capped, tz), kind: "probe" };
  }
  if (prev.kind === "probe") {
    return { at: atWorkdayStart(addDaysToIso(civilTodayOf(prev.at, tz), 1), policy), kind: "nudge" };
  }
  if (prev.escalations < policy.nudgeCap - 1) {
    return { at: atWorkdayStart(addDaysToIso(civilTodayOf(prev.at, tz), 1), policy), kind: "nudge" };
  }
  return null;
}

// -------------------------------------------------------------------
// Message templates (deterministic; terse chief-of-staff tone)
// -------------------------------------------------------------------

/**
 * Exact touch strings: morning carries the due word ("today" or a weekday
 * name); probe asks; nudge has exactly two variants (cap is 2) — the last
 * one names the "stop" exit. Anything else is a caller bug.
 */
export function touchMessage(
  kind: TouchKind,
  m: { title: string; escalations: number; dueWord: string },
): string {
  if (kind === "morning") return `Reminder: ${m.title} — ${m.dueWord}.`;
  if (kind === "probe") return `Did you get to ${m.title}?`;
  if (m.escalations <= 0) return `Still open: ${m.title}. Want to lock a time for it?`;
  return `Second nudge — ${m.title} is still open. Say "stop" and I'll park it.`;
}

/** Resolution acks — exact strings, persistence-truthful by convention. */
export function movedAck(dueWord: string): string {
  return `Moved to ${dueWord} — I'll check back then.`;
}

export function doneAck(title: string): string {
  return `Marked done — ${title}.`;
}

export function parkedAck(title: string): string {
  return `Parked — I'll stop texting about ${title}.`;
}

export function quietShiftedAck(): string {
  return `That lands in quiet hours — I'll text at 9:00 AM instead.`;
}

/** Probe answered with a no-date deferral — the nudge is already pre-scheduled. */
export function deferredAck(): string {
  return `Got it — I'll check back tomorrow morning.`;
}

/**
 * The capture-time promise: what the ack says about the first touch.
 * quiet-shifted → the quiet-shift line; explicit time → "I'll text you at
 * H:MM AM/PM."; fuzzy today → afternoon; else "<weekday> morning".
 */
export function firstTouchPromise(
  firstTouch: { at: Date; quietShifted: boolean },
  m: { dueTime: { hour: number; minute: number } | null; dueWord: string },
): string {
  if (firstTouch.quietShifted) return quietShiftedAck();
  if (m.dueTime !== null) {
    const h12 = m.dueTime.hour % 12 === 0 ? 12 : m.dueTime.hour % 12;
    const mm = String(m.dueTime.minute).padStart(2, "0");
    const suffix = m.dueTime.hour < 12 ? "AM" : "PM";
    return `I'll text you at ${h12}:${mm} ${suffix}.`;
  }
  if (m.dueWord === "today") return "I'll text you this afternoon.";
  return `I'll text you ${m.dueWord} morning.`;
}

// -------------------------------------------------------------------
// When-words → due (same grammar as capture, plus time-of-day)
// -------------------------------------------------------------------

const WEEKDAY_WORDS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const WHEN_TIME = "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?";
const WHEN_IN_N = /^in (\d+) (hours?|hrs?|minutes?|mins?)$/;
const WHEN_AT = new RegExp(`^at ${WHEN_TIME}$`);
const WHEN_COMBINED = new RegExp(
  `^(today|tonight|tomorrow|${WEEKDAY_WORDS.join("|")}) at ${WHEN_TIME}$`,
);
const WHEN_BARE = /^(today|tonight|tomorrow|this afternoon)$/;
const WHEN_WEEKDAY = new RegExp(`^(${WEEKDAY_WORDS.join("|")})$`);

/** "3pm" / "3:15pm" / "15:00" → {hour, minute}; out-of-range → null. */
function parseWhenTime(h: string, m: string | undefined, meridiem: string | undefined): {
  hour: number;
  minute: number;
} | null {
  const hour = Number(h);
  const minute = m === undefined ? 0 : Number(m);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (meridiem === undefined) return hour >= 0 && hour <= 23 ? { hour, minute } : null;
  if (hour < 1 || hour > 12) return null;
  return { hour: (hour % 12) + (meridiem === "pm" ? 12 : 0), minute };
}

/**
 * Deterministic when-words resolution against `now` in the policy
 * timezone: today / tomorrow / bare weekday (next occurrence STRICTLY
 * after today) / tonight (20:00) / this afternoon (probeTime) / explicit
 * "at 3pm"-style times, combinable ("tomorrow at 9am"), and relative
 * "in N hours|minutes" (projected back to the local wall clock). Leading
 * capture prepositions ("by/on/before/until/till") are stripped. Anything
 * unparseable — including the bare word "stop", which is the parking verb
 * handled elsewhere — resolves to null, never a guess.
 */
export function resolveWhenWords(
  text: string,
  now: Date,
  policy: ReminderPolicy = REMINDER_POLICY,
): { dueDate: string; dueTime: { hour: number; minute: number } | null; matched: string } | null {
  if (typeof text !== "string") return null;
  const norm = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(by|on|before|until|till) /, "");
  if (norm.length === 0 || norm === "stop") return null;
  const tz = policy.timeZone;
  const today = civilTodayOf(now, tz);

  const inN = WHEN_IN_N.exec(norm);
  if (inN !== null) {
    const n = Number(inN[1]);
    const ms = inN[2]!.startsWith("h") ? n * 3_600_000 : n * 60_000;
    if (ms <= 0) return null;
    const wc = wallClockOf(new Date(now.getTime() + ms), tz);
    return {
      dueDate: dateIsoOf(wc),
      dueTime: { hour: wc.hour, minute: wc.minute },
      matched: norm,
    };
  }

  const combined = WHEN_COMBINED.exec(norm);
  if (combined !== null) {
    const time = parseWhenTime(combined[2]!, combined[3], combined[4]);
    if (time === null) return null;
    return { dueDate: whenDateOf(combined[1]!, today), dueTime: time, matched: norm };
  }

  const at = WHEN_AT.exec(norm);
  if (at !== null) {
    const time = parseWhenTime(at[1]!, at[2], at[3]);
    if (time === null) return null;
    return { dueDate: today, dueTime: time, matched: norm };
  }

  const bare = WHEN_BARE.exec(norm);
  if (bare !== null) {
    if (norm === "tonight") return { dueDate: today, dueTime: { hour: 20, minute: 0 }, matched: norm };
    if (norm === "this afternoon") {
      return {
        dueDate: today,
        dueTime: { hour: policy.probeTime.hour, minute: policy.probeTime.minute },
        matched: norm,
      };
    }
    return { dueDate: whenDateOf(norm, today), dueTime: null, matched: norm };
  }

  const weekday = WHEN_WEEKDAY.exec(norm);
  if (weekday !== null) {
    return { dueDate: whenDateOf(weekday[1]!, today), dueTime: null, matched: norm };
  }
  return null;
}

/** Date part of a when-word: today / tomorrow / weekday strictly after. */
function whenDateOf(word: string, today: string): string {
  if (word === "today" || word === "tonight") return today;
  if (word === "tomorrow") return addDaysToIso(today, 1);
  // `word` is guaranteed to be one of WEEKDAY_WORDS by WHEN_WEEKDAY/WHEN_COMBINED.
  const weekday = WEEKDAY_WORDS.indexOf(word as (typeof WEEKDAY_WORDS)[number]);
  return nextWeekdayAfterIso(today, weekday);
}

// -------------------------------------------------------------------
// Due words
// -------------------------------------------------------------------

/**
 * Due word for acks and morning touches: "today" when the due date IS the
 * principal's local today, else the weekday name ("Tuesday"). Pure in
 * `now`; the civil today is derived through the policy timezone.
 */
export function dueWordFor(
  dueDate: string,
  now: Date,
  policy: ReminderPolicy = REMINDER_POLICY,
): string {
  if (dueDate === civilTodayOf(now, policy.timeZone)) return "today";
  return weekdayNameOf(dueDate, policy.timeZone);
}
