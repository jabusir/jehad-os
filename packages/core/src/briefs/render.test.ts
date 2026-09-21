// Golden-string tests for the brief/close renderers (M6B): the pure text
// shape of the §31 morning/evening outputs, pinned exactly. Hermetic — models
// are hand-built (mirroring the §25 leverage fixture vocabulary), no DB, no
// clock. Also pins the §31 suppression predicates ("do not produce a summary
// if nothing meaningful changed").

import { describe, expect, it } from "vitest";
import type { ChangedCommitment, ChangedDecision, WhatChangedResult } from "../queries/changed.js";
import type { BlockedItem, StalledItem } from "../queries/blocked.js";
import type { CommitmentListItem, WaitsOnMeItem } from "../queries/waiting.js";
import type { LeverageDecision } from "../queries/leverage.js";
import {
  isEveningCloseMeaningful,
  isMorningBriefMeaningful,
  type EveningCloseData,
  type MorningBriefData,
} from "./data.js";
import { renderEveningCloseText, renderMorningBriefText } from "./render.js";
import type { DivergenceResult } from "./divergence.js";

const NOW = "2026-09-17T12:00:00.000Z";
const SINCE = "2026-09-16T20:00:00.000Z";

function waitsOnMe(over: Partial<WaitsOnMeItem>): WaitsOnMeItem {
  return {
    id: "c-1",
    direction: "i_owe",
    counterpartyText: "self",
    counterpartyEntityId: null,
    description: "placeholder",
    dueAt: null,
    confidence: 0.9,
    status: "open",
    domainKey: "personal",
    overdue: false,
    dueSoon: false,
    ...over,
  };
}

function commitment(over: Partial<CommitmentListItem>): CommitmentListItem {
  return {
    id: "c-1",
    direction: "owes_me",
    counterpartyText: "self",
    counterpartyEntityId: null,
    description: "placeholder",
    dueAt: null,
    confidence: 0.9,
    status: "open",
    domainKey: "personal",
    overdue: false,
    ...over,
  };
}

const EMPTY_CHANGED: WhatChangedResult = {
  since: SINCE,
  eventGroups: [],
  commitments: [],
  decisions: [],
  relationships: [],
};

