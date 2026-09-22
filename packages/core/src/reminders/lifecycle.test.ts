// Reminder lifecycle (pure lane) — hermetic: every Date is pinned, no
// wall-clock reads. Hand-checked against the 2026 calendar:
// 2026-09-21 is a Monday; America/Los_Angeles is PDT (UTC-7) until the
// 2026-11-01 fall-back and from the 2026-03-08 spring-forward (PST, UTC-8).

import { describe, expect, it } from "vitest";
import {
  computeFirstTouch,
  doneAck,
  dueWordFor,
  movedAck,
  parkedAck,
  quietShiftedAck,
  REMINDER_POLICY,
  resolveWhenWords,
  scheduleAfterTouch,
  touchMessage,
} from "./lifecycle.js";

const d = (iso: string): Date => new Date(iso);

// Monday 2026-09-21, 09:00 PT (PDT).
const NOW = "2026-09-21T16:00:00.000Z";

describe("computeFirstTouch", () => {
  it("tomorrow with no time → tomorrow 09:00 PT", () => {
    const r = computeFirstTouch({ dueDate: "2026-09-22", dueTime: null, now: d(NOW) });
    expect(r.at.toISOString()).toBe("2026-09-22T16:00:00.000Z");
    expect(r.kind).toBe("morning");
    expect(r.quietShifted).toBe(false);
  });

  it("explicit time 15:00 → that exact time, even when already past now", () => {
    const r = computeFirstTouch({
      dueDate: "2026-09-21",
      dueTime: { hour: 15, minute: 0 },
      now: d(NOW),
    });
    expect(r.at.toISOString()).toBe("2026-09-21T22:00:00.000Z");
    expect(r.quietShifted).toBe(false);
  });

  it("explicit time 23:00 (quiet) → next day 09:00, quietShifted", () => {
    const r = computeFirstTouch({
      dueDate: "2026-09-21",
      dueTime: { hour: 23, minute: 0 },
      now: d(NOW),
    });
    expect(r.at.toISOString()).toBe("2026-09-22T16:00:00.000Z");
    expect(r.quietShifted).toBe(true);
  });

  it("quiet window is [22:00, next-day 07:00): 22:00 is quiet, 07:00 is not", () => {
    const at2200 = computeFirstTouch({
      dueDate: "2026-09-21",
      dueTime: { hour: 22, minute: 0 },
      now: d(NOW),
    });
    expect(at2200.quietShifted).toBe(true);
    expect(at2200.at.toISOString()).toBe("2026-09-22T16:00:00.000Z");
    const at0700 = computeFirstTouch({
      dueDate: "2026-09-21",
      dueTime: { hour: 7, minute: 0 },
      now: d(NOW),
    });
    expect(at0700.at.toISOString()).toBe("2026-09-21T14:00:00.000Z");
    expect(at0700.quietShifted).toBe(false);
  });

  it("today created at noon → same-day probe 15:30", () => {
    const r = computeFirstTouch({
      dueDate: "2026-09-21",
      dueTime: null,
      now: d("2026-09-21T19:00:00.000Z"),
    });
    expect(r.at.toISOString()).toBe("2026-09-21T22:30:00.000Z");
    expect(r.quietShifted).toBe(false);
  });

  it("today created at 18:00 → now + 10 minutes", () => {
    const r = computeFirstTouch({
      dueDate: "2026-09-21",
      dueTime: null,
      now: d("2026-09-22T01:00:00.000Z"),
    });
    expect(r.at.toISOString()).toBe("2026-09-22T01:10:00.000Z");
    expect(r.quietShifted).toBe(false);
  });

  it("today created at 23:00 → now+10min is quiet → next day 09:00", () => {
    const r = computeFirstTouch({
      dueDate: "2026-09-21",
      dueTime: null,
      now: d("2026-09-22T06:00:00.000Z"),
    });
    expect(r.at.toISOString()).toBe("2026-09-22T16:00:00.000Z");
    expect(r.quietShifted).toBe(true);
  });

  it("created 21:55 → now+10min (22:05) is quiet → next day 09:00", () => {
    const r = computeFirstTouch({
      dueDate: "2026-09-20",
      dueTime: null,
      now: d("2026-09-21T04:55:00.000Z"),
    });
    expect(r.at.toISOString()).toBe("2026-09-21T16:00:00.000Z");
    expect(r.quietShifted).toBe(true);
  });

  it("malformed dueDate fails loud, never a guessed schedule", () => {
    expect(() => computeFirstTouch({ dueDate: "2026-09-31", dueTime: null, now: d(NOW) })).toThrow();
    expect(() => computeFirstTouch({ dueDate: "tomorrow", dueTime: null, now: d(NOW) })).toThrow();
  });
});

