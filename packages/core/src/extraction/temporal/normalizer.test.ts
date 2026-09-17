// Deterministic temporal normalizer (hermetic): every resolution rule, the
// vague/ambiguous set, unsupported phrases, year rollover, TZ projection, and
// DST-safe civil-date math (owner temporal directive 2026-09-17). All dates
// below were hand-checked against the 2026 calendar.

import { describe, expect, it } from "vitest";
import {
  civilToUtcInstant,
  NORMALIZER_VERSION,
  normalizeTemporalExpression,
  normalizedTimeToInstant,
  TemporalNormalizerError,
} from "./normalizer.js";

// 2026-09-17 is a THURSDAY.
const ANCHOR = "2026-09-17T09:00:00.000Z";

function resolve(
  expression: string | null,
  anchorTime: string = ANCHOR,
  anchorTimezone = "UTC",
) {
  return normalizeTemporalExpression({ expression, anchorTime, anchorTimezone });
}

describe("normalizeTemporalExpression — rule table (anchor 2026-09-17 Thu, UTC)", () => {
  it.each([
    // explicit-iso passthrough (calendar-native, validated)
    ["2026-10-01", "2026-10-01", "explicit-iso"],
    ["2026-02-28", "2026-02-28", "explicit-iso"],
    // bare weekday: next occurrence STRICTLY after the anchor
    ["Friday", "2026-09-18", "weekday"],
    ["Monday", "2026-09-21", "weekday"],
    ["Thursday", "2026-09-24", "weekday"], // anchor IS Thursday → next week's
    ["sunday", "2026-09-20", "weekday"],
    ["by Friday", "2026-09-18", "weekday"], // leading preposition stripped
    // "next <weekday>": the week AFTER the upcoming one
    ["next Friday", "2026-09-25", "next-weekday"],
    ["next monday", "2026-09-28", "next-weekday"],
    // today / tomorrow
    ["today", "2026-09-17", "today"],
    ["tomorrow", "2026-09-18", "tomorrow"],
    // in N days / weeks
    ["in 3 days", "2026-09-20", "in-n-days"],
    ["in 1 day", "2026-09-18", "in-n-days"],
    ["in 2 weeks", "2026-10-01", "in-n-weeks"],
    // this weekend: the coming Saturday (today counts on Saturdays)
    ["this weekend", "2026-09-19", "this-weekend"],
    ["the weekend", "2026-09-19", "this-weekend"],
    // next week: Monday of next week
    ["next week", "2026-09-21", "next-week"],
    // end of month
    ["end of month", "2026-09-30", "end-of-month"],
    ["end of the month", "2026-09-30", "end-of-month"],
    // end of week: the coming Friday (today counts on Fridays)
    ["end of week", "2026-09-18", "end-of-week"],
    // month-day: next future occurrence
    ["September 20", "2026-09-20", "month-day"],
    ["Sep 20", "2026-09-20", "month-day"],
    // later today / this afternoon / this evening: same civil day
    ["later today", "2026-09-17", "later-today"],
    ["this afternoon", "2026-09-17", "later-today"],
    ["this evening", "2026-09-17", "later-today"],
  ])("%s → %s (%s)", (expression, expectedDate, expectedMethod) => {
    const result = resolve(expression);
    expect(result.normalizedTime).toBe(expectedDate);
    expect(result.resolutionStatus).toBe("resolved");
    expect(result.resolutionMethod).toBe(expectedMethod);
    expect(result.resolutionConfidence).toBe(1); // deterministic match, always 1.0
    expect(result.normalizerVersion).toBe(NORMALIZER_VERSION);
    expect(result.rawExpression).toBe(expression); // verbatim passthrough
  });

  it("weekday anchors ON the weekday rolls to the NEXT week (strictly after)", () => {
    // 2026-09-18 is a Friday.
    expect(resolve("Friday", "2026-09-18T10:00:00.000Z").normalizedTime).toBe("2026-09-25");
    // this weekend ON Saturday is today; end of week ON Friday is today.
    expect(resolve("this weekend", "2026-09-19T10:00:00.000Z").normalizedTime).toBe("2026-09-19");
    expect(resolve("end of week", "2026-09-18T10:00:00.000Z").normalizedTime).toBe("2026-09-18");
  });

  it("next week from a Monday is the Monday AFTER (not the anchor itself)", () => {
    // 2026-09-21 is a Monday; its own week's Monday is itself → next = 09-28.
    expect(resolve("next week", "2026-09-21T09:00:00.000Z").normalizedTime).toBe("2026-09-28");
  });

  it("YEAR ROLLOVER: month-day already passed this year resolves next year", () => {
    // Anchor 2026-09-17: "April 15" → 2027-04-15.
    expect(resolve("April 15").normalizedTime).toBe("2027-04-15");
    expect(resolve("Apr 15").normalizedTime).toBe("2027-04-15");
  });

  it("Feb 29 rolls to the next LEAP year, not an invalid date", () => {
    // Anchor 2026-09-17: 2027 is not a leap year → 2028-02-29.
    expect(resolve("February 29").normalizedTime).toBe("2028-02-29");
  });

  it("impossible ISO dates degrade to unsupported, never a rolled-over date", () => {
    const result = resolve("2026-02-30");
    expect(result.resolutionStatus).toBe("unsupported");
    expect(result.normalizedTime).toBeNull();
    expect(result.resolutionConfidence).toBe(0);
    expect(result.resolutionMethod).toBeNull();
  });
});