const MORNING_FULL: MorningBriefData = {
  kind: "brief",
  domainId: "personal",
  now: NOW,
  since: SINCE,
  changed: {
    since: SINCE,
    eventGroups: [{ type: "capture.recorded", count: 2, events: [] }],
    commitments: [
      {
        id: "c-rent",
        description: "Pay October rent",
        direction: "i_owe",
        status: "open",
        dueAt: "2026-09-16T12:00:00.000Z",
        domainKey: "personal",
        updatedAt: "2026-09-17T02:00:00.000Z",
      } satisfies ChangedCommitment,
    ],
    decisions: [
      {
        id: "d-a",
        question: "Choose the migration approach",
        chosen: "Strangler fig",
        domainKey: "personal",
        decidedAt: "2026-09-17T01:00:00.000Z",
        updatedAt: "2026-09-17T01:00:00.000Z",
      } satisfies ChangedDecision,
    ],
    relationships: [
      {
        id: "r-1",
        fromType: "commitment",
        fromId: "c-b",
        relation: "blocked_by",
        toType: "decision",
        toId: "d-a",
        domainKey: "personal",
        updatedAt: "2026-09-17T03:00:00.000Z",
      },
    ],
  },
  waitingOnYou: {
    overdue: [
      waitsOnMe({
        id: "c-rent",
        description: "Pay October rent",
        counterpartyText: "Landlord",
        dueAt: "2026-09-16T12:00:00.000Z",
        overdue: true,
      }),
    ],
    dueSoon: [
      waitsOnMe({
        id: "c-paper",
        description: "Submit quarter-end paperwork",
        counterpartyText: "Bank",
        dueAt: "2026-09-19T12:00:00.000Z",
        dueSoon: true,
      }),
    ],
    otherOpenCount: 3,
  },
  blocked: [
    {
      itemType: "commitment",
      itemId: "c-b",
      itemLabel: "Task B: draft schema",
      domainKey: "personal",
      blockerType: "decision",
      blockerId: "d-a",
      blockerLabel: "Choose the migration approach",
      cycle: false,
      edgeId: "r-old",
    } satisfies BlockedItem,
    {
      itemType: "commitment",
      itemId: "c-x",
      itemLabel: "Cycle side X",
      domainKey: "personal",
      blockerType: "commitment",
      blockerId: "c-y",
      blockerLabel: "Cycle side Y",
      cycle: true,
      edgeId: "r-cx",
    } satisfies BlockedItem,
  ],
  stalled: [
    {
      itemType: "commitment",
      itemId: "c-stale",
      itemLabel: "Stale unblocked commitment (8 days silent)",
      domainKey: "personal",
      lastProgressAt: "2026-09-09T00:00:00.000Z",
      stalledForDays: 8.04,
      thresholdDays: 7,
    } satisfies StalledItem,
  ],
  unlock: {
    decisionId: "d-a",
    question: "Choose the migration approach",
    chosen: "Strangler fig",
    domainKey: "personal",
    decidedAt: "2026-09-07T12:00:00.000Z",
    directDownstreamCount: 3,
    transitiveDownstreamCount: 5,
    topBlockedItems: [
      { itemType: "commitment", itemId: "c-b", label: "Task B: draft schema", depth: 1 },
      { itemType: "commitment", itemId: "c-c", label: "Task C: extraction prompt", depth: 1 },
      { itemType: "commitment", itemId: "c-d", label: "Task D: brief renderer", depth: 1 },
      { itemType: "commitment", itemId: "c-t2", label: "Task T2 (depth 2 under A)", depth: 2 },
      { itemType: "commitment", itemId: "c-t3", label: "Task T3 (depth 3 under A)", depth: 3 },
    ],
  } satisfies LeverageDecision,
  escalations: {
    pending: 2,
    batched: 1,
    byReason: [
      { reason: "ambiguous_requirements", count: 1 },
      { reason: "approval_required", count: 2 },
    ],
  },
  todaySchedule: [],
  nextUpcoming: {
    googleEventId: "evt-next",
    summary: "Video Interview with Taekus",
    startTime: "2026-09-28T20:30:00.000Z",
    endTime: "2026-09-28T21:15:00.000Z",
    timezone: "America/Los_Angeles",
    location: "Google Meet",
  },
  review: {
    candidates: [
      {
        ref: "7K4",
        itemType: "candidate",
        itemId: "c-review-1",
        summary: `josctl said: "I'm looking for a Porsche 911."`,
        createdAt: NOW,
        snoozeCount: 0,
      },
    ],
    escalations: [
      {
        ref: "A2M",
        itemType: "escalation",
        itemId: "e-review-1",
        summary: "approval_required (high)",
        createdAt: NOW,
        snoozeCount: 0,
      },
    ],
    moreCandidates: 2,
    moreEscalations: 0,
  },
};

const MORNING_EMPTY: MorningBriefData = {
  ...MORNING_FULL,
  changed: EMPTY_CHANGED,
  waitingOnYou: { overdue: [], dueSoon: [], otherOpenCount: 0 },
  blocked: [],
  stalled: [],
  unlock: null,
  escalations: { pending: 0, batched: 0, byReason: [] },
  todaySchedule: [],
  nextUpcoming: null,
  review: null,
};

const MORNING_WITH_SCHEDULE: MorningBriefData = {
  ...MORNING_EMPTY,
  todaySchedule: [
    {
      googleEventId: "evt-dentist-001",
      summary: "Dentist",
      startTime: "2026-09-17T13:00:00.000Z",
      endTime: "2026-09-17T14:00:00.000Z",
      timezone: "America/New_York",
      location: "12 Creek Rd",
    },
    {
      googleEventId: "evt-call-002",
      summary: "",
      startTime: "2026-09-17T17:30:00.000Z",
      endTime: "2026-09-17T18:00:00.000Z",
      timezone: null,
      location: null,
    },
  ],
  nextUpcoming: null,
};

const EVENING_FULL: EveningCloseData = {
  kind: "close",
  domainId: "personal",
  now: NOW,
  since: SINCE,
  decisionsMade: MORNING_FULL.changed.decisions,
  newCommitments: [
    MORNING_FULL.changed.commitments[0]!,
    {
      id: "c-squash",
      description: "Book squash court",
      direction: "i_owe",
      status: "open",
      dueAt: null,
      domainKey: "personal",
      updatedAt: "2026-09-17T02:00:00.000Z",
    } satisfies ChangedCommitment,
  ],
  completed: [
    {
      id: "c-isp",
      description: "Pay internet bill",
      direction: "i_owe",
      status: "met",
      dueAt: "2026-09-13T12:00:00.000Z",
      domainKey: "personal",
      updatedAt: "2026-09-17T04:00:00.000Z",
    } satisfies ChangedCommitment,
  ],
  stillWaiting: [
    commitment({
      id: "c-sow",
      description: "Acme owes Jehad the signed SOW",
      counterpartyText: "Acme Corp",
      dueAt: "2026-09-15T12:00:00.000Z",
      overdue: true,
    }),
    commitment({
      id: "c-audit",
      description: "Vendor owes the audit report",
      counterpartyText: "Vendor Ltd",
      dueAt: "2026-09-27T12:00:00.000Z",
    }),
  ],
  blocked: [MORNING_FULL.blocked[0]!],
  stalled: [MORNING_FULL.stalled[0]!],
  newBlockedEdgeIds: ["r-old"],
  unlock: MORNING_FULL.unlock,
  divergence: null,
};