describe("scheduleAfterTouch", () => {
  it("morning at 09:00 → same-day probe 15:30", () => {
    const r = scheduleAfterTouch({ kind: "morning", at: d("2026-09-21T16:00:00.000Z"), escalations: 0 });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("probe");
    expect(r!.at.toISOString()).toBe("2026-09-21T22:30:00.000Z");
  });

  it("morning sent 16:00 (later than probeTime) → probe 19:00 (offset, under cap)", () => {
    const r = scheduleAfterTouch({ kind: "morning", at: d("2026-09-21T23:00:00.000Z"), escalations: 0 });
    expect(r!.kind).toBe("probe");
    expect(r!.at.toISOString()).toBe("2026-09-22T02:00:00.000Z");
  });

  it("morning sent 18:30 → probe capped at 20:00", () => {
    const r = scheduleAfterTouch({ kind: "morning", at: d("2026-09-22T01:30:00.000Z"), escalations: 0 });
    expect(r!.kind).toBe("probe");
    expect(r!.at.toISOString()).toBe("2026-09-22T03:00:00.000Z");
  });

  it("morning sent 17:00 → offset lands exactly on the 20:00 cap (inclusive)", () => {
    const r = scheduleAfterTouch({ kind: "morning", at: d("2026-09-22T00:00:00.000Z"), escalations: 0 });
    expect(r!.at.toISOString()).toBe("2026-09-22T03:00:00.000Z");
  });

  it("probe → next-day nudge at 09:00 (civil day math, not +24h)", () => {
    const r = scheduleAfterTouch({ kind: "probe", at: d("2026-09-21T22:30:00.000Z"), escalations: 0 });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("nudge");
    expect(r!.at.toISOString()).toBe("2026-09-22T16:00:00.000Z");
  });

  it("nudge with escalations 0 (under cap 2) → next-day nudge", () => {
    const r = scheduleAfterTouch({ kind: "nudge", at: d("2026-09-22T16:00:00.000Z"), escalations: 0 });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("nudge");
    expect(r!.at.toISOString()).toBe("2026-09-23T16:00:00.000Z");
  });

  it("nudge at the cap (escalations >= nudgeCap - 1) → null (caller parks)", () => {
    expect(
      scheduleAfterTouch({ kind: "nudge", at: d("2026-09-22T16:00:00.000Z"), escalations: 1 }),
    ).toBeNull();
  });

  it("cap is policy-driven: nudgeCap 3 allows escalations 1, parks at 2", () => {
    const policy = { ...REMINDER_POLICY, nudgeCap: 3 };
    expect(
      scheduleAfterTouch({ kind: "nudge", at: d("2026-09-22T16:00:00.000Z"), escalations: 1 }, policy),
    ).not.toBeNull();
    expect(
      scheduleAfterTouch({ kind: "nudge", at: d("2026-09-22T16:00:00.000Z"), escalations: 2 }, policy),
    ).toBeNull();
  });
});

