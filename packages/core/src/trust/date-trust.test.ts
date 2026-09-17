// Date-trust assessment unit tests (owner directive 2026-09-17): the
// three-tier rule — calendar-native trusted, normalized confidence-gated,
// ambiguous/unsupported/legacy never trusted. Pure and total.

import { describe, expect, it } from "vitest";
import { AMBIGUOUS_DUE_DATE, CALENDAR_NATIVE_METHOD, assessDueDateTrust } from "./date-trust.js";

function temporal(args: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    rawExpression: "next Friday",
    anchorTime: "2026-09-17T12:00:00.000Z",
    anchorTimezone: "UTC",
    normalizedTime: "2026-09-25",
    resolutionStatus: "resolved",
    normalizerVersion: "t",
    resolutionConfidence: 0.95,
    resolutionMethod: "weekday",
    ...args,
  };
}

describe("assessDueDateTrust — three-tier date trust", () => {
  it("calendar-native resolved dates are trusted outright", () => {
    const result = assessDueDateTrust(
      temporal({ resolutionMethod: CALENDAR_NATIVE_METHOD, resolutionConfidence: 0.1 }),
    );
    expect(result).toEqual({ tier: "calendar-native", trusted: true });
  });

  it("normalized dates are trusted at/above the threshold", () => {
    expect(assessDueDateTrust(temporal({ resolutionConfidence: 0.9 })).trusted).toBe(true);
    expect(
      assessDueDateTrust(temporal({ resolutionConfidence: 0.89 }), 0.9).trusted,
    ).toBe(false);
    expect(assessDueDateTrust(temporal({ resolutionConfidence: 0.7 }), 0.7).trusted).toBe(true);
  });

  it.each([
    ["ambiguous status", temporal({ resolutionStatus: "ambiguous", normalizedTime: null })],
    ["unsupported status", temporal({ resolutionStatus: "unsupported", normalizedTime: null })],
    ["none status", temporal({ resolutionStatus: "none", normalizedTime: null })],
    ["resolved but null normalizedTime", temporal({ normalizedTime: null })],
    ["resolved but empty normalizedTime", temporal({ normalizedTime: "" })],
    ["resolved but missing confidence", temporal({ resolutionConfidence: undefined })],
    ["unrecognized status", temporal({ resolutionStatus: " vibes" })],
  ])("%s → review, never trusted", (_label, block) => {
    expect(assessDueDateTrust(block)).toEqual({ tier: "review", trusted: false });
  });

  it("absent temporal (legacy rows / pre-W6A schema) → legacy, never trusted", () => {
    expect(assessDueDateTrust(null)).toEqual({ tier: "legacy", trusted: false });
    expect(assessDueDateTrust(undefined)).toEqual({ tier: "legacy", trusted: false });
  });

  it("malformed temporal JSON degrades to review, never throws", () => {
    expect(assessDueDateTrust("{not json")).toEqual({ tier: "review", trusted: false });
    expect(assessDueDateTrust(42)).toEqual({ tier: "review", trusted: false });
    expect(assessDueDateTrust([])).toEqual({ tier: "review", trusted: false });
  });

  it("exports the needsReview marker constant", () => {
    expect(AMBIGUOUS_DUE_DATE).toBe("ambiguous_due_date");
  });
});
