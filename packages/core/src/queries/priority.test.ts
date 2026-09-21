import { describe, expect, it } from "vitest";
import {
  buildPriorityResults,
  renderPriorityLine,
  topPriorities,
  type ImminentEventInput,
  type OverdueFollowUpInput,
  type PriorityBuildInputs,
  type WaitingAgingInput,
} from "./priority.js";
import type { LeverageDecision } from "./leverage.js";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

const daysAgo = (n: number): string => new Date(NOW.getTime() - n * MS_PER_DAY).toISOString();
const hoursAhead = (n: number): string => new Date(NOW.getTime() + n * MS_PER_HOUR).toISOString();

function unlockStub(over: {
  transitive: number;
  direct: number;
  labels?: string[];
}): LeverageDecision {
  return {
    decisionId: "11111111-1111-4111-8111-111111111111",
    question: "Choose the migration approach",
    chosen: "Strangler fig",
    domainKey: "personal",
    decidedAt: daysAgo(10),
    directDownstreamCount: over.direct,
    transitiveDownstreamCount: over.transitive,
    topBlockedItems: (over.labels ?? ["Task B: draft schema"]).map((label) => ({
      itemType: "commitment",
      itemId: "22222222-2222-4222-8222-222222222222",
      label,
      depth: 1,
    })),
  };
}

function inputs(over: {
  overdue?: readonly OverdueFollowUpInput[];
  unlock?: LeverageDecision | null;
  imminent?: readonly ImminentEventInput[];
  aging?: readonly WaitingAgingInput[];
}): PriorityBuildInputs {
  return {
    now: NOW,
    overdueFollowUps: over.overdue ?? [],
    unlock: over.unlock === undefined ? null : over.unlock,
    imminentEvents: over.imminent ?? [],
    waitingAging: over.aging ?? [],
  };
}

