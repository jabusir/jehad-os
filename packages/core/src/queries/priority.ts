// theOneThing / topPriorities — the W5(a) deterministic priority scorer
// (plan §7 W5, §4: "what do I actually need to deal with?"). No ML, no
// floats-from-nowhere: every score is integer points from the table below
// and every reason string cites the input it came from. Built ON the
// existing query layer, not around it:
//
//   (a) overdue_follow_up — open owes_me commitments past due per the
//       date-trust gate (reused via whatAmIWaitingFor) with may_follow_up
//       on, weighted by overdue days and by how much transitive downstream
//       work is blocked on them (the leverage BFS edge fetch + walk shape,
//       reused from blocked.ts/leverage.ts);
//   (b) blocked_unlock — the top highestLeverageDecision with open
//       downstream (the "best unlock", reused verbatim);
//   (c) calendar_imminent — non-cancelled calendar projection events
//       starting within the next 3h;
//   (d) waiting_aging — open owes_me commitments open >= 7 days that are
//       not already (a) candidates.
//
// Integer scoring table (documented, pinned by tests):
//   overdue_follow_up  50 + 5 × min(max(overdueDays,1),10) + 4 × min(downstream,10)
//   calendar_imminent  25 + 10 × (3 − clamp(floor(hoursUntil),0,2))
//   blocked_unlock     30 + 4 × min(transitiveDownstreamCount,10)
//   waiting_aging      10 + 2 × min(daysOpen,15)
//
// Ordering (topPriorities and theOneThing share it): score desc → kind
// precedence (overdue_follow_up > calendar_imminent > blocked_unlock >
// waiting_aging) → due/start instant asc (null last) → ref asc. Null/empty
// when nothing qualifies — quiet is honest, never fabricated.
//
// Read-only: SELECTs only, against canonical tables + the calendar
// projection.

import { itemKey, type QueryExecutor } from "./executor.js";
import { whatAmIWaitingFor } from "./waiting.js";
import { fetchActiveBlockedByEdges, type BlockedByEdge } from "./blocked.js";
import { highestLeverageDecision, type LeverageDecision } from "./leverage.js";
import { resolveItems, type ItemInfo, type ItemRef } from "./items.js";
import { BRIEF_DOMAIN_KEY } from "../briefs/data.js";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";

/** Calendar events starting within this horizon count as imminent. */
export const PRIORITY_IMMINENT_HOURS = 3;
/** An open owes_me commitment counts as aging at this many days open. */
export const WAITING_AGING_DAYS = 7;
export const DEFAULT_PRIORITY_LIMIT = 3;
export const MAX_PRIORITY_LIMIT = 5;

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

// Blocker-side transitive walk depth cap (same as the leverage BFS default).
const DOWNSTREAM_DEPTH_CAP = 3;
// Reasons cite at most this many blocked-item labels; the rest collapse to a count.
const DOWNSTREAM_REASON_LABELS = 3;

// Integer scoring constants (see table in the header).
const OVERDUE_BASE = 50;
const OVERDUE_PER_DAY = 5;
const OVERDUE_DAY_CAP = 10;
const BLOCKED_PER_DOWNSTREAM = 4;
const DOWNSTREAM_CAP = 10;
const IMMINENT_BASE = 25;
const IMMINENT_PER_BUCKET = 10;
const UNLOCK_BASE = 30;
const UNLOCK_PER_DOWNSTREAM = 4;
const AGING_BASE = 10;
const AGING_PER_DAY = 2;
const AGING_DAY_CAP = 15;

export type PriorityKind =
  | "overdue_follow_up"
  | "calendar_imminent"
  | "blocked_unlock"
  | "waiting_aging";

const KIND_PRECEDENCE: readonly PriorityKind[] = [
  "overdue_follow_up",
  "calendar_imminent",
  "blocked_unlock",
  "waiting_aging",
];

export interface PriorityInput {
  /** Domain key ("personal"); omit for all domains. */
  readonly now?: () => Date;
  readonly domainId?: string;
}

export interface PriorityResult {
  /** "commitment:<uuid>" | "decision:<uuid>" | "calendar_event:<googleEventId>". */
  readonly ref: string;
  readonly kind: PriorityKind;
  readonly summary: string;
  /** Human-readable reasons citing the scored inputs, strongest first. */
  readonly reason: string[];
  /** Integer points from the scoring table. */
  readonly score: number;
}

// ---- pure build layer (unit-testable fixture matrices) ---------------------

export interface OverdueFollowUpInput {
  readonly id: string;
  readonly description: string;
  readonly counterpartyText: string;
  /** Trusted past-due due_at (ISO). */
  readonly dueAt: string;
  /** Labels of transitive downstream items blocked on this one, top first. */
  readonly downstreamLabels: readonly string[];
}