describe("touchMessage — exact templates", () => {
  it.each([
    ["morning", "Call the bank", 0, "today", "Reminder: Call the bank — today."],
    ["morning", "Call the bank", 0, "Friday", "Reminder: Call the bank — Friday."],
    ["probe", "Call the bank", 0, "today", "Did you get to Call the bank?"],
    ["nudge", "Call the bank", 0, "today", "Still open: Call the bank. Want to lock a time for it?"],
    [
      "nudge",
      "Call the bank",
      1,
      "today",
      'Second nudge — Call the bank is still open. Say "stop" and I\'ll park it.',
    ],
  ] as const)("%s (escalations %i) → exact string", (kind, title, escalations, dueWord, expected) => {
    expect(touchMessage(kind, { title, escalations, dueWord })).toBe(expected);
  });

  it("nudge escalations >= 1 always renders the second-nudge variant (cap is 2)", () => {
    expect(touchMessage("nudge", { title: "X", escalations: 5, dueWord: "today" })).toBe(
      'Second nudge — X is still open. Say "stop" and I\'ll park it.',
    );
  });

  it("acks are exact", () => {
    expect(movedAck("Friday")).toBe("Moved to Friday — I'll check back then.");
    expect(movedAck("today")).toBe("Moved to today — I'll check back then.");
    expect(doneAck("Call the bank")).toBe("Marked done — Call the bank.");
    expect(parkedAck("Call the bank")).toBe("Parked — I'll stop texting about Call the bank.");
    expect(quietShiftedAck()).toBe("That lands in quiet hours — I'll text at 9:00 AM instead.");
  });
});

describe("resolveWhenWords (anchor Mon 2026-09-21, 09:00 PT)", () => {
  const resolve = (text: string, now: string = NOW) => resolveWhenWords(text, d(now));

  it.each([
    ["today", "2026-09-21", null],
    ["tomorrow", "2026-09-22", null],
    ["friday", "2026-09-25", null],
    ["sunday", "2026-09-27", null],
    ["tonight", "2026-09-21", { hour: 20, minute: 0 }],
    ["this afternoon", "2026-09-21", { hour: 15, minute: 30 }],
    ["at 3pm", "2026-09-21", { hour: 15, minute: 0 }],
    ["at 3:15pm", "2026-09-21", { hour: 15, minute: 15 }],
    ["at 15:00", "2026-09-21", { hour: 15, minute: 0 }],
    ["tomorrow at 9am", "2026-09-22", { hour: 9, minute: 0 }],
    ["tomorrow at 3:45pm", "2026-09-22", { hour: 15, minute: 45 }],
    ["friday at 2pm", "2026-09-25", { hour: 14, minute: 0 }],
    // Capture prepositions strip; `matched` is the normalized phrase.
    ["by friday", "2026-09-25", null, "friday"],
    ["in 2 hours", "2026-09-21", { hour: 11, minute: 0 }, "in 2 hours"],
    ["in 45 minutes", "2026-09-21", { hour: 9, minute: 45 }, "in 45 minutes"],
    ["in 1 hour", "2026-09-21", { hour: 10, minute: 0 }, "in 1 hour"],
  ])("%s → %s (time %j)", (text, expectedDate, expectedTime, expectedMatched = text) => {
    expect(resolve(text)).toEqual({
      dueDate: expectedDate,
      dueTime: expectedTime,
      matched: expectedMatched,
    });
  });

  it("bare weekday is STRICTLY after today: 'thursday' on a Thursday rolls a week", () => {
    // 2026-09-24 IS a Thursday.
    expect(resolve("thursday", "2026-09-24T16:00:00.000Z")?.dueDate).toBe("2026-10-01");
  });

  it("'friday' asked on a Saturday crosses the week boundary to next Friday", () => {
    // 2026-09-19 is a Saturday.
    expect(resolve("friday", "2026-09-19T17:00:00.000Z")?.dueDate).toBe("2026-09-25");
    expect(resolve("sunday", "2026-09-19T17:00:00.000Z")?.dueDate).toBe("2026-09-20");
  });

  it("'in 2 hours' crossing midnight rolls the due DATE to the local next day", () => {
    // 23:30 PT Sep 21 + 2h → 01:30 PT Sep 22.
    expect(resolve("in 2 hours", "2026-09-22T06:30:00.000Z")).toEqual({
      dueDate: "2026-09-22",
      dueTime: { hour: 1, minute: 30 },
      matched: "in 2 hours",
    });
  });

  it.each([
    "stop",
    "Stop",
    "sometime soon",
    "next week",
    "whenever",
    "remind me to call mom",
    "",
    "at 25:00",
    "at 13pm",
  ])("garbage → null: %s", (text) => {
    expect(resolve(text)).toBeNull();
  });
});

