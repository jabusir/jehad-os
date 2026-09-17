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
};

const MORNING_EMPTY: MorningBriefData = {
  ...MORNING_FULL,
  changed: EMPTY_CHANGED,
  waitingOnYou: { overdue: [], dueSoon: [], otherOpenCount: 0 },
  blocked: [],
  stalled: [],
  unlock: null,
  escalations: { pending: 0, batched: 0, byReason: [] },
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
};

describe("renderMorningBriefText (golden)", () => {
  it("renders the full §31 morning shape exactly", () => {
    expect(renderMorningBriefText(MORNING_FULL)).toBe(`MORNING BRIEF — 2026-09-17 (personal)
delta since 2026-09-16T20:00:00.000Z

WHILE YOU WERE AWAY
- events: 2
  - capture.recorded ×2
- commitments changed: 1
  - Pay October rent (i_owe, open)
- decisions changed: 1
  - Choose the migration approach → Strangler fig
- relationships changed: 1
  - commitment blocked_by decision ×1

WAITING ON YOU
- OVERDUE Pay October rent — due 2026-09-16T12:00:00.000Z (i_owe Landlord)
- DUE SOON Submit quarter-end paperwork — due 2026-09-19T12:00:00.000Z (i_owe Bank)
- 3 more open commitments without near due dates

BLOCKED OR SILENTLY STALLED
- Task B: draft schema — blocked by decision "Choose the migration approach"
- Cycle side X — blocked by commitment "Cycle side Y" (dependency cycle)
- Stale unblocked commitment (8 days silent) — stalled 8.0d (threshold 7d)

TODAY'S HIGHEST-LEVERAGE UNLOCK
- Choose the migration approach (chosen: Strangler fig)
  unblocks 5 downstream items (3 direct)
  - Task B: draft schema
  - Task C: extraction prompt
  - Task D: brief renderer
  - Task T2 (depth 2 under A)
  - Task T3 (depth 3 under A)

OPEN ESCALATIONS
- 3 open (pending 2, batched 1)
- ambiguous_requirements ×1
- approval_required ×2
`);
  });

  it("renders explicit empty placeholders in an empty world", () => {
    expect(renderMorningBriefText(MORNING_EMPTY)).toBe(`MORNING BRIEF — 2026-09-17 (personal)
delta since 2026-09-16T20:00:00.000Z

WHILE YOU WERE AWAY
- no changes in window

WAITING ON YOU
- nothing overdue or due soon

BLOCKED OR SILENTLY STALLED
- nothing blocked or stalled

TODAY'S HIGHEST-LEVERAGE UNLOCK
- no blocked downstream work to unlock

OPEN ESCALATIONS
- none open
`);
  });
});

describe("renderEveningCloseText (golden)", () => {
  it("renders the full §31 TODAY shape exactly", () => {
    expect(renderEveningCloseText(EVENING_FULL)).toBe(`EVENING CLOSE — 2026-09-17 (personal)
delta since 2026-09-16T20:00:00.000Z

TODAY

Decisions made: 1
- Choose the migration approach → Strangler fig

New commitments: 2
- Pay October rent (i_owe)
- Book squash court (i_owe)

Completed: 1
- Pay internet bill

Still waiting: 2
- OVERDUE Acme owes Jehad the signed SOW — due 2026-09-15T12:00:00.000Z (owes_me Acme Corp)
- Vendor owes the audit report — due 2026-09-27T12:00:00.000Z (owes_me Vendor Ltd)

New risks / blocked: 2
- NEW Task B: draft schema — blocked by decision "Choose the migration approach"
- Stale unblocked commitment (8 days silent) — stalled 8.0d (threshold 7d)

Tomorrow's highest-leverage unlock:
Choose the migration approach (unblocks 5 downstream items)
`);
  });

  it("renders zero counts and 'none' unlock when the day was empty", () => {
    expect(renderEveningCloseText(EVENING_EMPTY)).toBe(`EVENING CLOSE — 2026-09-17 (personal)
delta since 2026-09-16T20:00:00.000Z

TODAY

Decisions made: 0

New commitments: 0

Completed: 0

Still waiting: 1
- Vendor owes the audit report — due 2026-09-27T12:00:00.000Z (owes_me Vendor Ltd)

New risks / blocked: 0

Tomorrow's highest-leverage unlock:
none
`);
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

    // A calm, future-dated wait alone stays suppressed.
    expect(isEveningCloseMeaningful({ ...EVENING_EMPTY, stillWaiting: EVENING_EMPTY.stillWaiting })).toBe(false);
  });
});