export interface ImminentEventInput {
  readonly googleEventId: string;
  readonly summary: string;
  /** Event start, now < start <= now + PRIORITY_IMMINENT_HOURS (ISO). */
  readonly startTime: string;
}

export interface WaitingAgingInput {
  readonly id: string;
  readonly description: string;
  readonly counterpartyText: string;
  readonly createdAt: string;
  readonly dueAt: string | null;
}

export interface PriorityBuildInputs {
  readonly now: Date;
  readonly overdueFollowUps: readonly OverdueFollowUpInput[];
  readonly unlock: LeverageDecision | null;
  readonly imminentEvents: readonly ImminentEventInput[];
  readonly waitingAging: readonly WaitingAgingInput[];
}

function daysBetween(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(fromIso)) / MS_PER_DAY);
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BRIEF_TIMEZONE,
  })
    .format(d)
    .replace(":00 ", " ");
}

interface RankablePriority extends PriorityResult {
  readonly kindOrder: number;
  readonly dueMs: number | null;
}

function toResult(item: RankablePriority): PriorityResult {
  return {
    ref: item.ref,
    kind: item.kind,
    summary: item.summary,
    reason: item.reason,
    score: item.score,
  };
}

/**
 * Ranks the four signal kinds by the scoring table into one deterministic
 * list. Pure: same inputs → byte-identical output. Empty inputs → [].
 */
export function buildPriorityResults(
  inputs: PriorityBuildInputs,
): readonly PriorityResult[] {
  const rankable: RankablePriority[] = [];

  for (const item of inputs.overdueFollowUps) {
    const rawDays = daysBetween(item.dueAt, inputs.now);
    const overdueDays = Math.max(1, rawDays);
    const downstream = Math.min(item.downstreamLabels.length, DOWNSTREAM_CAP);
    const reason: string[] = [
      rawDays >= 1
        ? `${rawDays} day${rawDays === 1 ? "" : "s"} overdue`
        : "overdue today",
      "may_follow_up is on",
    ];
    if (item.downstreamLabels.length > 0) {
      reason.push(`${item.downstreamLabels[0]!} is blocked on this`);
      if (item.downstreamLabels.length > 1) {
        const rest = item.downstreamLabels.length - 1;
        reason.push(`${rest} more item${rest === 1 ? "" : "s"} blocked on this`);
      }
    }
    rankable.push({
      ref: `commitment:${item.id}`,
      kind: "overdue_follow_up",
      kindOrder: KIND_PRECEDENCE.indexOf("overdue_follow_up"),
      summary: item.description,
      reason,
      score:
        OVERDUE_BASE +
        OVERDUE_PER_DAY * Math.min(overdueDays, OVERDUE_DAY_CAP) +
        BLOCKED_PER_DOWNSTREAM * downstream,
      dueMs: Date.parse(item.dueAt),
    });
  }

  for (const event of inputs.imminentEvents) {
    const hours = (Date.parse(event.startTime) - inputs.now.getTime()) / MS_PER_HOUR;
    const bucket = Math.min(2, Math.max(0, Math.floor(hours)));
    const title = event.summary.length > 0 ? event.summary : "(untitled)";
    const when = hours < 1 ? "under an hour" : `${Math.round(hours)}h`;
    rankable.push({
      ref: `calendar_event:${event.googleEventId}`,
      kind: "calendar_imminent",
      kindOrder: KIND_PRECEDENCE.indexOf("calendar_imminent"),
      summary: `${hhmm(event.startTime)} ${title}`,
      reason: [`in ${when}`],
      score: IMMINENT_BASE + IMMINENT_PER_BUCKET * (3 - bucket),
      dueMs: Date.parse(event.startTime),
    });
  }

  const unlock = inputs.unlock;
  if (unlock !== null && unlock.transitiveDownstreamCount > 0) {
    const transitive = Math.min(unlock.transitiveDownstreamCount, DOWNSTREAM_CAP);
    const reason = [
      `unblocks ${unlock.transitiveDownstreamCount} downstream item${
        unlock.transitiveDownstreamCount === 1 ? "" : "s"
      } (${unlock.directDownstreamCount} direct)`,
    ];
    const labels = unlock.topBlockedItems.map((item) => item.label);
    for (const label of labels.slice(0, DOWNSTREAM_REASON_LABELS)) {
      reason.push(`${label} is blocked on this`);
    }
    if (labels.length > DOWNSTREAM_REASON_LABELS) {
      const rest = labels.length - DOWNSTREAM_REASON_LABELS;
      reason.push(`${rest} more item${rest === 1 ? "" : "s"} blocked on this`);
    }
    rankable.push({
      ref: `decision:${unlock.decisionId}`,
      kind: "blocked_unlock",
      kindOrder: KIND_PRECEDENCE.indexOf("blocked_unlock"),
      summary: unlock.question,
      reason,
      score: UNLOCK_BASE + UNLOCK_PER_DOWNSTREAM * transitive,
      dueMs: null,
    });
  }

  for (const item of inputs.waitingAging) {
    const daysOpen = daysBetween(item.createdAt, inputs.now);
    if (daysOpen < WAITING_AGING_DAYS) continue;
    rankable.push({
      ref: `commitment:${item.id}`,
      kind: "waiting_aging",
      kindOrder: KIND_PRECEDENCE.indexOf("waiting_aging"),
      summary: item.description,
      reason: [
        `waiting on ${item.counterpartyText} for ${daysOpen} day${daysOpen === 1 ? "" : "s"}`,
      ],
      score: AGING_BASE + AGING_PER_DAY * Math.min(daysOpen, AGING_DAY_CAP),
      dueMs: item.dueAt === null ? null : Date.parse(item.dueAt),
    });
  }

  rankable.sort(
    (a, b) =>
      b.score - a.score ||
      a.kindOrder - b.kindOrder ||
      (a.dueMs ?? Number.POSITIVE_INFINITY) - (b.dueMs ?? Number.POSITIVE_INFINITY) ||
      (a.ref < b.ref ? -1 : 1),
  );
  return rankable.map(toResult);
}

