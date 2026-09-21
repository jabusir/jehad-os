// W5(d) hermetic unit tests: the PURE churn classifier matrix, the
// honesty-pinned render goldens (plan churn ONLY — "happened"/"occurred"
// appear only inside the sanctioned unverified caveat), and suppression.
// No DB, no clock.

import { describe, expect, it } from "vitest";
import {
  churnFromObservations,
  DIVERGENCE_ITEM_LIMIT,
  renderDivergenceBlock,
  type CalendarObservation,
  type DivergenceResult,
} from "./divergence.js";

// 2026-09-17, PDT (UTC-7): civil day [07:00Z Sep 17, 07:00Z Sep 18).
const DAY_START = Date.parse("2026-09-17T07:00:00.000Z");
const DAY_END = Date.parse("2026-09-18T07:00:00.000Z");

function obs(over: Partial<CalendarObservation>): CalendarObservation {
  return {
    changeClass: "start_end_changed",
    googleEventId: "evt-1",
    summary: "Henna sync",
    start: "2026-09-17T23:00:00.000Z",
    previousStart: null,
    ...over,
  };
}

describe("churnFromObservations (pure classifier)", () => {
  it("a same-day move counts as churn (new start in the day)", () => {
    const items = churnFromObservations(
      [obs({ previousStart: "2026-09-17T17:00:00.000Z", start: "2026-09-17T23:00:00.000Z" })],
      { dayStart: DAY_START, dayEnd: DAY_END },
    );
    expect(items).toEqual([
      { googleEventId: "evt-1", title: "Henna sync", changeKind: "moved" },
    ]);
  });

  it("a move OFF the day still churned (previous start in the day)", () => {
    const items = churnFromObservations(
      [obs({ previousStart: "2026-09-17T23:00:00.000Z", start: "2026-09-18T20:00:00.000Z" })],
      { dayStart: DAY_START, dayEnd: DAY_END },
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.changeKind).toBe("moved");
  });

  it("a move INTO the day from yesterday counts (planned yesterday, churned into today is a same-day mutation of today's plan)", () => {
    const items = churnFromObservations(
      [obs({ previousStart: "2026-09-16T20:00:00.000Z", start: "2026-09-17T23:00:00.000Z" })],
      { dayStart: DAY_START, dayEnd: DAY_END },
    );
    expect(items).toHaveLength(1);
  });

  it("a same-day cancellation counts; an empty summary renders (untitled)", () => {
    const items = churnFromObservations(
      [obs({ changeClass: "cancelled", previousStart: "2026-09-17T21:00:00.000Z", start: null, summary: "" })],
      { dayStart: DAY_START, dayEnd: DAY_END },
    );
    expect(items).toEqual([
      { googleEventId: "evt-1", title: "(untitled)", changeKind: "cancelled" },
    ]);
  });

  it("non-disruptive classes never count as divergence (attendees_changed / updated / created)", () => {
    const items = churnFromObservations(
      [
        obs({ changeClass: "attendees_changed", previousStart: "2026-09-17T17:00:00.000Z" }),
        obs({ changeClass: "updated", previousStart: null }),
        obs({ changeClass: "created" }),
      ],
      { dayStart: DAY_START, dayEnd: DAY_END },
    );
    expect(items).toHaveLength(0);
  });

  it("mutations entirely outside the civil day never count", () => {
    const items = churnFromObservations(
      [
        obs({ previousStart: "2026-09-16T17:00:00.000Z", start: "2026-09-16T19:00:00.000Z" }),
        obs({ changeClass: "cancelled", previousStart: "2026-09-19T17:00:00.000Z", start: null }),
        obs({ previousStart: null, start: null, changeClass: "cancelled" }),
      ],
      { dayStart: DAY_START, dayEnd: DAY_END },
    );
    expect(items).toHaveLength(0);
  });

  it("repeated mutations of one google event dedupe: latest observation wins", () => {
    const items = churnFromObservations(
      [
        obs({ googleEventId: "evt-1", previousStart: "2026-09-17T17:00:00.000Z", start: "2026-09-17T23:00:00.000Z" }),
        obs({ googleEventId: "evt-1", changeClass: "cancelled", previousStart: "2026-09-17T23:00:00.000Z", start: null }),
      ],
      { dayStart: DAY_START, dayEnd: DAY_END },
    );
    expect(items).toEqual([
      { googleEventId: "evt-1", title: "Henna sync", changeKind: "cancelled" },
    ]);
  });
});

describe("renderDivergenceBlock (honesty-pinned goldens)", () => {
  const result: DivergenceResult = {
    day: "2026-09-17",
    churnedCount: 2,
    plannedCount: 3,
    items: [
      { googleEventId: "evt-1", title: "Henna sync", changeKind: "moved" },
      { googleEventId: "evt-2", title: "Venue tour", changeKind: "cancelled" },
    ],
  };

  it("renders the pinned plan-churn block exactly", () => {
    expect(renderDivergenceBlock(result)).toEqual([
      "Plan churn",
      "- 2 of 3 blocks moved or cancelled same-day. That's plan divergence — what actually happened is unverified.",
      "- Henna sync — moved",
      "- Venue tour — cancelled",
    ]);
  });

  it("honesty pin: 'happened'/'occurred' appear ONLY inside the unverified caveat — never attached to churn as fact", () => {
    const block = renderDivergenceBlock(result).join("\n");
    expect(block).toContain("plan divergence");
    expect(block).toContain("unverified");
    const caveat = "what actually happened is unverified";
    const stripped = block.replaceAll(caveat, "");
    expect(stripped).not.toMatch(/happened|occurred/i);
  });

  it("caps item lines and adds the overflow marker", () => {
    const many: DivergenceResult = {
      day: "2026-09-17",
      churnedCount: DIVERGENCE_ITEM_LIMIT + 2,
      plannedCount: 9,
      items: Array.from({ length: DIVERGENCE_ITEM_LIMIT + 2 }, (_, i) => ({
        googleEventId: `evt-${i}`,
        title: `Block ${i}`,
        changeKind: "moved" as const,
      })),
    };
    const lines = renderDivergenceBlock(many);
    expect(lines).toHaveLength(2 + DIVERGENCE_ITEM_LIMIT + 1);
    expect(lines.at(-1)).toBe(`- …and 2 more`);
  });
});