describe("buildPriorityResults (fixture matrices)", () => {
  it("kind precedence: blocking-overdue > unlock > imminent > aging with pinned scores", () => {
    const results = buildPriorityResults(
      inputs({
        overdue: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            description: "Henna owes the venue confirmation",
            counterpartyText: "Henna",
            dueAt: daysAgo(3),
            downstreamLabels: ["Venue deposit"],
          },
        ],
        unlock: unlockStub({ transitive: 5, direct: 3, labels: ["Task B: draft schema"] }),
        imminent: [
          {
            googleEventId: "evt-1",
            summary: "Henna sync",
            startTime: hoursAhead(2),
          },
        ],
        aging: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            description: "Acme owes Jehad the signed SOW",
            counterpartyText: "Acme Corp",
            createdAt: daysAgo(8),
            dueAt: daysAgo(2),
          },
        ],
      }),
    );
    expect(results.map((r) => r.kind)).toEqual([
      "overdue_follow_up",
      "blocked_unlock",
      "calendar_imminent",
      "waiting_aging",
    ]);
    expect(results.map((r) => r.score)).toEqual([69, 50, 35, 26]);
    expect(results[0]!.reason).toEqual([
      "3 days overdue",
      "may_follow_up is on",
      "Venue deposit is blocked on this",
    ]);
    expect(results[1]!.reason).toEqual([
      "unblocks 5 downstream items (3 direct)",
      "Task B: draft schema is blocked on this",
    ]);
    expect(results[2]!.reason).toEqual(["in 2h"]);
    expect(results[3]!.reason).toEqual(["waiting on Acme Corp for 8 days"]);
    expect(results[0]!.ref).toBe("commitment:33333333-3333-4333-8333-333333333333");
    expect(results[2]!.summary).toBe("7 AM Henna sync");
  });

  it("a blocking-overdue item outranks even a maximum unlock", () => {
    const results = buildPriorityResults(
      inputs({
        overdue: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            description: "Henna owes the venue confirmation",
            counterpartyText: "Henna",
            dueAt: daysAgo(2),
            downstreamLabels: ["Venue deposit", "Catering deposit", "Task C"],
          },
        ],
        unlock: unlockStub({ transitive: 10, direct: 10, labels: ["A", "B", "C", "D", "E"] }),
      }),
    );
    expect(results[0]!.kind).toBe("overdue_follow_up");
    expect(results[0]!.score).toBe(72);
    expect(results[1]!.score).toBe(70);
  });

  it("score ties break by kind precedence (overdue before imminent)", () => {
    const results = buildPriorityResults(
      inputs({
        overdue: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            description: "Reply due hours ago",
            counterpartyText: "Henna",
            dueAt: new Date(NOW.getTime() - 12 * MS_PER_HOUR).toISOString(),
            downstreamLabels: [],
          },
        ],
        imminent: [{ googleEventId: "evt-1", summary: "Henna sync", startTime: hoursAhead(0.5) }],
      }),
    );
    expect(results.map((r) => r.score)).toEqual([55, 55]);
    expect(results.map((r) => r.kind)).toEqual(["overdue_follow_up", "calendar_imminent"]);
    expect(results[0]!.reason).toContain("overdue today");
    expect(results[1]!.reason).toEqual(["in under an hour"]);
  });

  it("same score + kind breaks by due date asc, then ref asc", () => {
    const overdue = (id: string, dueAt: string): OverdueFollowUpInput => ({
      id,
      description: `Item ${id}`,
      counterpartyText: "X",
      dueAt,
      downstreamLabels: [],
    });
    const byDue = buildPriorityResults(
      inputs({
        overdue: [overdue("b", daysAgo(2)), overdue("a", daysAgo(3))],
      }),
    );
    expect(byDue.map((r) => r.ref)).toEqual(["commitment:a", "commitment:b"]);
    const byRef = buildPriorityResults(
      inputs({
        overdue: [overdue("b", daysAgo(2)), overdue("a", daysAgo(2))],
      }),
    );
    expect(byRef.map((r) => r.ref)).toEqual(["commitment:a", "commitment:b"]);
  });

  it("imminent buckets: <1h 55, 1–2h 45, 2–3h 35 (inclusive 3h boundary)", () => {
    const results = buildPriorityResults(
      inputs({
        imminent: [
          { googleEventId: "e3", summary: "E3", startTime: hoursAhead(3) },
          { googleEventId: "e2", summary: "E2", startTime: hoursAhead(2) },
          { googleEventId: "e1", summary: "E1", startTime: hoursAhead(1) },
          { googleEventId: "e0", summary: "E0", startTime: hoursAhead(0.5) },
        ],
      }),
    );
    expect(results.map((r) => r.score)).toEqual([55, 45, 35, 35]);
    expect(results.map((r) => r.reason[0])).toEqual([
      "in under an hour",
      "in 1h",
      "in 2h",
      "in 3h",
    ]);
    // Same score within a bucket: earlier start first.
    expect(results[2]!.ref < results[3]!.ref).toBe(true);
  });

  it("aging threshold: 7 days open qualifies, 6 does not", () => {
    const results = buildPriorityResults(
      inputs({
        aging: [
          {
            id: "a",
            description: "In",
            counterpartyText: "Acme Corp",
            createdAt: daysAgo(7),
            dueAt: null,
          },
          {
            id: "b",
            description: "Out",
            counterpartyText: "Vendor Ltd",
            createdAt: daysAgo(6),
            dueAt: null,
          },
        ],
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toBe("In");
    expect(results[0]!.reason).toEqual(["waiting on Acme Corp for 7 days"]);
  });

  it("caps: overdue days cap at 10, downstream cap at 10", () => {
    const results = buildPriorityResults(
      inputs({
        overdue: [
          {
            id: "a",
            description: "Ancient blocker",
            counterpartyText: "X",
            dueAt: daysAgo(20),
            downstreamLabels: Array.from({ length: 12 }, (_, i) => `D${i}`),
          },
        ],
      }),
    );
    expect(results[0]!.score).toBe(140);
    expect(results[0]!.reason).toEqual([
      "20 days overdue",
      "may_follow_up is on",
      "D0 is blocked on this",
      "11 more items blocked on this",
    ]);
  });

  it("quiet matrix: no inputs → empty list (no fabrication)", () => {
    expect(buildPriorityResults(inputs({}))).toEqual([]);
    expect(
      buildPriorityResults(inputs({ unlock: unlockStub({ transitive: 0, direct: 0 }) })),
    ).toEqual([]);
  });

  it("deterministic: same inputs → identical output across repeated builds", () => {
    const fixture = inputs({
      overdue: [
        {
          id: "a",
          description: "Henna owes the venue confirmation",
          counterpartyText: "Henna",
          dueAt: daysAgo(3),
          downstreamLabels: ["Venue deposit"],
        },
      ],
      imminent: [{ googleEventId: "e1", summary: "Henna sync", startTime: hoursAhead(2) }],
    });
    expect(buildPriorityResults(fixture)).toEqual(buildPriorityResults(fixture));
  });
});

describe("renderPriorityLine", () => {
  it("renders the deterministic top-line with reasons", () => {
    expect(
      renderPriorityLine({
        ref: "commitment:a",
        kind: "overdue_follow_up",
        summary: "Henna owes the venue confirmation",
        reason: ["3 days overdue", "may_follow_up is on", "Venue deposit is blocked on this"],
        score: 69,
      }),
    ).toBe(
      "You have one thing that actually needs your attention: Henna owes the venue confirmation (3 days overdue; may_follow_up is on; Venue deposit is blocked on this).",
    );
  });

  it("renders without a reason parenthetical when reasons are empty", () => {
    expect(
      renderPriorityLine({
        ref: "calendar_event:e1",
        kind: "calendar_imminent",
        summary: "7 AM Henna sync",
        reason: [],
        score: 35,
      }),
    ).toBe("You have one thing that actually needs your attention: 7 AM Henna sync.");
  });
});

describe("topPriorities limit validation", () => {
  const noQueryExecutor = {
    query: (): never => {
      throw new Error("must not query when limit is invalid");
    },
  };

  it.each([0, -1, 6, 2.5, Number.NaN])("rejects limit %s before querying", async (limit) => {
    await expect(
      topPriorities(noQueryExecutor as never, { limit: limit as number }),
    ).rejects.toThrow(RangeError);
  });
});