// ---- gather layer (SQL over the existing queries) --------------------------

const MAY_FOLLOW_UP_SQL = `
  SELECT id, may_follow_up, created_at
  FROM commitments
  WHERE id = ANY($1::uuid[])
`;

const IMMINENT_EVENTS_SQL = `
  SELECT google_event_id, summary, start_time
  FROM calendar_events
  WHERE status <> 'cancelled'
    AND start_time > $1::timestamptz
    AND start_time <= $2::timestamptz
  ORDER BY start_time ASC, google_event_id ASC
`;

function isOpenDownstream(item: ItemInfo | undefined): boolean {
  if (item === undefined) return false;
  if (item.type === "commitment") return item.commitmentStatus === "open";
  return true;
}

/**
 * Transitive downstream items blocked on `start`, as labels ordered like the
 * leverage BFS output (depth asc, then type, then id). Reuses the same
 * active-edge fetch and blocker→blocked reverse walk as leverage.ts, started
 * from a commitment instead of a decision; cycle-safe via the visited set.
 */
async function downstreamLabelsOf(
  start: ItemRef,
  edges: readonly BlockedByEdge[],
  info: Map<string, ItemInfo>,
  domainId: string | undefined,
): Promise<string[]> {
  const blockedByBlocker = new Map<string, ItemRef[]>();
  for (const edge of edges) {
    const key = itemKey(edge.to.type, edge.to.id);
    const list = blockedByBlocker.get(key) ?? [];
    list.push(edge.from);
    blockedByBlocker.set(key, list);
  }
  const domainOk = (ref: ItemRef): boolean => {
    if (domainId === undefined) return true;
    return info.get(itemKey(ref.type, ref.id))?.domainKey === domainId;
  };

  const startKey = itemKey(start.type, start.id);
  const visited = new Set<string>([startKey]);
  let frontier: ItemRef[] = (blockedByBlocker.get(startKey) ?? []).filter(domainOk);
  const found: Array<{ ref: ItemRef; depth: number }> = [];
  let depth = 1;
  while (frontier.length > 0 && depth <= DOWNSTREAM_DEPTH_CAP) {
    const next: ItemRef[] = [];
    for (const ref of frontier) {
      const key = itemKey(ref.type, ref.id);
      if (visited.has(key)) continue;
      visited.add(key);
      const item = info.get(key);
      if (!isOpenDownstream(item)) continue;
      found.push({ ref, depth });
      for (const deeper of blockedByBlocker.get(key) ?? []) {
        if (!visited.has(itemKey(deeper.type, deeper.id))) next.push(deeper);
      }
    }
    frontier = next.filter(domainOk);
    depth += 1;
  }
  return found
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        (a.ref.type < b.ref.type ? -1 : a.ref.type > b.ref.type ? 1 : 0) ||
        (a.ref.id < b.ref.id ? -1 : 1),
    )
    .map(({ ref }) => info.get(itemKey(ref.type, ref.id))?.label ?? ref.id);
}

