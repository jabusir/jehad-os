// Briefs data collection (M6B; plan §13 Brief + Close bullets, §31 shapes).
// Structured data FIRST: collectors run the M6A structured queries (whatChanged,
// whatWaitsOnMe, whatIsBlocked, highestLeverageDecision — read-only, personal
// domain) plus a small read-only escalations batch summary, and return plain
// models the pure renderer turns into deterministic text. No model calls
// anywhere (plan §13: "structured state only, never LLM").
//
// Time semantics: all timestamps are UTC; the delta window defaults to
// now - 16h (covers an evening-close → next-morning-brief gap). Suppression
// predicates below define "nothing meaningful changed" (§31: produce no
// summary) and are pure so tests can pin them.

import type { QueryExecutor } from "../queries/executor.js";
import { parseDateInput } from "../queries/executor.js";
import type { CommitmentListItem, WaitsOnMeItem } from "../queries/waiting.js";
import { whatAmIWaitingFor, whatWaitsOnMe } from "../queries/waiting.js";
import type {
  ChangedCommitment,
  ChangedDecision,
  WhatChangedResult,
} from "../queries/changed.js";
import { whatChanged } from "../queries/changed.js";
import type { BlockedItem, StalledItem } from "../queries/blocked.js";
import { whatIsBlocked } from "../queries/blocked.js";
import type { LeverageDecision } from "../queries/leverage.js";
import { highestLeverageDecision } from "../queries/leverage.js";

/** Briefs are a personal-operations surface (plan §13); artifacts land here. */
export const BRIEF_DOMAIN_KEY = "personal";

/** Default delta window: 16h (evening close → next morning brief). */
export const DEFAULT_BRIEF_WINDOW_MS = 16 * 60 * 60 * 1000;

export interface BriefOptions {
  readonly now?: () => Date;
  /** Exclusive delta lower bound; default now - 16h. */
  readonly since?: Date | string;
}

export interface EscalationReasonCount {
  readonly reason: string;
  readonly count: number;
}

export interface EscalationBatchSummary {
  readonly pending: number;
  readonly batched: number;
  readonly byReason: readonly EscalationReasonCount[];
}

export interface WaitingOnYou {
  readonly overdue: readonly WaitsOnMeItem[];
  readonly dueSoon: readonly WaitsOnMeItem[];
  /** Open i_owe commitments that are neither overdue nor due soon. */
  readonly otherOpenCount: number;
}

export interface MorningBriefData {
  readonly kind: "brief";
  readonly domainId: string;
  readonly now: string;
  readonly since: string;
  readonly changed: WhatChangedResult;
  readonly waitingOnYou: WaitingOnYou;
  readonly blocked: readonly BlockedItem[];
  readonly stalled: readonly StalledItem[];
  readonly unlock: LeverageDecision | null;
  readonly escalations: EscalationBatchSummary;
}

export interface EveningCloseData {
  readonly kind: "close";
  readonly domainId: string;
  readonly now: string;
  readonly since: string;
  readonly decisionsMade: readonly ChangedDecision[];
  readonly newCommitments: readonly ChangedCommitment[];
  readonly completed: readonly ChangedCommitment[];
  readonly stillWaiting: readonly CommitmentListItem[];
  readonly blocked: readonly BlockedItem[];
  readonly stalled: readonly StalledItem[];
  /** blocked_by edge ids created/updated inside the window → "new" markers. */
  readonly newBlockedEdgeIds: readonly string[];
  readonly unlock: LeverageDecision | null;
}

const OPEN_ESCALATIONS_SQL = `
  SELECT e.status, e.reason, count(*)::int AS n
  FROM escalations e
  JOIN runs r ON r.id = e.run_id
  JOIN domains d ON d.id = r.domain_id
  WHERE e.status IN ('pending', 'batched')
    AND d.key = $1
  GROUP BY e.status, e.reason
  ORDER BY e.reason ASC, e.status ASC
`;

async function escalationSummary(
  db: QueryExecutor,
  domainId: string,
): Promise<EscalationBatchSummary> {
  const result = await db.query(OPEN_ESCALATIONS_SQL, [domainId]);
  let pending = 0;
  let batched = 0;
  const byReason = new Map<string, number>();
  for (const row of result.rows) {
    const status = String(row.status);
    const count = Number(row.n);
    if (status === "pending") pending += count;
    else if (status === "batched") batched += count;
    byReason.set(String(row.reason), (byReason.get(String(row.reason)) ?? 0) + count);
  }
  return {
    pending,
    batched,
    byReason: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => (a.reason < b.reason ? -1 : 1)),
  };
}

