/**
 * Eval reference normalizer (golden v2 / lane W6B) — the deterministic
 * temporal-expression resolver the eval uses to turn a model-echoed
 * EXPRESSION into the TemporalProvenance block metrics consume
 * (packages/core/src/memory/candidate-contract.ts — READ-ONLY contract).
 *
 * The REAL normalizer is W6A's (packages/core, unit-tested there); this one
 * exists so the hermetic tier is self-consistent BEFORE W6A merges: the fake
 * provider emits v3 shape (temporal_expression), this module resolves it,
 * metrics score it. Rule set mirrors the owner directive:
 *   unknown is better than confidently wrong — ambiguous expressions
 *   resolve to null + "ambiguous", never a guess.
 *
 * All math is UTC against the event's occurredAt (the provenance anchor).
 */

export type ResolutionStatus = "resolved" | "ambiguous" | "unsupported" | "none";

export interface NormalizerResult {
  readonly normalizedTime: string | null;
  readonly resolutionStatus: ResolutionStatus;
  /** Which rule fired ("explicit-iso", "weekday", "in-n-weeks", …) or null. */
  readonly resolutionMethod: string | null;
  /** 0-1 confidence of the rule match (1 for exact calendar rules). */
  readonly resolutionConfidence: number;
}

export const EVAL_NORMALIZER_VERSION = "eval-ref-v1";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;

/** Phrases that name time but deliberately do NOT resolve to a date. */
const AMBIGUOUS_PHRASES = [
  "sometime next week",
  "early next week",
  "when i get a chance",
  "when i can",
  "sometime",
  "eventually",
  "soon",
] as const;

const SAME_DAY_PHRASES = ["tonight", "end of day", "later today", "today", "eod"] as const;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(anchor: string): Date {
  return new Date(`${anchor.slice(0, 10)}T00:00:00Z`);
}

function nextWeekdayAfter(weekday: number, after: Date, forceFollowingWeek = false): Date {
  const d = new Date(after.getTime());
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== weekday);
  if (forceFollowingWeek) {
    // "next <weekday>": if the next occurrence is still in the anchor's
    // Mon–Sun calendar week, the speaker means the FOLLOWING week's one.
    const anchorWeekStart = new Date(after.getTime());
    anchorWeekStart.setUTCDate(anchorWeekStart.getUTCDate() - ((anchorWeekStart.getUTCDay() + 6) % 7));
    const weekEnd = new Date(anchorWeekStart.getTime());
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
    if (d.getTime() < weekEnd.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  }
  return d;
}

function lastDayOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month + 1, 0));
}

function monthDayWithRollover(month: number, day: number, after: Date): Date {
  let candidate = new Date(Date.UTC(after.getUTCFullYear(), month, day));
  if (candidate.getTime() <= after.getTime()) {
    candidate = new Date(Date.UTC(after.getUTCFullYear() + 1, month, day));
  }
  return candidate;
}

/**
 * Resolves one verbatim temporal expression against the anchor.
 * Order matters: ambiguous and same-day phrases are checked before the
 * generic weekday / "next week" rules that would otherwise swallow them.
 */
