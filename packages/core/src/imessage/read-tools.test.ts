// Phase E read-tool unit tests (no DB): strict route parsing and
// DST-safe server-side day resolution (ig-phase-e-contracts.md §2/§6).

import { describe, expect, it } from "vitest";
import { parseRouteJson, readToolSource, resolveDayBounds } from "./read-tools.js";

describe("parseRouteJson (strict)", () => {
  it("accepts the three tool calls, exactly", () => {
    expect(parseRouteJson('{"tool":"calendar.day","day":"today"}')).toEqual({
      tool: "calendar.day",
      day: "today",
    });
    expect(parseRouteJson('  {"tool":"calendar.day","day":"tomorrow"}  ')).toEqual({
      tool: "calendar.day",
      day: "tomorrow",
    });
    expect(parseRouteJson('{"tool":"calendar.next"}')).toEqual({ tool: "calendar.next" });
    expect(parseRouteJson('{"tool":"commitments.waiting"}')).toEqual({
      tool: "commitments.waiting",
    });
  });

  it("rejects everything else — none, prose, fences, extra keys, wrong enums, invented tools", () => {
    const bad = [
      '{"tool":"none"}',
      '{"tool":"calendar.day"}',
      '{"tool":"calendar.day","day":"next_week"}',
      '{"tool":"calendar.day","day":"today","extra":1}',
      '{"tool":"calendar.next","day":"today"}',
      '{"tool":"calendar.write","day":"today"}',
      '{"tool":"commitments.waiting","limit":5}',
      "sure, happy to help",
      "```json\n{\"tool\":\"calendar.next\"}\n```",
      "[{\"tool\":\"calendar.next\"}]",
      "",
      '{"tool":"CALENDAR.NEXT"}',
    ];
    for (const text of bad) expect(parseRouteJson(text)).toBeNull();
  });

  it("maps tools to their policy sources", () => {
    expect(readToolSource("calendar.day")).toBe("calendar");
    expect(readToolSource("calendar.next")).toBe("calendar");
    expect(readToolSource("commitments.waiting")).toBe("commitments");
  });
});

describe("resolveDayBounds (server-side, DST-safe)", () => {
  // America/Los_Angeles: 2026-11-01 is the fall-back day (25h civil day).
  it("fall-back day: today is 25h long; tomorrow starts at PST midnight", () => {
    const now = new Date("2026-11-01T12:00:00-07:00"); // noon PDT, Nov 1
    const today = resolveDayBounds("today", now);
    expect(today.dayStart.toISOString()).toBe("2026-11-01T07:00:00.000Z"); // 00:00 PDT
    expect(today.dayEnd.toISOString()).toBe("2026-11-02T08:00:00.000Z"); // 00:00 PST (+25h)
    const tomorrow = resolveDayBounds("tomorrow", now);
    expect(tomorrow.dayStart.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(tomorrow.dayEnd.toISOString()).toBe("2026-11-03T08:00:00.000Z");
    expect(tomorrow.dateIso).toBe("2026-11-02");
  });

  // Spring forward: 2027-03-14 is the 23h day.
  it("spring-forward day: today is 23h long", () => {
    const now = new Date("2027-03-14T12:00:00-07:00"); // noon PDT, Mar 14
    const today = resolveDayBounds("today", now);
    expect(today.dayStart.toISOString()).toBe("2027-03-14T08:00:00.000Z"); // 00:00 PDT
    expect(today.dayEnd.toISOString()).toBe("2027-03-15T07:00:00.000Z"); // +23h
  });
});
