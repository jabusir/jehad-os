// Phase H propose-flow unit tests (no DB): strict wall-clock parsing and
// DST-correct server-side schedule resolution (BRIEF_TIMEZONE semantics).

import { describe, expect, it } from "vitest";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";
import {
  PROPOSE_CLARIFICATION_TIME,
  PROPOSE_DEFAULT_DURATION_MINUTES,
  parseWallClock,
  resolveProposedSchedule,
} from "./propose-schedule.js";

function civilClock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(iso));
}

describe("parseWallClock (strict)", () => {
  it("accepts the contracted forms exactly", () => {
    const cases: readonly (readonly [string, number, number])[] = [
      ["7", 7, 0],
      ["7pm", 19, 0],
      ["7 pm", 19, 0],
      ["7:30pm", 19, 30],
      ["7:30 pm", 19, 30],
      ["7Pm", 19, 0],
      ["19:00", 19, 0],
      ["19:30", 19, 30],
      ["09:00", 9, 0],
      ["9:00am", 9, 0],
      ["12pm", 12, 0],
      ["12am", 0, 0],
      ["11:59 pm", 23, 59],
      ["0", 0, 0],
      ["23", 23, 0],
      ["7:30", 7, 30],
      ["12:30 pm", 12, 30],
      [" 7pm ", 19, 0],
    ];
    for (const [text, hour, minute] of cases) {
      expect(parseWallClock(text), text).toEqual({ hour, minute });
    }
  });

  it("rejects empty, over-length, out-of-range, and garbage input", () => {
    const bad = [
      "",
      "   ",
      "25:00",
      "7:60",
      "12:5",
      "7pm tomorrow",
      "7:30pm!",
      "13pm",
      "24",
      "7:0",
      "one",
      "7.30pm",
    ];
    for (const text of bad) expect(parseWallClock(text), text).toBeNull();
  });
});