async function gatherPriority(
  db: QueryExecutor,
  input: PriorityInput,
): Promise<readonly PriorityResult[]> {
  const now = input.now?.() ?? new Date();
  const nowFn = (): Date => now;
  // The calendar projection is personal-domain by construction
  // (calendar/projection.ts) — imminent events only scope into personal (or
  // unfiltered) runs, never into another domain's priority.
  const calendarInScope = input.domainId === undefined || input.domainId === BRIEF_DOMAIN_KEY;

  const [waiting, ranked, eventRows] = await Promise.all([
    whatAmIWaitingFor(db, { domainId: input.domainId, now: nowFn }),
    highestLeverageDecision(db, { domainId: input.domainId, now: nowFn }),
    calendarInScope
      ? db.query(IMMINENT_EVENTS_SQL, [
          now.toISOString(),
          new Date(now.getTime() + PRIORITY_IMMINENT_HOURS * MS_PER_HOUR).toISOString(),
        ])
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ]);

  const ids = waiting.map((item) => item.id);
  const supplementRows =
    ids.length === 0
      ? []
      : (await db.query(MAY_FOLLOW_UP_SQL, [ids])).rows;
  const mayFollowUp = new Map<string, boolean>();
  const createdAt = new Map<string, string>();
  for (const row of supplementRows) {
    const id = String(row.id);
    mayFollowUp.set(id, row.may_follow_up === true);
    const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    createdAt.set(id, created);
  }

  const overdue = waiting.filter((item) => item.overdue && mayFollowUp.get(item.id) === true);
  const overdueIds = new Set(overdue.map((item) => item.id));

  const downstreamByItem = new Map<string, string[]>();
  if (overdue.length > 0) {
    const edges = await fetchActiveBlockedByEdges(db, { now, domainId: input.domainId });
    const refs: ItemRef[] = edges.flatMap((edge) => [edge.from, edge.to]);
    const info = await resolveItems(db, refs);
    for (const item of overdue) {
      downstreamByItem.set(
        item.id,
        await downstreamLabelsOf(
          { type: "commitment", id: item.id },
          edges,
          info,
          input.domainId,
        ),
      );
    }
  }

  const overdueFollowUps: OverdueFollowUpInput[] = overdue.map((item) => ({
    id: item.id,
    description: item.description,
    counterpartyText: item.counterpartyText,
    dueAt: item.dueAt ?? "",
    downstreamLabels: downstreamByItem.get(item.id) ?? [],
  }));

  const imminentEvents: ImminentEventInput[] = eventRows.rows.map((row) => ({
    googleEventId: String(row.google_event_id),
    summary: typeof row.summary === "string" ? row.summary : "",
    startTime:
      row.start_time instanceof Date ? row.start_time.toISOString() : String(row.start_time),
  }));

  const waitingAging: WaitingAgingInput[] = waiting
    .filter((item) => !overdueIds.has(item.id))
    .filter((item) => {
      const created = createdAt.get(item.id);
      return created !== undefined && daysBetween(created, now) >= WAITING_AGING_DAYS;
    })
    .map((item) => ({
      id: item.id,
      description: item.description,
      counterpartyText: item.counterpartyText,
      createdAt: createdAt.get(item.id)!,
      dueAt: item.dueAt,
    }));

  const unlock = ranked.find((d) => d.transitiveDownstreamCount > 0) ?? null;

  return buildPriorityResults({
    now,
    overdueFollowUps,
    unlock,
    imminentEvents,
    waitingAging,
  });
}

/**
 * The single highest-priority item right now, or null when nothing
 * qualifies (quiet world — never fabricated).
 */
export async function theOneThing(
  db: QueryExecutor,
  input: PriorityInput = {},
): Promise<PriorityResult | null> {
  const results = await gatherPriority(db, input);
  return results[0] ?? null;
}

export interface TopPrioritiesInput extends PriorityInput {
  /** 1–5 (default 3). */
  readonly limit?: number;
}

/** Ranked priority list (deterministic ordering; see header). */
export async function topPriorities(
  db: QueryExecutor,
  input: TopPrioritiesInput = {},
): Promise<readonly PriorityResult[]> {
  const limit = input.limit ?? DEFAULT_PRIORITY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PRIORITY_LIMIT) {
    throw new RangeError(
      `limit must be an integer in [1, ${MAX_PRIORITY_LIMIT}], got ${String(input.limit)}`,
    );
  }
  const results = await gatherPriority(db, input);
  return results.slice(0, limit);
}

/** The day.state top-line: "You have one thing that actually needs your attention: …". */
export function renderPriorityLine(result: PriorityResult): string {
  const reasons = result.reason.join("; ");
  return reasons.length === 0
    ? `You have one thing that actually needs your attention: ${result.summary}.`
    : `You have one thing that actually needs your attention: ${result.summary} (${reasons}).`;
}
