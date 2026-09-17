// Pure change-detection unit tests (E3): normalization (calendar-native
// times, all-day handling, attendee stripping/sorting, sparse metadata) and
// the full classification matrix against a stored snapshot. Hermetic — no
// DB, no clock.

import { describe, expect, it } from "vitest";
import type { GoogleCalendarEvent } from "@jehad/adapters";
import {
  calendarContentHash,
  classifyCalendarChange,
  normalizeGoogleCalendarEvent,
  stableStringify,
  type CalendarProjectionSnapshot,
} from "./change-detection.js";

function googleEvent(overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id: "evt-1",
    iCalUID: "evt-1@google.com",
    status: "confirmed",
    summary: "Dentist",
    start: { dateTime: "2026-09-18T09:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-09-18T10:00:00-04:00", timeZone: "America/New_York" },
    attendees: [
      { email: "jejo@example.com", displayName: "Jehad" },
      { email: "sam@example.com" },
    ],
    location: "12 Creek Rd",
    hangoutLink: "https://meet.google.com/abc",
    updated: "2026-09-16T20:01:00.000Z",
    ...overrides,
  };
}

describe("normalizeGoogleCalendarEvent", () => {
  it("normalizes calendar-native times to UTC instants and keeps the timezone", () => {
    const normalized = normalizeGoogleCalendarEvent(googleEvent());
    expect(normalized.start).toBe("2026-09-18T13:00:00.000Z");
    expect(normalized.end).toBe("2026-09-18T14:00:00.000Z");
    expect(normalized.timezone).toBe("America/New_York");
  });

  it("all-day events land as UTC midnight of the calendar-native date", () => {
    const normalized = normalizeGoogleCalendarEvent(
      googleEvent({ start: { date: "2026-09-20" }, end: { date: "2026-09-21" } }),
    );
    expect(normalized.start).toBe("2026-09-20T00:00:00.000Z");
    expect(normalized.end).toBe("2026-09-21T00:00:00.000Z");
  });

  it("keeps emails+names only, drops response metadata, sorts attendees by email", () => {
    const normalized = normalizeGoogleCalendarEvent(
      googleEvent({
        attendees: [
          { email: "zoe@example.com", displayName: "Zoe" },
          { email: "abe@example.com" },
          { email: "abe@example.com", displayName: "Abe" },
        ],
      }),
    );
    expect(normalized.attendees).toEqual([
      { email: "abe@example.com", name: null },
      { email: "abe@example.com", name: "Abe" },
      { email: "zoe@example.com", name: "Zoe" },
    ]);
  });

  it("metadata is sparse: recurring flag, hangout link, iCalUID; googleUpdated is kept but unhashed", () => {
    const normalized = normalizeGoogleCalendarEvent(
      googleEvent({ recurrence: ["RRULE:FREQ=DAILY"] }),
    );
    expect(normalized.metadata).toEqual({
      recurring: true,
      hangoutLink: "https://meet.google.com/abc",
      iCalUid: "evt-1@google.com",
    });
    expect(normalized.googleUpdated).toBe("2026-09-16T20:01:00.000Z");

    const bumpedUpdated = normalizeGoogleCalendarEvent(
      googleEvent({ recurrence: ["RRULE:FREQ=DAILY"], updated: "2026-09-17T00:00:00.000Z" }),
    );
    expect(bumpedUpdated.contentHash).toBe(normalized.contentHash);
  });

  it("minimal cancelled payloads normalize with null times and empty summary", () => {
    const normalized = normalizeGoogleCalendarEvent({
      id: "evt-x",
      status: "cancelled",
      updated: "2026-09-17T07:00:00.000Z",
    });
    expect(normalized.status).toBe("cancelled");
    expect(normalized.start).toBeNull();
    expect(normalized.end).toBeNull();
    expect(normalized.summary).toBe("");
    expect(normalized.attendees).toEqual([]);
  });

  it("content hash is stable across key order, unstable across content", () => {
    const base = {
      status: "confirmed" as const,
      summary: "S",
      start: "2026-09-18T13:00:00.000Z",
      end: "2026-09-18T14:00:00.000Z",
      timezone: "UTC",
      attendees: [
        { email: "b@example.com", name: null },
        { email: "a@example.com", name: null },
      ],
      location: null,
      metadata: { recurring: false, hangoutLink: null, iCalUid: null },
    };
    const reordered = {
      timezone: "UTC",
      end: base.end,
      attendees: base.attendees,
      location: null,
      metadata: { hangoutLink: null, iCalUid: null, recurring: false },
      start: base.start,
      summary: "S",
      status: "confirmed" as const,
    };
    expect(calendarContentHash(reordered)).toBe(calendarContentHash(base));
    expect(calendarContentHash({ ...base, summary: "S2" })).not.toBe(calendarContentHash(base));
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  it("throws TypeError on a missing id", () => {
    expect(() => normalizeGoogleCalendarEvent({} as GoogleCalendarEvent)).toThrow(TypeError);
  });
});

describe("classifyCalendarChange", () => {
  function snapshot(
    googleOverrides: Partial<GoogleCalendarEvent> = {},
    rowOverrides: Partial<CalendarProjectionSnapshot> = {},
  ): CalendarProjectionSnapshot {
    const normalized = normalizeGoogleCalendarEvent(googleEvent(googleOverrides));
    return {
      status: normalized.status,
      startTime: normalized.start,
      endTime: normalized.end,
      attendees: normalized.attendees,
      contentHash: normalized.contentHash,
      ...rowOverrides,
    };
  }

  it("no row → created", () => {
    expect(classifyCalendarChange(null, normalizeGoogleCalendarEvent(googleEvent())).changeClass).toBe("created");
  });

  it("equal contentHash → unchanged (even if stored fields were hand-edited)", () => {
    const incoming = normalizeGoogleCalendarEvent(googleEvent());
    expect(classifyCalendarChange(snapshot(), incoming).changeClass).toBe("unchanged");
  });

  it("status flip to cancelled → cancelled (dominates other diffs), with previous times", () => {
    const incoming = normalizeGoogleCalendarEvent(
      googleEvent({ status: "cancelled", summary: "whatever now", updated: "2026-09-17T07:00:00.000Z" }),
    );
    const classification = classifyCalendarChange(snapshot(), incoming);
    expect(classification.changeClass).toBe("cancelled");
    expect(classification.previousStart).toBe("2026-09-18T13:00:00.000Z");
    expect(classification.previousEnd).toBe("2026-09-18T14:00:00.000Z");
  });

  it("resurrection (cancelled → confirmed) classifies as updated when times match", () => {
    const stored = snapshot({ status: "cancelled" });
    const incoming = normalizeGoogleCalendarEvent(googleEvent({ status: "confirmed" }));
    expect(classifyCalendarChange(stored, incoming).changeClass).toBe("updated");
  });
  it("start or end moved → start_end_changed with previous times", () => {
    const incoming = normalizeGoogleCalendarEvent(
      googleEvent({ start: { dateTime: "2026-09-18T11:00:00-04:00", timeZone: "America/New_York" } }),
    );
    const classification = classifyCalendarChange(snapshot(), incoming);
    expect(classification.changeClass).toBe("start_end_changed");
    expect(classification.previousStart).toBe("2026-09-18T13:00:00.000Z");
    expect(classification.previousEnd).toBe("2026-09-18T14:00:00.000Z");
  });

  it("offset format change for the same instant is NOT a start change", () => {
    const incoming = normalizeGoogleCalendarEvent(
      googleEvent({ start: { dateTime: "2026-09-18T13:00:00.000Z", timeZone: "UTC" } }),
    );
    expect(classifyCalendarChange(snapshot(), incoming).changeClass).toBe("updated"); // timezone text changed, instant did not
  });

  it("attendee set/name change → attendees_changed; response-status-only stays unchanged by hash", () => {
    const added = normalizeGoogleCalendarEvent(
      googleEvent({
        attendees: [
          { email: "jejo@example.com", displayName: "Jehad" },
          { email: "sam@example.com" },
          { email: "new@example.com", displayName: "New" },
        ],
      }),
    );
    expect(classifyCalendarChange(snapshot(), added).changeClass).toBe("attendees_changed");

    // Same emails+names, different order → same hash → unchanged.
    expect(
      classifyCalendarChange(snapshot(), normalizeGoogleCalendarEvent(
        googleEvent({ attendees: [
          { email: "sam@example.com" },
          { email: "jejo@example.com", displayName: "Jehad" },
        ] }),
      )).changeClass,
    ).toBe("unchanged");
  });

  it("summary-only or location-only change → updated", () => {
    expect(
      classifyCalendarChange(snapshot(), normalizeGoogleCalendarEvent(googleEvent({ summary: "Dentist (rescheduled label)" }))).changeClass,
    ).toBe("updated");
    expect(
      classifyCalendarChange(snapshot(), normalizeGoogleCalendarEvent(googleEvent({ location: "13 Creek Rd" }))).changeClass,
    ).toBe("updated");
  });

  it("minimal cancelled payload against a stored row → cancelled with previous times", () => {
    const incoming = normalizeGoogleCalendarEvent({ id: "evt-1", status: "cancelled", updated: "2026-09-17T07:00:00.000Z" });
    const classification = classifyCalendarChange(snapshot(), incoming);
    expect(classification.changeClass).toBe("cancelled");
    expect(classification.previousStart).toBe("2026-09-18T13:00:00.000Z");
  });
});