const EVENING_EMPTY: EveningCloseData = {
  ...EVENING_FULL,
  decisionsMade: [],
  newCommitments: [],
  completed: [],
  stillWaiting: [commitment({ description: "Vendor owes the audit report", counterpartyText: "Vendor Ltd", dueAt: "2026-09-27T12:00:00.000Z" })],
  blocked: [],
  stalled: [],
  newBlockedEdgeIds: [],
  unlock: null,
  divergence: null,
};

/** W5(d): 2 of 3 blocks churned same-day (plan divergence — unverified). */
const DIVERGENCE: DivergenceResult = {
  day: "2026-09-17",
  churnedCount: 2,
  plannedCount: 3,
  items: [
    { googleEventId: "evt-1", title: "Henna sync", changeKind: "moved" },
    { googleEventId: "evt-2", title: "Venue tour", changeKind: "cancelled" },
  ],
};

describe("renderMorningBriefText (golden)", () => {
  it("renders the full §31 morning shape exactly", () => {
    expect(renderMorningBriefText(MORNING_FULL)).toBe(`Morning brief — Thu, Sep 17

Today
- nothing scheduled
- next up: Mon, Sep 28 \u00b7 1:30\u20132:15 PM Video Interview with Taekus (Google Meet)

Overnight
- 2 events:
  - capture.recorded ×2
- 1 commitment captured:
  - Pay October rent (i_owe, open)
- 1 decision:
  - Choose the migration approach → Strangler fig
- 1 relationship update

Waiting on you
- OVERDUE Pay October rent — due 2026-09-16T12:00:00.000Z (i_owe Landlord)
- DUE SOON Submit quarter-end paperwork — due 2026-09-19T12:00:00.000Z (i_owe Bank)
- 3 more open commitments without near due dates

Blocked or stalled
- Task B: draft schema — blocked by decision "Choose the migration approach"
- Cycle side X — blocked by commitment "Cycle side Y" (dependency cycle)
- Stale unblocked commitment (8 days silent) — stalled 8.0d (threshold 7d)

Best unlock today
- Choose the migration approach (chosen: Strangler fig)
  unblocks 5 downstream items (3 direct)
  - Task B: draft schema
  - Task C: extraction prompt
  - Task D: brief renderer
  - Task T2 (depth 2 under A)
  - Task T3 (depth 3 under A)

Escalations
- 3 open (pending 2, batched 1)
- ambiguous_requirements ×1
- approval_required ×2

Needs your call
- [7K4] josctl said: "I'm looking for a Porsche 911."
- [A2M] escalation approval_required (high)
- …and 2 more
`);
  });

  it("renders a short quiet brief in an empty world", () => {
    expect(renderMorningBriefText(MORNING_EMPTY)).toBe(`Morning brief — Thu, Sep 17

Today
- nothing scheduled

All quiet — nothing waiting on you.
`);
  });

  it("Phase G: the review section renders bounded items with refs and a combined overflow line", () => {
    const bounded: MorningBriefData = {
      ...MORNING_EMPTY,
      review: {
        candidates: MORNING_FULL.review!.candidates,
        escalations: [],
        moreCandidates: 5,
        moreEscalations: 0,
      },
    };
    expect(renderMorningBriefText(bounded)).toBe(`Morning brief — Thu, Sep 17

Today
- nothing scheduled

Needs your call
- [7K4] josctl said: "I'm looking for a Porsche 911."
- …and 5 more
`);
  });

  it("renders today's schedule section from the calendar projection (E3)", () => {
    expect(renderMorningBriefText(MORNING_WITH_SCHEDULE)).toBe(`Morning brief — Thu, Sep 17

Today
- 6–7 AM Dentist (12 Creek Rd)
- 10:30–11 AM (untitled)

All quiet — nothing waiting on you.
`);
  });
});