describe("dueWordFor", () => {
  it("due date that IS principal-local today → 'today'", () => {
    expect(dueWordFor("2026-09-21", d(NOW))).toBe("today");
  });

  it("future dates → capitalized weekday name", () => {
    expect(dueWordFor("2026-09-22", d(NOW))).toBe("Tuesday");
    expect(dueWordFor("2026-09-25", d(NOW))).toBe("Friday");
    expect(dueWordFor("2026-09-27", d(NOW))).toBe("Sunday");
  });
});

describe("DST sanity (America/Los_Angeles transitions)", () => {
  it("fall-back: first touch 09:00 on 2026-11-01 is PST (UTC-8), not PDT", () => {
    const r = computeFirstTouch({
      dueDate: "2026-11-01",
      dueTime: null,
      now: d("2026-10-31T16:00:00.000Z"),
    });
    // 09:00 PST = 17:00Z (a summer 09:00 would be 16:00Z).
    expect(r.at.toISOString()).toBe("2026-11-01T17:00:00.000Z");
    expect(r.quietShifted).toBe(false);
  });

  it("spring-forward: 09:00 on 2026-03-07 is PST, on 2026-03-08 already PDT", () => {
    const before = computeFirstTouch({
      dueDate: "2026-03-07",
      dueTime: null,
      now: d("2026-03-06T17:00:00.000Z"),
    });
    expect(before.at.toISOString()).toBe("2026-03-07T17:00:00.000Z");
    const after = computeFirstTouch({
      dueDate: "2026-03-08",
      dueTime: null,
      now: d("2026-03-07T17:00:00.000Z"),
    });
    expect(after.at.toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });

  it("probe→nudge across the fall-back boundary uses CIVIL next-day math", () => {
    // Probe Sat 2026-10-31 15:30 PDT → nudge Sun 2026-11-01 09:00 PST:
    // 18.5 wall-clock hours apart (not 18 instant hours).
    const r = scheduleAfterTouch({ kind: "probe", at: d("2026-10-31T22:30:00.000Z"), escalations: 0 });
    expect(r!.kind).toBe("nudge");
    expect(r!.at.toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });
});

describe("scheduleAfterTouch late-touch edges (verifier D2)", () => {
  const policy = { ...REMINDER_POLICY };
  const probe = (atIso: string, escalations = 0) =>
    scheduleAfterTouch({ kind: "morning", at: new Date(atIso), escalations }, policy);

  it("touch 20:30 PT → probe falls to NEXT workday start (cap 20:00 would precede the touch)", () => {
    const r = probe("2026-09-22T03:30:00.000Z"); // 20:30 PDT Sep 21
    expect(r).not.toBeNull();
    expect(r!.at.toISOString()).toBe("2026-09-22T16:00:00.000Z"); // Tue 09:00 PDT
    expect(r!.kind).toBe("probe");
  });
  it("touch 21:00 PT (+3h wraps midnight) → probe next workday start, never 00:00 quiet", () => {
    const r = probe("2026-09-22T04:00:00.000Z"); // 21:00 PDT Sep 21
    expect(r!.at.toISOString()).toBe("2026-09-22T16:00:00.000Z");
  });
  it("touch 16:00 PT → same-day 19:00 probe still allowed (under the 20:00 cap)", () => {
    const r = probe("2026-09-21T23:00:00.000Z");
    expect(r!.at.toISOString()).toBe("2026-09-22T02:00:00.000Z");
  });
});
