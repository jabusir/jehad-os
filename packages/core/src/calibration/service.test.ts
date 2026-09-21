// Calibration pure-function tests (no DB): civil-day helpers, §5 prompt
// goldens (observed + quiet), the classifyMiss matrix, and the §13 weekly
// rollup rendering (small-sample honesty).

import { describe, expect, it } from "vitest";
import {
  CALIBRATION_PROMPT_CHAR_BUDGET,
  civilDateOf,
  civilDayBounds,
  classifyMiss,
  isQuietCalibrationDay,
  renderCalibrationPrompt,
  renderWeeklyRollup,
  type CalibrationSummary,
  type MissCategory,
} from "./service.js";

function summary(entries: CalibrationSummary["entries"], day = "2026-09-20"): CalibrationSummary {
  return { kind: "calibration", day, entries };
}

describe("civil day helpers (BRIEF_TIMEZONE = America/Los_Angeles)", () => {
  it("civilDateOf maps UTC instants to the owner-local civil day", () => {
    expect(civilDateOf(new Date("2026-09-20T20:00:00.000Z"))).toBe("2026-09-20"); // 1 PM PT
    expect(civilDateOf(new Date("2026-09-21T06:00:00.000Z"))).toBe("2026-09-20"); // 11 PM PT
    expect(civilDateOf(new Date("2026-09-21T07:00:00.000Z"))).toBe("2026-09-21"); // midnight PT
  });

  it("civilDayBounds resolves DST-correct UTC bounds for a civil date", () => {
    const { dayStart, dayEnd } = civilDayBounds("2026-09-20"); // PDT (UTC-7)
    expect(dayStart.toISOString()).toBe("2026-09-20T07:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2026-09-21T07:00:00.000Z");
  });

  it("civilDayBounds rejects malformed dates", () => {
    expect(() => civilDayBounds("09/20/2026")).toThrow();
    expect(() => civilDayBounds("2026-13-01")).toThrow();
    expect(() => civilDayBounds("not-a-date")).toThrow();
  });
});

describe("renderCalibrationPrompt (§5 shape)", () => {
  it("renders the pinned observed-day shape with bullet counts", () => {
    const prompt = renderCalibrationPrompt(
      summary([
        { sourceKey: "calendar", label: "Calendar", lines: ["4 planned calendar items"] },
        { sourceKey: "commitments", label: "Commitments", lines: ["2 new commitments, 1 completed"] },
        { sourceKey: "gmail", label: "Gmail", lines: ["6 emails received"] },
      ]),
    );
    expect(prompt).toBe(
      [
        "Jehad OS — daily check",
        "",
        "From my side, today looked fairly quiet.",
        "",
        "I observed:",
        "• 4 planned calendar items",
        "• 2 new commitments, 1 completed",
        "• 6 emails received",
        "",
        "How accurate was my picture of your day?",
        "1 very inaccurate · 5 very accurate",
        "",
        "Anything important happen that I missed?",
      ].join("\n"),
    );
    expect(prompt.length).toBeLessThanOrEqual(CALIBRATION_PROMPT_CHAR_BUDGET);
  });

  it("renders the pinned quiet-day shape (no observed entries)", () => {
    const quiet = summary([]);
    expect(isQuietCalibrationDay(quiet)).toBe(true);
    expect(renderCalibrationPrompt(quiet)).toBe(
      [
        "Jehad OS — daily check",
        "",
        "From my side, very little happened today. How accurate is that?",
        "",
        "1 very inaccurate · 5 very accurate",
      ].join("\n"),
    );
  });

  it("never carries telemetry (§16): no ids, hashes, health, or source internals", () => {
    const prompt = renderCalibrationPrompt(
      summary([
        { sourceKey: "calendar", label: "Calendar", lines: ["4 planned calendar items"] },
        { sourceKey: "gmail", label: "Gmail", lines: ["120 emails received"] },
      ]),
    );
    expect(prompt).not.toMatch(/health|cursor|sync|token|id[:\s]|uuid|sha/i);
  });
});

describe("classifyMiss (conservative, fixed unconnected list)", () => {
  const cases: ReadonlyArray<[string, MissCategory]> = [
    ["Slack blew up about the launch", "source_not_connected"],
    ["check the Slack thread", "source_not_connected"],
    ["I had a granola bar and a meeting with Sam", "source_not_connected"], // word mention = mention (conservative)
    ["a walk by the river", "unknown"],
    ["whatsapp message from mom about dinner", "source_not_connected"],
    ["the GitHub PR got merged", "source_not_connected"],
    ["linear ticket closed", "source_not_connected"],
    ["notion page updated", "source_not_connected"],
    ["had lunch with Sam at noon", "unknown"],
    ["the office printer caught fire", "unknown"],
    ["", "unknown"],
    ["slacker was late", "unknown"], // no word-boundary match inside 'slacker'
  ];
  for (const [text, expected] of cases) {
    it(`'${text}' → ${expected}`, () => {
      expect(classifyMiss(text)).toBe(expected);
    });
  }
});

describe("renderWeeklyRollup (§13, honest small samples)", () => {
  const base = {
    weekStart: "2026-09-14",
    missCategories: [] as { category: "unknown"; count: number }[],
    feedbackCounts: { useful: 0, noise: 0, incorrect: 0 },
  };

  it("0 days: null average, too-little-data wording", () => {
    const text = renderWeeklyRollup({ ...base, avgRating: null, daysRated: 0, missCount: 0 });
    expect(text).toBe(
      [
        "Calibration — week of Sep 14",
        "0 days rated — too little data yet.",
        "Nothing missed.",
        "Feedback: 0 useful · 0 noise · 0 incorrect",
      ].join("\n"),
    );
  });

  it("under 3 days: counts surface but no average", () => {
    const text = renderWeeklyRollup({
      ...base,
      avgRating: null,
      daysRated: 2,
      missCount: 1,
      missCategories: [{ category: "unknown", count: 1 }],
    });
    expect(text).toContain("2 days rated — too little data for an average yet.");
    expect(text).toContain("1 missed (1 unknown)");
  });

  it("3+ days: average renders at one decimal", () => {
    const text = renderWeeklyRollup({
      ...base,
      avgRating: 4.333333,
      daysRated: 6,
      missCount: 2,
      missCategories: [{ category: "source_not_connected", count: 1 }, { category: "unknown", count: 1 }],
      feedbackCounts: { useful: 4, noise: 1, incorrect: 0 },
    });
    expect(text).toBe(
      [
        "Calibration — week of Sep 14",
        "6 days rated, average accuracy 4.3/5",
        "2 missed (1 source_not_connected, 1 unknown)",
        "Feedback: 4 useful · 1 noise · 0 incorrect",
      ].join("\n"),
    );
  });
});