export function normalizeTemporalExpression(
  rawExpression: string | null,
  anchorIso: string,
): NormalizerResult {
  if (rawExpression === null || rawExpression.trim().length === 0) {
    return { normalizedTime: null, resolutionStatus: "none", resolutionMethod: null, resolutionConfidence: 0 };
  }
  const expr = rawExpression.trim().toLowerCase();
  const anchor = startOfUtcDay(anchorIso);

  // Explicit ISO date passes through untouched (calendar-native).
  const isoMatch = /^(\d{4}-\d{2}-\d{2})$/.exec(expr);
  if (isoMatch !== null) {
    return { normalizedTime: isoMatch[1]!, resolutionStatus: "resolved", resolutionMethod: "explicit-iso", resolutionConfidence: 1 };
  }

  // Ambiguous phrases: null + ambiguous, never a guess.
  for (const phrase of AMBIGUOUS_PHRASES) {
    if (expr.includes(phrase)) {
      return { normalizedTime: null, resolutionStatus: "ambiguous", resolutionMethod: "ambiguous-phrase", resolutionConfidence: 0.9 };
    }
  }

  // Same-day phrases.
  for (const phrase of SAME_DAY_PHRASES) {
    if (new RegExp(`\\b${phrase}\\b`).test(expr)) {
      return { normalizedTime: iso(anchor), resolutionStatus: "resolved", resolutionMethod: "same-day", resolutionConfidence: 0.95 };
    }
  }

  if (/\btomorrow\b/.test(expr)) {
    const d = new Date(anchor.getTime());
    d.setUTCDate(d.getUTCDate() + 1);
    return { normalizedTime: iso(d), resolutionStatus: "resolved", resolutionMethod: "tomorrow", resolutionConfidence: 1 };
  }

  // "in N weeks" / "in two weeks".
  const inWeeks = /\bin (\d+|two|three|four) weeks?\b/.exec(expr);
  if (inWeeks !== null) {
    const word = inWeeks[1]!;
    const n = word === "two" ? 2 : word === "three" ? 3 : word === "four" ? 4 : Number(word);
    const d = new Date(anchor.getTime());
    d.setUTCDate(d.getUTCDate() + 7 * n);
    return { normalizedTime: iso(d), resolutionStatus: "resolved", resolutionMethod: "in-n-weeks", resolutionConfidence: 1 };
  }

  // "within a week" — a deadline window, resolved to its end.
  if (/\bwithin a week\b/.test(expr)) {
    const d = new Date(anchor.getTime());
    d.setUTCDate(d.getUTCDate() + 7);
    return { normalizedTime: iso(d), resolutionStatus: "resolved", resolutionMethod: "within-a-week", resolutionConfidence: 0.9 };
  }

  // End of (this | named) month.
  const endOfMonth = /\bend of (month|the month)\b/.exec(expr);
  if (endOfMonth !== null) {
    const last = lastDayOfMonth(anchor.getUTCFullYear(), anchor.getUTCMonth());
    return { normalizedTime: iso(last), resolutionStatus: "resolved", resolutionMethod: "end-of-month", resolutionConfidence: 0.95 };
  }
  for (let m = 0; m < MONTHS.length; m += 1) {
    if (new RegExp(`\\bend of ${MONTHS[m]!}\\b`).test(expr)) {
      const year = anchor.getUTCFullYear() + (m < anchor.getUTCMonth() ? 1 : 0);
      return { normalizedTime: iso(lastDayOfMonth(year, m)), resolutionStatus: "resolved", resolutionMethod: "end-of-month", resolutionConfidence: 0.95 };
    }
  }

  // Month-day ("June 3"): this year, rolling to next year when it has passed.
  for (let m = 0; m < MONTHS.length; m += 1) {
    const md = new RegExp(`\\b${MONTHS[m]!} (\\d{1,2})\\b`).exec(expr);
    if (md !== null) {
      return {
        normalizedTime: iso(monthDayWithRollover(m, Number(md[1]), anchor)),
        resolutionStatus: "resolved",
        resolutionMethod: "month-day",
        resolutionConfidence: 1,
      };
    }
  }

  // This weekend → the upcoming Saturday.
  if (/\b(this |the |on )?weekend\b/.test(expr) || /\bthis weekend\b/.test(expr)) {
    const d = nextWeekdayAfter(6, anchor);
    return { normalizedTime: iso(d), resolutionStatus: "resolved", resolutionMethod: "this-weekend", resolutionConfidence: 0.9 };
  }

  // Bare "next week" → Monday of next week. ("early/sometime next week"
  // already returned ambiguous above, so ordering carries the semantics.)
  if (/\bnext week\b/.test(expr)) {
    const d = nextWeekdayAfter(1, anchor);
    return { normalizedTime: iso(d), resolutionStatus: "resolved", resolutionMethod: "next-week", resolutionConfidence: 0.9 };
  }

  // "next <weekday>" → the following week's occurrence …
  for (let i = 0; i < WEEKDAYS.length; i += 1) {
    if (new RegExp(`\\bnext ${WEEKDAYS[i]!}\\b`).test(expr)) {
      return {
        normalizedTime: iso(nextWeekdayAfter(i, anchor, true)),
        resolutionStatus: "resolved",
        resolutionMethod: "next-weekday",
        resolutionConfidence: 0.95,
      };
    }
  }
  // … bare "<weekday>" (incl. "by Friday") → next occurrence after the anchor.
  for (let i = 0; i < WEEKDAYS.length; i += 1) {
    if (new RegExp(`\\b${WEEKDAYS[i]!}\\b`).test(expr)) {
      return {
        normalizedTime: iso(nextWeekdayAfter(i, anchor)),
        resolutionStatus: "resolved",
        resolutionMethod: "weekday",
        resolutionConfidence: 0.95,
      };
    }
  }

  // Past-facing or event-anchored expressions we have no rule for.
  if (/\b(last|ago|previously|before the|after the|once|when)\b/.test(expr)) {
    return { normalizedTime: null, resolutionStatus: "unsupported", resolutionMethod: null, resolutionConfidence: 0 };
  }

  return { normalizedTime: null, resolutionStatus: "unsupported", resolutionMethod: null, resolutionConfidence: 0 };
}
