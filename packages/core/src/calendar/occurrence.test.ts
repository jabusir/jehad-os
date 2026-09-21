// Occurrence hermetic tests (W5b): render labels (§5 invariant 7 — distinct
// labels end-to-end; scheduled_past_unverified is NEVER presented as
// happened, and sweep-lagged nulls render the same honesty) and the pure
// cross-source proposal builder (proposal only — it has no db access at
// all, so it structurally cannot touch occurrence).

import { describe, expect, it } from "vitest";
import {
  OCCURRENCE_CONFIRMED_LABEL,
  OCCURRENCE_MISSED_LABEL,
  OCCURRENCE_STATES,
  OCCURRENCE_UNVERIFIED_LABEL,
  OccurrenceInputError,
  proposeOccurrenceFromSignal,
  renderOccurrenceHonest,
} from "./occurrence.js";

const NOW = new Date("2026-09-21T18:00:00.000Z");
const H = 3_600_000;

describe("renderOccurrenceHonest (label pins)", () => {
  it("renders the four label states exactly", () => {
    const labels = renderOccurrenceHonest(
      [
        { occurrence: null, endTime: new Date(NOW.getTime() + 2 * H).toISOString() },
        { occurrence: "scheduled_past_unverified", endTime: new Date(NOW.getTime() - 2 * H).toISOString() },
        { occurrence: "observed_occurred", endTime: new Date(NOW.getTime() - 2 * H).toISOString() },
        { occurrence: "observed_missed", endTime: new Date(NOW.getTime() - 2 * H).toISOString() },
      ],
      NOW,
    );
    expect(labels).toEqual([
      "",
      "(unverified — I can't confirm it happened)",
      "(confirmed)",
      "(didn't happen, per you)",
    ]);
    expect(labels[1]).toBe(OCCURRENCE_UNVERIFIED_LABEL);
    expect(labels[2]).toBe(OCCURRENCE_CONFIRMED_LABEL);
    expect(labels[3]).toBe(OCCURRENCE_MISSED_LABEL);
  });

  it("a null occurrence past the grace renders unverified — sweep lag never yields an implicit 'happened'", () => {
    const labels = renderOccurrenceHonest(
      [
        { occurrence: null, endTime: new Date(NOW.getTime() - 31 * 60_000).toISOString() },
        { occurrence: null, endTime: new Date(NOW.getTime() - 29 * 60_000).toISOString() },
      ],
      NOW,
    );
    expect(labels).toEqual([OCCURRENCE_UNVERIFIED_LABEL, ""]);
  });

  it("null end times render as upcoming (never unverified by guesswork)", () => {
    expect(renderOccurrenceHonest([{ occurrence: null }], NOW)).toEqual([""]);
    expect(renderOccurrenceHonest([{ occurrence: null, endTime: null }], NOW)).toEqual([""]);
  });

  it("unparseable end times degrade to upcoming, not to a thrown render", () => {
    expect(renderOccurrenceHonest([{ occurrence: null, endTime: "not-a-date" }], NOW)).toEqual([""]);
  });
});

describe("proposeOccurrenceFromSignal (pure builder)", () => {
  const EVENT_ID = "1ef0c3a0-0000-4000-8000-000000000001";

  it("builds a cross_source_proposed payload that proposes, never graduates", () => {
    const at = new Date("2026-09-21T19:05:00.000Z");
    const proposal = proposeOccurrenceFromSignal({
      calendarEventId: EVENT_ID,
      signalSource: "adapter:gmail",
      evidenceSummary: "confirmation email from restaurant@example.com",
      now: at,
    });
    expect(proposal).toEqual({
      calendarEventId: EVENT_ID,
      targetOccurrence: "observed_occurred",
      proposedBy: { kind: "cross_source_proposed", source: "adapter:gmail", at: at.toISOString() },
      evidenceSummary: "confirmation email from restaurant@example.com",
      question:
        "Cross-source signal (adapter:gmail): confirmation email from restaurant@example.com. " +
        "Did this event happen?",
    });
  });

  it("validates its inputs", () => {
    expect(() =>
      proposeOccurrenceFromSignal({
        calendarEventId: "not-a-uuid",
        signalSource: "adapter:gmail",
        evidenceSummary: "x",
      }),
    ).toThrow(OccurrenceInputError);
    expect(() =>
      proposeOccurrenceFromSignal({
        calendarEventId: EVENT_ID,
        signalSource: "  ",
        evidenceSummary: "x",
      }),
    ).toThrow(OccurrenceInputError);
    expect(() =>
      proposeOccurrenceFromSignal({
        calendarEventId: EVENT_ID,
        signalSource: "adapter:gmail",
        evidenceSummary: "",
      }),
    ).toThrow(OccurrenceInputError);
  });
});

describe("occurrence vocabulary", () => {
  it("pins the three states (planned ≠ unverified ≠ observed)", () => {
    expect(OCCURRENCE_STATES).toEqual([
      "scheduled_past_unverified",
      "observed_occurred",
      "observed_missed",
    ]);
  });
});