describe("normalizeTemporalExpression — vague / ambiguous", () => {
  it.each([
    "sometime",
    "soon",
    "when I get to it",
    "next chance",
    "sometime next week",
    "Soon",
  ])("%s → ambiguous, normalizedTime null, never a fabricated date", (expression) => {
    const result = resolve(expression);
    expect(result.resolutionStatus).toBe("ambiguous");
    expect(result.normalizedTime).toBeNull();
    // Ambiguity is expressed via status, not fake confidence: the vague
    // CLASSIFICATION is a deterministic match → 1.0 with the vague method.
    expect(result.resolutionConfidence).toBe(1);
    expect(result.resolutionMethod).toBe("vague");
  });
});

describe("normalizeTemporalExpression — unsupported / none", () => {
  it.each(["next month", "next quarter", "in a bit", "before the wedding", "Q3"])(
    "%s → unsupported (null date, no method)",
    (expression) => {
      const result = resolve(expression);
      expect(result.resolutionStatus).toBe("unsupported");
      expect(result.normalizedTime).toBeNull();
      expect(result.resolutionMethod).toBeNull();
      expect(result.resolutionConfidence).toBe(0);
    },
  );

  it("null / empty expression → status none", () => {
    for (const expression of [null, "", "   "]) {
      const result = resolve(expression);
      expect(result.resolutionStatus).toBe("none");
      expect(result.normalizedTime).toBeNull();
      expect(result.rawExpression).toBeNull();
      expect(result.resolutionMethod).toBeNull();
    }
  });
});

describe("normalizeTemporalExpression — timezone + DST safety", () => {
  it("anchors civil-date math in the anchor timezone, not UTC", () => {
    // 2026-03-05T23:30-05:00 is Thursday evening in New York but Friday
    // 2026-03-06T04:30Z in UTC. "Friday" from the USER's Thursday = tomorrow
    // (03-06); UTC-civil math would wrongly answer 03-13.
    const result = resolve("Friday", "2026-03-05T23:30:00.000-05:00", "America/New_York");
    expect(result.normalizedTime).toBe("2026-03-06");
    // ...while the same instant anchored in UTC (already Friday there) is 03-13.
    expect(resolve("Friday", "2026-03-05T23:30:00.000-05:00", "UTC").normalizedTime).toBe("2026-03-13");
  });

  it("calendar math is unaffected by the US spring-forward gap (2026-03-08)", () => {
    expect(resolve("in 7 days", "2026-03-06T12:00:00.000-05:00", "America/New_York").normalizedTime).toBe("2026-03-13");
    expect(resolve("tomorrow", "2026-03-07T12:00:00.000-05:00", "America/New_York").normalizedTime).toBe("2026-03-08");
    expect(resolve("this weekend", "2026-03-05T12:00:00.000-05:00", "America/New_York").normalizedTime).toBe("2026-03-07");
  });

  it("civilToUtcInstant lands civil midnight in the anchor zone on both DST sides", () => {
    // 2026-03-13 America/New_York is EDT (UTC-4) → 04:00Z.
    expect(civilToUtcInstant({ year: 2026, month: 3, day: 13 }, "America/New_York")).toBe(
      "2026-03-13T04:00:00.000Z",
    );
    // 2026-11-06 is EST (UTC-5, DST ended 2026-11-01) → 05:00Z.
    expect(civilToUtcInstant({ year: 2026, month: 11, day: 6 }, "America/New_York")).toBe(
      "2026-11-06T05:00:00.000Z",
    );
    expect(civilToUtcInstant({ year: 2026, month: 9, day: 18 }, "UTC")).toBe(
      "2026-09-18T00:00:00.000Z",
    );
  });

  it("normalizedTimeToInstant round-trips the stored date into an instant", () => {
    expect(normalizedTimeToInstant("2026-09-18", "America/New_York")).toBe(
      "2026-09-18T04:00:00.000Z",
    );
    expect(normalizedTimeToInstant("2026-13-45", "UTC")).toBeNull();
  });

  it("throws TemporalNormalizerError on an invalid timezone or anchorTime (fail loud)", () => {
    expect(() => resolve("Friday", ANCHOR, "Mars/Olympus_Mons")).toThrow(TemporalNormalizerError);
    expect(() => resolve("Friday", "not-a-timestamp")).toThrow(TemporalNormalizerError);
  });

  it("is pure: identical input → identical provenance", () => {
    const a = resolve("next Friday", "2026-11-03T09:00:00.000Z", "Africa/Cairo");
    const b = resolve("next Friday", "2026-11-03T09:00:00.000Z", "Africa/Cairo");
    expect(a).toEqual(b);
  });
});
