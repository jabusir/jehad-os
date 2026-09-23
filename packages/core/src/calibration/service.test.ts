// Calibration pure-function tests (no DB): civil-day helpers, §5 prompt
// goldens (observed + quiet), the classifyMiss matrix, and the §13 weekly
// rollup rendering (small-sample honesty).

import { describe, expect, it } from "vitest";
import {
  CALIBRATION_PROMPT_CHAR_BUDGET,
  CALIBRATION_PRIMARY_QUESTION,
  CALIBRATION_RATING_LINE,
  civilDateOf,
  civilDayBounds,
  classifyMiss,
  renderCalibrationPrompt,
  renderWeeklyRollup,
  type CalibrationSummary,
  type DayReconstruction,
  type MissCategory,
} from "./service.js";

function summary(
  entries: CalibrationSummary["entries"],
  day = "2026-09-20",
  reconstruction?: CalibrationSummary["reconstruction"],
): CalibrationSummary {
  return { kind: "calibration", day, entries, ...(reconstruction ? { reconstruction } : {}) };
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

describe("renderCalibrationPrompt — reconstruction shape (quality fix 2026-09-23)", () => {
  const reconstruction = (over: Partial<DayReconstruction> = {}): DayReconstruction => ({
    observed: [],
    planned: [],
    activity: [],
    uncertain: [],
    ...over,
  });

  it("golden §14 planned≠observed: calendar is framed as scheduled, never as done", () => {
    const prompt = renderCalibrationPrompt(
      summary([], "2026-09-20", reconstruction({
        planned: [
          { label: "10:00 AM — Sync" },
          { label: "12:00 PM — Lunch" },
          { label: "3:00 PM — Review" },
          { label: "5:00 PM — 1:1" },
        ],
        activity: [{ label: "30 emails arrived" }],
        uncertain: [
          "which of the 4 scheduled items actually happened, or in what order",
          "which of the emails mattered — volume doesn't say",
          "how you actually spent your time — nothing I can see verifies it",
        ],
      })),
    );
    expect(prompt).toBe(
      [
        "Jehad OS — daily check",
        "",
        "I don't have a strong picture of today.",
        "",
        "What was only planned:",
        "• 10:00 AM — Sync",
        "• 12:00 PM — Lunch",
        "• 3:00 PM — Review",
        "• 5:00 PM — 1:1",
        "I can't verify which of these happened, or in what order — scheduled is not the same as done.",
        "",
        "Raw activity I saw:",
        "• 30 emails arrived",
        "",
        "What I'm least sure about:",
        "• which of the 4 scheduled items actually happened, or in what order",
        "• which of the emails mattered — volume doesn't say",
        "• how you actually spent your time — nothing I can see verifies it",
        "",
        CALIBRATION_PRIMARY_QUESTION,
        "",
        `Rate this picture 1–5 (${CALIBRATION_RATING_LINE}).`,
      ].join("\n"),
    );
    expect(prompt).not.toMatch(/you did|attended|worked on|followed/i);
    expect(prompt.length).toBeLessThanOrEqual(CALIBRATION_PROMPT_CHAR_BUDGET);
  });

  it("golden §14 meaningful observed state: canonical outcome verified, calendar stays planned", () => {
    const prompt = renderCalibrationPrompt(
      summary([], "2026-09-20", reconstruction({
        observed: [{ label: 'Outcome "Plaid security review" completed' }],
        planned: [{ label: "10:00 AM — Sync" }],
        uncertain: ["which of the 1 scheduled items actually happened, or in what order"],
      })),
    );
    expect(prompt).toContain("Here's my picture of today.");
    expect(prompt).toContain("What I could verify:");
    expect(prompt).toContain('• Outcome "Plaid security review" completed');
    expect(prompt).toContain("What was only planned:");
    expect(prompt).toContain("• 10:00 AM — Sync");
    expect(prompt).not.toContain("You did");
  });

  it("empty sections are omitted — never mechanically padded", () => {
    const prompt = renderCalibrationPrompt(
      summary([], "2026-09-20", reconstruction({
        observed: [{ label: 'You confirmed "Gym" happened' }],
      })),
    );
    expect(prompt).not.toContain("What was only planned:");
    expect(prompt).not.toContain("Raw activity I saw:");
    expect(prompt).not.toContain("What I'm least sure about:");
  });

  it("§14 overclaim guard: no completion language without evidence", () => {
    const prompt = renderCalibrationPrompt(
      summary([], "2026-09-20", reconstruction({
        planned: [{ label: "9:00 AM — Standup" }],
      })),
    );
    expect(prompt).not.toMatch(/\b(you did|you attended|you completed|you worked)\b/i);
    expect(prompt).toMatch(/can't verify/);
  });

  it("§14 wrong-sequence guard: planned bullets never render as lived order", () => {
    const prompt = renderCalibrationPrompt(
      summary([], "2026-09-20", reconstruction({
        planned: [{ label: "10:00 AM — X" }, { label: "3:00 PM — Z" }, { label: "12:00 PM — Y" }],
      })),
    );
    expect(prompt).not.toMatch(/\byou did .+ then\b|first .*then .*then/i);
  });

  it("rating is strictly secondary: primary question first, rating last", () => {
    const prompt = renderCalibrationPrompt(
      summary([], "2026-09-20", reconstruction({ observed: [{ label: "x" }] })),
    );
    const questionAt = prompt.indexOf(CALIBRATION_PRIMARY_QUESTION);
    const ratingAt = prompt.indexOf("Rate this picture");
    expect(questionAt).toBeGreaterThan(-1);
    expect(ratingAt).toBeGreaterThan(questionAt);
    expect(prompt.trimEnd().endsWith(`Rate this picture 1–5 (${CALIBRATION_RATING_LINE}).`)).toBe(true);
  });

  it("§13 thin coverage (reconstruction empty): plain weakness, no fabrication", () => {
    const prompt = renderCalibrationPrompt(summary([], "2026-09-20", reconstruction()));
    expect(prompt).toBe(
      [
        "Jehad OS — daily check",
        "",
        "I don't have a strong picture of today.",
        "",
        CALIBRATION_PRIMARY_QUESTION,
        "",
        `Rate this picture 1–5 (${CALIBRATION_RATING_LINE}).`,
      ].join("\n"),
    );
  });

  it("legacy summaries (pre-reconstruction) degrade to honest counts framing", () => {
    const prompt = renderCalibrationPrompt(
      summary([
        { sourceKey: "calendar", label: "Calendar", lines: ["4 planned calendar items"] },
        { sourceKey: "gmail", label: "Gmail", lines: ["30 emails received"] },
      ]),
    );
    expect(prompt).toBe(
      [
        "Jehad OS — daily check",
        "",
        "Here's what I saw today (counts only):",
        "• 4 planned calendar items",
        "• 30 emails received",
        "",
        "Counts aren't a picture — I can't tell from these what actually happened or what mattered.",
        "",
        CALIBRATION_PRIMARY_QUESTION,
        "",
        `Rate this picture 1–5 (${CALIBRATION_RATING_LINE}).`,
      ].join("\n"),
    );
    expect(prompt).not.toMatch(/fairly quiet|very little happened/i);
  });

  it("legacy quiet day: weakness stated plainly — no intensity inference from zero counts", () => {
    const prompt = renderCalibrationPrompt(summary([]));
    expect(prompt).toBe(
      [
        "Jehad OS — daily check",
        "",
        "I don't have a strong picture of today.",
        "",
        "Nothing I can see tells me what you actually did or what mattered most.",
        "",
        CALIBRATION_PRIMARY_QUESTION,
        "",
        `Rate this picture 1–5 (${CALIBRATION_RATING_LINE}).`,
      ].join("\n"),
    );
  });

  it("never carries telemetry (§16): no ids, hashes, health, or source internals", () => {
    const prompt = renderCalibrationPrompt(
      summary([], "2026-09-20", reconstruction({
        planned: [{ label: "10:00 AM — Sync" }],
        activity: [{ label: "120 emails arrived" }],
      })),
    );
    expect(prompt).not.toMatch(/health|cursor|sync_state|token|uuid|sha/i);
  });
});

describe("renderCalibrationPrompt — legacy counts inputs (backward compat)", () => {
  it("renders the pinned observed-day shape with bullet counts", () => {
    const prompt = renderCalibrationPrompt(
      summary([
        { sourceKey: "calendar", label: "Calendar", lines: ["4 planned calendar items"] },
        { sourceKey: "commitments", label: "Commitments", lines: ["2 new commitments, 1 completed"] },
        { sourceKey: "gmail", label: "Gmail", lines: ["6 emails received"] },
      ]),
    );
    expect(prompt).toContain("• 4 planned calendar items");
    expect(prompt).toContain("• 2 new commitments, 1 completed");
    expect(prompt).toContain("• 6 emails received");
    expect(prompt).toContain(CALIBRATION_PRIMARY_QUESTION);
    expect(prompt.length).toBeLessThanOrEqual(CALIBRATION_PROMPT_CHAR_BUDGET);
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
