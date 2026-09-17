// Eval reference-normalizer unit tests (hermetic, pure): every owner-directive
// rule against the golden anchor 2026-09-17 (Thursday), UTC. The REAL
// normalizer is W6A's (unit-tested in packages/core); these pin the eval's
// reference semantics the golden set's resolved_due_date values encode.

import { describe, expect, it } from "vitest";
import { normalizeTemporalExpression } from "./normalizer.js";

const ANCHOR = "2026-09-17T09:00:00.000Z"; // Thursday

function resolve(expr: string | null, anchor: string = ANCHOR) {
  return normalizeTemporalExpression(expr, anchor);
}

describe("normalizeTemporalExpression (anchor 2026-09-17 Thursday)", () => {
  it("null / empty expression → none", () => {
    expect(resolve(null)).toEqual({
      normalizedTime: null,
      resolutionStatus: "none",
      resolutionMethod: null,
      resolutionConfidence: 0,
    });
    expect(resolve("   ").resolutionStatus).toBe("none");
  });

  it("explicit ISO passes through", () => {
    expect(resolve("2026-10-15")).toMatchObject({
      normalizedTime: "2026-10-15",
      resolutionStatus: "resolved",
      resolutionMethod: "explicit-iso",
    });
  });

  it("tomorrow → +1 day (incl. inside 'tomorrow morning')", () => {
    expect(resolve("tomorrow")).toMatchObject({ normalizedTime: "2026-09-18", resolutionStatus: "resolved" });
    expect(resolve("tomorrow morning")).toMatchObject({ normalizedTime: "2026-09-18" });
  });

  it("same-day phrases → anchor date", () => {
    expect(resolve("tonight")).toMatchObject({ normalizedTime: "2026-09-17", resolutionMethod: "same-day" });
    expect(resolve("end of day")).toMatchObject({ normalizedTime: "2026-09-17" });
    expect(resolve("later today")).toMatchObject({ normalizedTime: "2026-09-17" });
    expect(resolve("today")).toMatchObject({ normalizedTime: "2026-09-17" });
  });

  it("bare weekday → next occurrence strictly after the anchor", () => {
    expect(resolve("Friday")).toMatchObject({ normalizedTime: "2026-09-18", resolutionMethod: "weekday" });
    expect(resolve("Tuesday")).toMatchObject({ normalizedTime: "2026-09-22" });
    expect(resolve("Wednesday")).toMatchObject({ normalizedTime: "2026-09-23" });
    expect(resolve("Monday")).toMatchObject({ normalizedTime: "2026-09-21" });
    // Same-weekday reference rolls a full week forward.
    expect(resolve("Thursday")).toMatchObject({ normalizedTime: "2026-09-24" });
  });

  it("'by <weekday>' keeps the weekday rule", () => {
    expect(resolve("by Friday")).toMatchObject({ normalizedTime: "2026-09-18" });
    expect(resolve("by Wednesday")).toMatchObject({ normalizedTime: "2026-09-23" });
  });

  it("'next <weekday>' → the FOLLOWING week's occurrence", () => {
    // Next Friday said on Thursday Sep 17 is Sep 25, not tomorrow Sep 18.
    expect(resolve("next Friday")).toMatchObject({ normalizedTime: "2026-09-25", resolutionMethod: "next-weekday" });
    expect(resolve("next Monday")).toMatchObject({ normalizedTime: "2026-09-21" });
    expect(resolve("next Thursday")).toMatchObject({ normalizedTime: "2026-09-24" });
  });

  it("'in two weeks' / 'in N weeks' → anchor + 7N", () => {
    expect(resolve("in two weeks")).toMatchObject({ normalizedTime: "2026-10-01", resolutionMethod: "in-n-weeks" });
    expect(resolve("in 3 weeks")).toMatchObject({ normalizedTime: "2026-10-08" });
  });

  it("'within a week' → end of the window", () => {
    expect(resolve("within a week")).toMatchObject({ normalizedTime: "2026-09-24", resolutionMethod: "within-a-week" });
  });

  it("'end of month' → last day of the anchor month; named months roll forward", () => {
    expect(resolve("end of month")).toMatchObject({ normalizedTime: "2026-09-30", resolutionMethod: "end-of-month" });
    expect(resolve("end of the month")).toMatchObject({ normalizedTime: "2026-09-30" });
    expect(resolve("end of October")).toMatchObject({ normalizedTime: "2026-10-31" });
    expect(resolve("end of February")).toMatchObject({ normalizedTime: "2027-02-28" });
  });

  it("'this weekend' → upcoming Saturday", () => {
    expect(resolve("this weekend")).toMatchObject({ normalizedTime: "2026-09-19", resolutionMethod: "this-weekend" });
  });

  it("bare 'next week' → Monday of next week", () => {
    expect(resolve("next week")).toMatchObject({ normalizedTime: "2026-09-21", resolutionMethod: "next-week" });
  });

  it("month-day this year when future", () => {
    expect(resolve("October 6")).toMatchObject({ normalizedTime: "2026-10-06", resolutionMethod: "month-day" });
    expect(resolve("by October 6")).toMatchObject({ normalizedTime: "2026-10-06" });
    expect(resolve("October 9")).toMatchObject({ normalizedTime: "2026-10-09" });
  });

  it("month-day rolls to NEXT year once passed", () => {
    expect(resolve("March 2")).toMatchObject({ normalizedTime: "2027-03-02" });
    expect(resolve("April 15")).toMatchObject({ normalizedTime: "2027-04-15" });
    expect(resolve("June 3")).toMatchObject({ normalizedTime: "2027-06-03" });
  });

  it("ambiguous phrases → null + ambiguous, never a guess", () => {
    for (const phrase of ["sometime next week", "early next week", "when I get a chance", "sometime", "eventually", "soon"]) {
      expect(resolve(phrase)).toMatchObject({ normalizedTime: null, resolutionStatus: "ambiguous" });
    }
  });

  it("unknown / event-anchored / past expressions → unsupported", () => {
    for (const phrase of ["before the offsite", "once the numbers are finalized", "last week", "Last March", "October"]) {
      expect(resolve(phrase)).toMatchObject({ normalizedTime: null, resolutionStatus: "unsupported" });
    }
  });

  it("resolves against the event anchor, not 'now'", () => {
    // A capture recorded Monday Sep 14 resolves Friday to Sep 18 still, but
    // 'tomorrow' to Sep 15 — anchor-relative semantics.
    expect(resolve("tomorrow", "2026-09-14T22:00:00.000Z")).toMatchObject({ normalizedTime: "2026-09-15" });
    expect(resolve("next Friday", "2026-09-14T08:00:00.000Z")).toMatchObject({ normalizedTime: "2026-09-25" });
  });
});