function resolveWindow(opts: BriefOptions): { now: Date; since: Date } {
  const now = opts.now?.() ?? new Date();
  const since =
    opts.since === undefined
      ? new Date(now.getTime() - DEFAULT_BRIEF_WINDOW_MS)
      : parseDateInput(opts.since, "since");
  return { now, since };
}

/** The top ranked decision that actually unblocks something (0-downstream candidates are not unlocks). */
function pickUnlock(ranked: readonly LeverageDecision[]): LeverageDecision | null {
  return ranked.find((d) => d.transitiveDownstreamCount > 0) ?? null;
}

export async function collectMorningBriefData(
  db: QueryExecutor,
  opts: BriefOptions = {},
): Promise<MorningBriefData> {
  const { now, since } = resolveWindow(opts);
  const nowFn = (): Date => now;

  const [changed, waitsOnMe, blockedResult, ranked, escalations] = await Promise.all([
    whatChanged(db, { since, domainId: BRIEF_DOMAIN_KEY }),
    whatWaitsOnMe(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
    whatIsBlocked(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
    highestLeverageDecision(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
    escalationSummary(db, BRIEF_DOMAIN_KEY),
  ]);

  const overdue = waitsOnMe.filter((c) => c.overdue);
  const dueSoon = waitsOnMe.filter((c) => !c.overdue && c.dueSoon);

  return {
    kind: "brief",
    domainId: BRIEF_DOMAIN_KEY,
    now: now.toISOString(),
    since: since.toISOString(),
    changed,
    waitingOnYou: {
      overdue,
      dueSoon,
      otherOpenCount: waitsOnMe.length - overdue.length - dueSoon.length,
    },
    blocked: blockedResult.blocked,
    stalled: blockedResult.stalled,
    unlock: pickUnlock(ranked),
    escalations,
  };
}

export async function collectEveningCloseData(
  db: QueryExecutor,
  opts: BriefOptions = {},
): Promise<EveningCloseData> {
  const { now, since } = resolveWindow(opts);
  const nowFn = (): Date => now;

  const [changed, waiting, blockedResult, ranked] = await Promise.all([
    whatChanged(db, { since, domainId: BRIEF_DOMAIN_KEY }),
    whatAmIWaitingFor(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
    whatIsBlocked(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
    highestLeverageDecision(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
  ]);

  return {
    kind: "close",
    domainId: BRIEF_DOMAIN_KEY,
    now: now.toISOString(),
    since: since.toISOString(),
    decisionsMade: changed.decisions,
    newCommitments: changed.commitments.filter((c) => c.status === "open"),
    completed: changed.commitments.filter((c) => c.status === "met"),
    stillWaiting: waiting,
    blocked: blockedResult.blocked,
    stalled: blockedResult.stalled,
    newBlockedEdgeIds: changed.relationships
      .filter((r) => r.relation === "blocked_by")
      .map((r) => r.id),
    unlock: pickUnlock(ranked),
  };
}

/**
 * Morning renders iff ANY signal exists: overnight delta, an i_owe item
 * overdue/due-soon, anything blocked/stalled, a real unlock, or open
 * escalations. Empty world → suppressed (no artifact).
 */
export function isMorningBriefMeaningful(data: MorningBriefData): boolean {
  return (
    data.changed.eventGroups.length > 0 ||
    data.changed.commitments.length > 0 ||
    data.changed.decisions.length > 0 ||
    data.changed.relationships.length > 0 ||
    data.waitingOnYou.overdue.length > 0 ||
    data.waitingOnYou.dueSoon.length > 0 ||
    data.blocked.length > 0 ||
    data.stalled.length > 0 ||
    data.unlock !== null ||
    data.escalations.pending + data.escalations.batched > 0
  );
}

/**
 * Evening renders iff the day's delta is non-empty OR a standing risk needs
 * attention: a decision made, a commitment changed, something completed, an
 * OVERDUE external wait, anything blocked/stalled, or a real unlock for
 * tomorrow. Calm future-dated waits alone do not make a close meaningful
 * (§31: no summary when nothing meaningful changed).
 */
export function isEveningCloseMeaningful(data: EveningCloseData): boolean {
  return (
    data.decisionsMade.length > 0 ||
    data.newCommitments.length > 0 ||
    data.completed.length > 0 ||
    data.stillWaiting.some((c) => c.overdue) ||
    data.blocked.length > 0 ||
    data.stalled.length > 0 ||
    data.unlock !== null
  );
}