describe("renderEveningCloseText (golden)", () => {
  it("renders the full §31 TODAY shape exactly", () => {
    expect(renderEveningCloseText(EVENING_FULL)).toBe(`Evening close — Thu, Sep 17

Decisions made
- Choose the migration approach → Strangler fig

New commitments
- Pay October rent (i_owe)
- Book squash court (i_owe)

Completed
- Pay internet bill

Still waiting: 2
- OVERDUE Acme owes Jehad the signed SOW — due 2026-09-15T12:00:00.000Z (owes_me Acme Corp)
- Vendor owes the audit report — due 2026-09-27T12:00:00.000Z (owes_me Vendor Ltd)

New risks / blocked
- NEW Task B: draft schema — blocked by decision "Choose the migration approach"
- Stale unblocked commitment (8 days silent) — stalled 8.0d (threshold 7d)

Tomorrow's best unlock
- Choose the migration approach (unblocks 5 downstream items)
`);
  });

  it("renders a short close when the day was empty but something waits", () => {
    expect(renderEveningCloseText(EVENING_EMPTY)).toBe(`Evening close — Thu, Sep 17

Still waiting: 1
- Vendor owes the audit report — due 2026-09-27T12:00:00.000Z (owes_me Vendor Ltd)
`);
  });

  it("W5(d): same-day plan churn renders as its own honesty-pinned last section", () => {
    expect(
      renderEveningCloseText({
        ...EVENING_EMPTY,
        stillWaiting: [],
        divergence: DIVERGENCE,
      }),
    ).toBe(`Evening close — Thu, Sep 17

Plan churn
- 2 of 3 blocks moved or cancelled same-day. That's plan divergence — what actually happened is unverified.
- Henna sync — moved
- Venue tour — cancelled
`);
  });

  it("W5(d): quiet day renders no plan-churn section (divergence null)", () => {
    const content = renderEveningCloseText(EVENING_EMPTY);
    expect(content).not.toContain("Plan churn");
    expect(content).not.toContain("unverified");
  });
});

describe("suppression predicates (§31 nothing-meaningful-changed)", () => {
  it("morning: empty world suppressed; every signal class alone makes it meaningful", () => {
    expect(isMorningBriefMeaningful(MORNING_EMPTY)).toBe(false);

    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, changed: { ...EMPTY_CHANGED, eventGroups: [{ type: "x", count: 1, events: [] }] } })).toBe(true);
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, waitingOnYou: { overdue: [waitsOnMe({ overdue: true })], dueSoon: [], otherOpenCount: 0 } })).toBe(true);
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, waitingOnYou: { overdue: [], dueSoon: [waitsOnMe({ dueSoon: true })], otherOpenCount: 0 } })).toBe(true);
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, blocked: [MORNING_FULL.blocked[0]!] })).toBe(true);
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, stalled: [MORNING_FULL.stalled[0]!] })).toBe(true);
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, unlock: MORNING_FULL.unlock })).toBe(true);
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, escalations: { pending: 1, batched: 0, byReason: [] } })).toBe(true);
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, escalations: { pending: 0, batched: 1, byReason: [] } })).toBe(true);
    // E3 owner call: a schedule is real attention — presence alone un-suppresses.
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, todaySchedule: MORNING_WITH_SCHEDULE.todaySchedule })).toBe(true);
    // Phase G: a non-empty review queue alone un-suppresses (§4.2).
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, review: MORNING_FULL.review })).toBe(true);
    expect(isMorningBriefMeaningful({ ...MORNING_EMPTY, review: { candidates: [], escalations: [], moreCandidates: 0, moreEscalations: 0 } })).toBe(false);
  });

  it("evening: calm world suppressed; each §31 signal alone makes it meaningful", () => {
    expect(isEveningCloseMeaningful(EVENING_EMPTY)).toBe(false);

    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, decisionsMade: EVENING_FULL.decisionsMade })).toBe(true);
    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, newCommitments: EVENING_FULL.newCommitments })).toBe(true);
    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, completed: EVENING_FULL.completed })).toBe(true);
    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, stillWaiting: [commitment({ overdue: true })] })).toBe(true);
    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, blocked: [MORNING_FULL.blocked[0]!] })).toBe(true);
    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, stalled: [MORNING_FULL.stalled[0]!] })).toBe(true);
    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, unlock: MORNING_FULL.unlock })).toBe(true);
    // W5(d): same-day plan churn alone makes the close meaningful — churn
    // is real attention about the day (honesty-pinned as plan divergence).
    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, stillWaiting: [], divergence: DIVERGENCE })).toBe(true);

    // A calm, future-dated wait alone stays suppressed.
    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, stillWaiting: EVENING_EMPTY.stillWaiting })).toBe(false);
  });
});
