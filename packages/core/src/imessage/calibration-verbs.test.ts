// Calibration verb unit tests (no DB, no model) — the strict §17 rating
// grammar matrix (bare digits, prefixed forms, punctuation/whitespace,
// and the mandated rejects incl. the pinned "3pm"), the §8 miss
// eligibility truth table (8 cases — rated never disqualifies,
// other-command always does), and the bounded honest renders.

import { describe, expect, it } from "vitest";
import {
  CALIBRATION_ACK_CHAR_LIMIT,
  CALIBRATION_MISS_ACK_CHAR_LIMIT,
  type CalibrationRating,
  missEligibility,
  parseCalibrationRating,
  renderAmbiguousCalibration,
  renderCalibrationAck,
  renderMissedAck,
} from "./calibration-verbs.js";

describe("parseCalibrationRating — bare digits", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    ["3", 3],
    ["4", 4],
    ["5", 5],
  ])("%s parses to rating %i with scope day", (input, rating) => {
    expect(parseCalibrationRating(input)).toEqual({ rating, scope: "day" });
  });

  it.each(["0", "6", "45", "-3", "five", ""])("%s rejects", (input) => {
    expect(parseCalibrationRating(input)).toBeNull();
  });
});

describe("parseCalibrationRating — prefixed forms", () => {
  it.each([
    ["rate 3", 3],
    ["rate today 4", 4],
    ["Rate 5!", 5],
    ["RATE TODAY 2", 2],
    ["Rate Today 1.", 1],
    ["rate 5!!!", 5],
    ["rate  today  3", 3],
  ])("%s parses to rating %i", (input, rating) => {
    expect(parseCalibrationRating(input)).toEqual({ rating, scope: "day" });
  });
});

describe("parseCalibrationRating — mandated rejects (§17 strict)", () => {
  it.each([
    "rate 4/5",
    "rating 3",
    "3pm",
    "3 pm",
    "1 very inaccurate",
    "2 - the afternoon was off",
    "today 3",
    "ratetoday 3",
    "rate 10",
    "rate",
    "rate 0",
    "rate 6",
    "3?",
    "3*",
    "3\n4",
    "①",
    "rate today",
  ])("%s is null — falls through to chat", (input) => {
    expect(parseCalibrationRating(input)).toBeNull();
  });

  it("3pm must NOT parse as a rating (pinned)", () => {
    expect(parseCalibrationRating("3pm")).toBeNull();
    expect(parseCalibrationRating("3PM")).toBeNull();
  });
});

describe("parseCalibrationRating — whitespace variants", () => {
  it.each([
    ["  3  ", 3],
    ["\t4\t", 4],
    ["\nrate 5\n", 5],
    [" rate   today   2 ", 2],
  ])("%j parses to rating %i after trimming", (input, rating) => {
    expect(parseCalibrationRating(input)).toEqual({ rating, scope: "day" });
  });
});

describe("missEligibility — §8 truth table", () => {
  it.each([
    [{ openItem: true, rated: false, withinPeriod: true, isOtherCommand: false }, "eligible"],
    [{ openItem: true, rated: true, withinPeriod: true, isOtherCommand: false }, "eligible"],
    [{ openItem: true, rated: false, withinPeriod: true, isOtherCommand: true }, "not-eligible"],
    [{ openItem: true, rated: true, withinPeriod: true, isOtherCommand: true }, "not-eligible"],
    [{ openItem: true, rated: false, withinPeriod: false, isOtherCommand: false }, "not-eligible"],
    [{ openItem: true, rated: true, withinPeriod: false, isOtherCommand: false }, "not-eligible"],
    [{ openItem: false, rated: false, withinPeriod: true, isOtherCommand: false }, "not-eligible"],
    [{ openItem: false, rated: true, withinPeriod: true, isOtherCommand: false }, "not-eligible"],
  ])("%j → %s", (input, expected) => {
    expect(missEligibility(input)).toBe(expected);
  });

  it("rated does not disqualify — a miss after a rating is eligible (pinned)", () => {
    expect(
      missEligibility({ openItem: true, rated: true, withinPeriod: true, isOtherCommand: false }),
    ).toBe("eligible");
  });

  it("an other-command match always disqualifies, even with an open in-period item (pinned)", () => {
    expect(
      missEligibility({ openItem: true, rated: false, withinPeriod: true, isOtherCommand: true }),
    ).toBe("not-eligible");
  });
});

describe("renderCalibrationAck", () => {
  const ratings: readonly CalibrationRating[] = [1, 2, 3, 4, 5];

  it.each(ratings)("rating %i is deterministic", (rating) => {
    const first = renderCalibrationAck(rating);
    expect(renderCalibrationAck(rating)).toBe(first);
  });

  it.each(ratings)("rating %i names its own value and stays within the ack bound", (rating) => {
    const reply = renderCalibrationAck(rating);
    expect(reply).toContain(`${rating}/5`);
    expect(reply.length).toBeLessThanOrEqual(CALIBRATION_ACK_CHAR_LIMIT);
  });

  it("renders differ across ratings (the number is never paraphrased away)", () => {
    const replies = new Set(ratings.map((r) => renderCalibrationAck(r)));
    expect(replies.size).toBe(ratings.length);
  });

  it("the spec example shape holds for rating 4", () => {
    expect(renderCalibrationAck(4)).toBe(
      "Logged — 4/5 for today's picture. This is exactly the calibration signal I need.",
    );
  });
});

describe("renderMissedAck", () => {
  it("is deterministic", () => {
    expect(renderMissedAck()).toBe(renderMissedAck());
  });

  it("acknowledges the miss and offers the memory boundary explicitly", () => {
    const reply = renderMissedAck();
    expect(reply).toMatch(/^Logged as a miss/);
    expect(reply).toContain('"remember …"');
  });

  it("stays within the miss-ack bound", () => {
    expect(renderMissedAck().length).toBeLessThanOrEqual(CALIBRATION_MISS_ACK_CHAR_LIMIT);
  });
});

describe("renderAmbiguousCalibration", () => {
  it("is deterministic", () => {
    expect(renderAmbiguousCalibration()).toBe(renderAmbiguousCalibration());
  });

  it("says more than one check-in is open and still asks for the rating", () => {
    const reply = renderAmbiguousCalibration();
    expect(reply).toContain("more than one is open");
    expect(reply).toContain("rating");
  });

  it("never claims which item a rating would land on (safe default, §26)", () => {
    expect(renderAmbiguousCalibration()).not.toMatch(/latest|item #[0-9]|id\b/i);
  });

  it("stays within the miss-ack bound", () => {
    expect(renderAmbiguousCalibration().length).toBeLessThanOrEqual(
      CALIBRATION_MISS_ACK_CHAR_LIMIT,
    );
  });
});