describe("resolveProposedSchedule (server-side, DST-safe)", () => {
  const NOW_10AM = new Date("2026-09-19T10:00:00-07:00");

  it("time null → time-missing (no default-time proposals)", () => {
    expect(resolveProposedSchedule({ day: "today", time: null, endTime: null, durationMinutes: 60 }, NOW_10AM)).toEqual({
      ok: false,
      reason: "time-missing",
    });
    expect(
      resolveProposedSchedule({ day: "tomorrow", time: null, endTime: null, durationMinutes: null }, NOW_10AM),
    ).toEqual({ ok: false, reason: "time-missing" });
  });

  it("unparsable time → time-unparsable", () => {
    for (const time of ["banana", "25:00", "7:60", ""]) {
      expect(
        resolveProposedSchedule({ day: "today", time, endTime: null, durationMinutes: 60 }, NOW_10AM),
        time,
      ).toEqual({ ok: false, reason: "time-unparsable" });
    }
  });

  it("today 7pm with default duration 60", () => {
    const r = resolveProposedSchedule(
      { day: "today", time: "7pm", durationMinutes: null },
      NOW_10AM,
    );
    expect(r).toEqual({
      ok: true,
      startIso: "2026-09-20T02:00:00.000Z",
      endIso: "2026-09-20T03:00:00.000Z",
      dateIso: "2026-09-19",
    });
  });

  it("tomorrow 9:00am with explicit 30-minute duration", () => {
    const r = resolveProposedSchedule(
      { day: "tomorrow", time: "9:00am", durationMinutes: 30 },
      NOW_10AM,
    );
    expect(r).toEqual({
      ok: true,
      startIso: "2026-09-20T16:00:00.000Z",
      endIso: "2026-09-20T16:30:00.000Z",
      dateIso: "2026-09-20",
    });
  });

  it("24h colon form resolves as wall 24h time", () => {
    const r = resolveProposedSchedule(
      { day: "today", time: "19:30", durationMinutes: 90 },
      NOW_10AM,
    );
    expect(r).toEqual({
      ok: true,
      startIso: "2026-09-20T02:30:00.000Z",
      endIso: "2026-09-20T04:00:00.000Z",
      dateIso: "2026-09-19",
    });
  });

  it("bare '7' at 10am → today 19:00 (next occurrence, pm sooner)", () => {
    const r = resolveProposedSchedule({ day: "today", time: "7", endTime: null, durationMinutes: 60 }, NOW_10AM);
    expect(r).toEqual({
      ok: true,
      startIso: "2026-09-20T02:00:00.000Z",
      endIso: "2026-09-20T03:00:00.000Z",
      dateIso: "2026-09-19",
    });
  });

  it("bare '7' at 8pm → tomorrow 07:00 (both of today's occurrences past)", () => {
    const now = new Date("2026-09-19T20:00:00-07:00");
    const r = resolveProposedSchedule({ day: "today", time: "7", endTime: null, durationMinutes: 60 }, now);
    expect(r).toEqual({
      ok: true,
      startIso: "2026-09-20T14:00:00.000Z",
      endIso: "2026-09-20T15:00:00.000Z",
      dateIso: "2026-09-20",
    });
  });

  it("bare '7' at 6am → today 07:00 (am occurrence sooner)", () => {
    const now = new Date("2026-09-19T06:00:00-07:00");
    const r = resolveProposedSchedule({ day: "today", time: "7", endTime: null, durationMinutes: 60 }, now);
    expect(r).toEqual({
      ok: true,
      startIso: "2026-09-19T14:00:00.000Z",
      endIso: "2026-09-19T15:00:00.000Z",
      dateIso: "2026-09-19",
    });
  });

  it("bare '3' at 10am → today 15:00 (rule generalizes past 7-11)", () => {
    const r = resolveProposedSchedule({ day: "today", time: "3", endTime: null, durationMinutes: 60 }, NOW_10AM);
    expect(r).toEqual({
      ok: true,
      startIso: "2026-09-19T22:00:00.000Z",
      endIso: "2026-09-19T23:00:00.000Z",
      dateIso: "2026-09-19",
    });
  });

  it("bare '7' exactly at 19:00:00 → tomorrow 07:00 (strictly-future boundary)", () => {
    const now = new Date("2026-09-19T19:00:00-07:00");
    const r = resolveProposedSchedule({ day: "today", time: "7", endTime: null, durationMinutes: 60 }, now);
    expect(r).toEqual({
      ok: true,
      startIso: "2026-09-20T14:00:00.000Z",
      endIso: "2026-09-20T15:00:00.000Z",
      dateIso: "2026-09-20",
    });
  });

  it("bare '7' with day=tomorrow at 10am → tomorrow 07:00 (sooner future candidate)", () => {
    const r = resolveProposedSchedule(
      { day: "tomorrow", time: "7", durationMinutes: 60 },
      NOW_10AM,
    );
    expect(r).toEqual({
      ok: true,
      startIso: "2026-09-20T14:00:00.000Z",
      endIso: "2026-09-20T15:00:00.000Z",
      dateIso: "2026-09-20",
    });
  });

  it("bare 24h hours (13) are unambiguous: today while future, tomorrow once past", () => {
    const morning = resolveProposedSchedule(
      { day: "today", time: "13", durationMinutes: 60 },
      NOW_10AM,
    );
    expect(morning).toEqual({
      ok: true,
      startIso: "2026-09-19T20:00:00.000Z",
      endIso: "2026-09-19T21:00:00.000Z",
      dateIso: "2026-09-19",
    });
    const evening = new Date("2026-09-19T20:00:00-07:00");
    const rolled = resolveProposedSchedule(
      { day: "today", time: "13", durationMinutes: 60 },
      evening,
    );
    expect(rolled).toEqual({
      ok: true,
      startIso: "2026-09-20T20:00:00.000Z",
      endIso: "2026-09-20T21:00:00.000Z",
      dateIso: "2026-09-20",
    });
  });

  it("spring forward: end = exact instant math (1:30am + 60min ends 3:30am wall)", () => {
    const now = new Date("2027-03-13T18:00:00-07:00");
    const r = resolveProposedSchedule(
      { day: "tomorrow", time: "1:30am", durationMinutes: 60 },
      now,
    );
    expect(r).toEqual({
      ok: true,
      startIso: "2027-03-14T09:30:00.000Z",
      endIso: "2027-03-14T10:30:00.000Z",
      dateIso: "2027-03-14",
    });
    expect(Date.parse(r.ok ? r.endIso : "") - Date.parse(r.ok ? r.startIso : "")).toBe(60 * 60_000);
    expect(civilClock(r.ok ? r.startIso : "")).toBe("1:30 AM");
    expect(civilClock(r.ok ? r.endIso : "")).toBe("3:30 AM");
  });

  it("spring forward: nonexistent 2am resolves to the shifted instant 3:00am", () => {
    const now = new Date("2027-03-13T18:00:00-07:00");
    const r = resolveProposedSchedule(
      { day: "tomorrow", time: "2am", durationMinutes: PROPOSE_DEFAULT_DURATION_MINUTES },
      now,
    );
    expect(r).toEqual({
      ok: true,
      startIso: "2027-03-14T10:00:00.000Z",
      endIso: "2027-03-14T11:00:00.000Z",
      dateIso: "2027-03-14",
    });
    expect(civilClock(r.ok ? r.startIso : "")).toBe("3:00 AM");
  });

  it("fall back: ambiguous 1:30am resolves to the first occurrence; end exact", () => {
    const now = new Date("2026-10-31T12:00:00-07:00");
    const r = resolveProposedSchedule(
      { day: "tomorrow", time: "1:30am", durationMinutes: 60 },
      now,
    );
    expect(r).toEqual({
      ok: true,
      startIso: "2026-11-01T08:30:00.000Z",
      endIso: "2026-11-01T09:30:00.000Z",
      dateIso: "2026-11-01",
    });
    expect(civilClock(r.ok ? r.startIso : "")).toBe("1:30 AM");
    expect(civilClock(r.ok ? r.endIso : "")).toBe("1:30 AM");
  });

  it("exports the fixed clarification string and default duration", () => {
    expect(PROPOSE_CLARIFICATION_TIME).toBe("What time should I put it at? Reply like: at 7pm.");
    expect(PROPOSE_DEFAULT_DURATION_MINUTES).toBe(60);
  });
});

  it("pinned PAST wall time on today rolls to tomorrow's same wall time (11pm 'at 7pm' case)", () => {
    // 23:00 PDT on 2026-09-19 (a Saturday). "at 7pm" today is past.
    const late = new Date("2026-09-19T23:00:00.000-07:00");
    const r = resolveProposedSchedule({ day: "today", time: "7pm", endTime: null, durationMinutes: null }, late);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.startIso).toBe("2026-09-21T02:00:00.000Z"); // tomorrow 7:00 PM PDT
      expect(r.dateIso).toBe("2026-09-20");
    }
  });

  it("pinned FUTURE wall time on today does NOT roll", () => {
    const morning = new Date("2026-09-19T09:00:00.000-07:00");
    const r = resolveProposedSchedule({ day: "today", time: "7pm", endTime: null, durationMinutes: null }, morning);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.startIso).toBe("2026-09-20T02:00:00.000Z"); // today 7 PM PDT
  });

  it("explicit end time derives duration (the Henna case: 2pm–11pm = 540m)", () => {
    const nowAnchor = new Date("2026-09-19T10:00:00-07:00");
    const r = resolveProposedSchedule(
      { day: "tomorrow", time: "2pm", endTime: "11pm", durationMinutes: null },
      nowAnchor,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(new Date(r.endIso).getTime() - new Date(r.startIso).getTime()).toBe(540 * 60_000);
    }
  });

  it("overnight range rolls the end past midnight (9pm–2am = 300m)", () => {
    const nowAnchor = new Date("2026-09-19T10:00:00-07:00");
    const r = resolveProposedSchedule(
      { day: "tomorrow", time: "9pm", endTime: "2am", durationMinutes: null },
      nowAnchor,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(new Date(r.endIso).getTime() - new Date(r.startIso).getTime()).toBe(5 * 60 * 60_000);
    }
  });

  it("range bounds: <15m and >12h are range-invalid; end unparsable is end-unparsable", () => {
    const nowAnchor = new Date("2026-09-19T10:00:00-07:00");
    expect(
      resolveProposedSchedule({ day: "tomorrow", time: "2pm", endTime: "2:10pm", durationMinutes: null }, nowAnchor),
    ).toEqual({ ok: false, reason: "range-invalid" });
    expect(
      resolveProposedSchedule({ day: "tomorrow", time: "8am", endTime: "9pm", durationMinutes: null }, nowAnchor),
    ).toEqual({ ok: false, reason: "range-invalid" });
    expect(
      resolveProposedSchedule({ day: "tomorrow", time: "2pm", endTime: "banana", durationMinutes: null }, nowAnchor),
    ).toEqual({ ok: false, reason: "end-unparsable" });
  });
