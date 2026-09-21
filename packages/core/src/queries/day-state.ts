import { parseDateInput, type QueryExecutor } from "./executor.js";
import { BRIEF_DOMAIN_KEY, DEFAULT_BRIEF_WINDOW_MS, type WaitingOnYou } from "../briefs/data.js";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";
import { whatAmIWaitingFor, whatWaitsOnMe, type CommitmentListItem } from "./waiting.js";
import { whatIsBlocked, type BlockedItem, type StalledItem } from "./blocked.js";
import { highestLeverageDecision, type LeverageDecision } from "./leverage.js";
import { whatChanged, type WhatChangedResult } from "./changed.js";
import {
  getNextUpcomingEvent,
  getTodaySchedule,
  localDayBounds,
  type TodayScheduleItem,
} from "../calendar/projection.js";
import { freshnessLines, sourceFreshness, type SourceFreshness } from "./staleness.js";

export const DAY_STATE_COVERAGE =
  "assembled from your calendar, captured commitments and decisions, and open escalations on your runs; email, chat, and notes are not connected";

export interface DayStateOptions {
  readonly now?: () => Date;
  readonly since?: Date | string;
}

export interface DayStateEscalationSummary {
  readonly pending: number;
  readonly batched: number;
  readonly byReason: readonly { readonly reason: string; readonly count: number }[];
}

export interface DayStateData {
  readonly principalId: string;
  readonly domainKey: string;
  readonly now: string;
  readonly since: string;
  readonly timezone: string;
  readonly waitingOnYou: WaitingOnYou;
  readonly waitingOnOthers: readonly CommitmentListItem[];
  readonly blocked: readonly BlockedItem[];
  readonly stalled: readonly StalledItem[];
  readonly unlock: LeverageDecision | null;
  readonly overnight: WhatChangedResult;
  readonly todaySchedule: readonly TodayScheduleItem[];
  readonly nextUpcoming: TodayScheduleItem | null;
  readonly escalations: DayStateEscalationSummary;
  readonly freshness: readonly SourceFreshness[];
}

const OPEN_ESCALATIONS_SQL = `
  SELECT e.status, e.reason, count(*)::int AS n
  FROM escalations e
  JOIN runs r ON r.id = e.run_id
  JOIN domains d ON d.id = r.domain_id
  WHERE e.status IN ('pending', 'batched')
    AND r.principal_id = $1::uuid
    AND d.key = $2
  GROUP BY e.status, e.reason
  ORDER BY e.reason ASC, e.status ASC
`;

const CAP_SCHEDULE_ROWS = 25;
const CAP_WAITING_ROWS = 15;
const CAP_OVERNIGHT_ROWS = 5;
const CAP_OVERNIGHT_GROUPS = 3;
const BULK_CHANGE_THRESHOLD = 20;
const CAP_TEXT_CHARS = 160;
const CAP_COUNTERPARTY_CHARS = 80;
const CAP_SUMMARY_CHARS = 120;
const CAP_LOCATION_CHARS = 80;

async function escalationSummary(
  db: QueryExecutor,
  principalId: string,
): Promise<DayStateEscalationSummary> {
  const result = await db.query(OPEN_ESCALATIONS_SQL, [principalId, BRIEF_DOMAIN_KEY]);
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

function resolveWindow(opts: DayStateOptions): { now: Date; since: Date } {
  const now = opts.now?.() ?? new Date();
  const since =
    opts.since === undefined
      ? new Date(now.getTime() - DEFAULT_BRIEF_WINDOW_MS)
      : parseDateInput(opts.since, "since");
  return { now, since };
}

function pickUnlock(ranked: readonly LeverageDecision[]): LeverageDecision | null {
  return ranked.find((d) => d.transitiveDownstreamCount > 0) ?? null;
}

function filterCalendarDeltaToFuture(changed: WhatChangedResult, now: Date): WhatChangedResult {
  const out = [];
  for (const group of changed.eventGroups) {
    if (!group.type.startsWith("calendar.event.")) {
      out.push(group);
      continue;
    }
    const futureEvents = group.events.filter((e) => {
      const start = typeof e.payload["start"] === "string" ? e.payload["start"] : null;
      if (start === null) return false;
      return Date.parse(start) >= now.getTime();
    });
    if (futureEvents.length > 0) {
      out.push({ ...group, events: futureEvents, count: futureEvents.length });
    }
  }
  return { ...changed, eventGroups: out };
}

function byDueThenLabel(
  a: { readonly dueAt: string | null; readonly description: string },
  b: { readonly dueAt: string | null; readonly description: string },
): number {
  const aMs = a.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.dueAt);
  const bMs = b.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.dueAt);
  return aMs - bMs || (a.description < b.description ? -1 : a.description > b.description ? 1 : 0);
}

function byLabel(a: { readonly itemLabel: string }, b: { readonly itemLabel: string }): number {
  return a.itemLabel < b.itemLabel ? -1 : a.itemLabel > b.itemLabel ? 1 : 0;
}

export async function collectDayState(
  db: QueryExecutor,
  principalId: string,
  opts: DayStateOptions = {},
): Promise<DayStateData> {
  const { now, since } = resolveWindow(opts);
  const nowFn = (): Date => now;

  const [waitsOnMe, waitingOnOthers, blockedResult, ranked, changed, todaySchedule, nextUpcoming, escalations, freshness] =
    await Promise.all([
      whatWaitsOnMe(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
      whatAmIWaitingFor(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
      whatIsBlocked(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
      highestLeverageDecision(db, { domainId: BRIEF_DOMAIN_KEY, now: nowFn }),
      whatChanged(db, { since, domainId: BRIEF_DOMAIN_KEY }),
      getTodaySchedule(db, { now, timeZone: BRIEF_TIMEZONE }),
      getNextUpcomingEvent(db, { dayEnd: localDayBounds(now, BRIEF_TIMEZONE).dayEnd }),
      escalationSummary(db, principalId),
      sourceFreshness(db, principalId, { now: nowFn }),
    ]);

  const overdue = waitsOnMe.filter((c) => c.overdue);
  const dueSoon = waitsOnMe.filter((c) => !c.overdue && c.dueSoon);

  return {
    principalId,
    domainKey: BRIEF_DOMAIN_KEY,
    now: now.toISOString(),
    since: since.toISOString(),
    timezone: BRIEF_TIMEZONE,
    waitingOnYou: {
      overdue: [...overdue].sort(byDueThenLabel),
      dueSoon: [...dueSoon].sort(byDueThenLabel),
      otherOpenCount: waitsOnMe.length - overdue.length - dueSoon.length,
    },
    waitingOnOthers: [...waitingOnOthers].sort(byDueThenLabel),
    blocked: [...blockedResult.blocked].sort(byLabel),
    stalled: [...blockedResult.stalled].sort(
      (a, b) => b.stalledForDays - a.stalledForDays || byLabel(a, b),
    ),
    unlock: pickUnlock(ranked),
    overnight: filterCalendarDeltaToFuture(changed, now),
    todaySchedule,
    nextUpcoming,
    escalations,
    freshness,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BRIEF_TIMEZONE,
  }).format(d);
  return formatted.replace(":00 ", " ");
}

function dayStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(iso));
}

function dueDay(dueAt: string | null): string | null {
  if (dueAt === null) return null;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(dueAt));
}

function waitLine(
  item: CommitmentListItem,
  flag: "OVERDUE" | "DUE SOON" | null,
): string {
  const flagPart = flag === null ? "" : `${flag} `;
  const due = dueDay(item.dueAt);
  const duePart = due === null ? "" : ` — due ${due}`;
  return `- ${flagPart}${truncate(item.description, CAP_TEXT_CHARS)}${duePart} (${item.direction} ${truncate(item.counterpartyText, CAP_COUNTERPARTY_CHARS)})`;
}

function scheduleLine(item: TodayScheduleItem): string {
  const title = item.summary.length > 0 ? truncate(item.summary, CAP_SUMMARY_CHARS) : "(untitled)";
  const startF = hhmm(item.startTime);
  const endF = item.endTime === null ? null : hhmm(item.endTime);
  const when =
    endF === null
      ? startF
      : endF.endsWith(startF.slice(-3))
        ? `${startF.slice(0, -3)}–${endF}`
        : `${startF}–${endF}`;
  const locationPart = item.location === null ? "" : ` (${truncate(item.location, CAP_LOCATION_CHARS)})`;
  return `- ${when} ${title}${locationPart}`;
}

function datedScheduleLine(item: TodayScheduleItem): string {
  const datePart = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(item.startTime));
  return `${datePart} · ${scheduleLine(item).slice(2)}`;
}

function nowNextLines(data: DayStateData): string[] {
  if (data.todaySchedule.length > 0) {
    const lines = data.todaySchedule.slice(0, CAP_SCHEDULE_ROWS).map(scheduleLine);
    if (data.todaySchedule.length > CAP_SCHEDULE_ROWS) {
      lines.push(`- …and ${data.todaySchedule.length - CAP_SCHEDULE_ROWS} more today`);
    }
    return ["NOW/NEXT", ...lines];
  }
  if (data.nextUpcoming !== null) {
    return ["NOW/NEXT", "- nothing scheduled", `- next up: ${datedScheduleLine(data.nextUpcoming)}`];
  }
  return ["NOW/NEXT", "- nothing scheduled"];
}

function waitingLines(data: DayStateData): string[] {
  const w = data.waitingOnYou;
  const overdueOthers = data.waitingOnOthers.filter((c) => c.overdue);
  const calmOthers = data.waitingOnOthers.length - overdueOthers.length;
  if (
    w.overdue.length === 0 &&
    w.dueSoon.length === 0 &&
    w.otherOpenCount === 0 &&
    data.waitingOnOthers.length === 0
  ) {
    return [];
  }
  const lines = ["WAITING"];
  for (const item of w.overdue.slice(0, CAP_WAITING_ROWS)) lines.push(waitLine(item, "OVERDUE"));
  if (w.overdue.length > CAP_WAITING_ROWS) {
    lines.push(`- …and ${w.overdue.length - CAP_WAITING_ROWS} more overdue`);
  }
  for (const item of w.dueSoon.slice(0, CAP_WAITING_ROWS)) lines.push(waitLine(item, "DUE SOON"));
  if (w.dueSoon.length > CAP_WAITING_ROWS) {
    lines.push(`- …and ${w.dueSoon.length - CAP_WAITING_ROWS} more due soon`);
  }
  if (w.otherOpenCount > 0) {
    lines.push(`- ${w.otherOpenCount} more open commitments without near due dates`);
  }
  for (const item of overdueOthers.slice(0, CAP_WAITING_ROWS)) lines.push(waitLine(item, "OVERDUE"));
  if (overdueOthers.length > CAP_WAITING_ROWS) {
    lines.push(`- …and ${overdueOthers.length - CAP_WAITING_ROWS} more overdue (waiting on others)`);
  }
  if (calmOthers > 0) lines.push(`- ${calmOthers} more waiting on others`);
  return lines;
}

function blockedLine(item: BlockedItem): string {
  const cyclePart = item.cycle ? " (dependency cycle)" : "";
  return `- ${truncate(item.itemLabel, CAP_TEXT_CHARS)} — blocked by ${item.blockerType} "${truncate(item.blockerLabel, CAP_TEXT_CHARS)}"${cyclePart}`;
}

function stalledLine(item: StalledItem): string {
  return `- ${truncate(item.itemLabel, CAP_TEXT_CHARS)} — stalled ${item.stalledForDays.toFixed(1)}d (threshold ${item.thresholdDays}d)`;
}

function blockedLines(data: DayStateData): string[] {
  if (data.blocked.length === 0 && data.stalled.length === 0) return [];
  const lines = ["BLOCKED"];
  for (const item of data.blocked.slice(0, CAP_WAITING_ROWS)) lines.push(blockedLine(item));
  if (data.blocked.length > CAP_WAITING_ROWS) {
    lines.push(`- …and ${data.blocked.length - CAP_WAITING_ROWS} more blocked`);
  }
  for (const item of data.stalled.slice(0, CAP_WAITING_ROWS)) lines.push(stalledLine(item));
  if (data.stalled.length > CAP_WAITING_ROWS) {
    lines.push(`- …and ${data.stalled.length - CAP_WAITING_ROWS} more stalled`);
  }
  return lines;
}

function unlockLines(data: DayStateData): string[] {
  if (data.unlock === null) return [];
  const u = data.unlock;
  const top = [...u.topBlockedItems].sort(
    (a, b) => a.depth - b.depth || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  return [
    "BEST UNLOCK",
    `- ${truncate(u.question, CAP_TEXT_CHARS)} (chosen: ${truncate(u.chosen, CAP_TEXT_CHARS)})`,
    `  unblocks ${u.transitiveDownstreamCount} downstream items (${u.directDownstreamCount} direct)`,
    ...top.map((item) => `  - ${truncate(item.label, CAP_TEXT_CHARS)}`),
  ];
}

function overnightGroupLines(groups: readonly { readonly type: string; readonly count: number }[]): string[] {
  const lines: string[] = [];
  for (const group of groups) {
    if (group.count < BULK_CHANGE_THRESHOLD) continue;
    if (group.type.startsWith("calendar.event.")) {
      const label = group.type.replace(/^calendar\.event\./, "").replace(/\./g, " ");
      lines.push(`- calendar sync: ${group.count} upcoming events ${label} (bulk import)`);
    } else {
      lines.push(`- ${group.type} ×${group.count} (bulk)`);
    }
  }
  const normal = groups.filter((g) => g.count < BULK_CHANGE_THRESHOLD);
  if (normal.length > 0) {
    lines.push(`- ${normal.reduce((n, g) => n + g.count, 0)} events:`);
    for (const group of normal.slice(0, CAP_OVERNIGHT_GROUPS)) {
      lines.push(`  - ${group.type} ×${group.count}`);
    }
    if (normal.length > CAP_OVERNIGHT_GROUPS) {
      lines.push(`  - …and ${normal.length - CAP_OVERNIGHT_GROUPS} more kinds`);
    }
  }
  return lines;
}

function overnightLines(data: DayStateData): string[] {
  const changed = data.overnight;
  const deltaEmpty =
    changed.eventGroups.length === 0 &&
    changed.commitments.length === 0 &&
    changed.decisions.length === 0 &&
    changed.relationships.length === 0;
  if (deltaEmpty) return [];
  const lines = ["OVERNIGHT", ...overnightGroupLines(changed.eventGroups)];
  if (changed.commitments.length > 0) {
    lines.push(
      `- ${changed.commitments.length} commitment${changed.commitments.length === 1 ? "" : "s"} captured:`,
    );
    for (const c of changed.commitments.slice(0, CAP_OVERNIGHT_ROWS)) {
      lines.push(
        `  - ${truncate(c.description, CAP_TEXT_CHARS)} (${c.direction}, ${c.status})`,
      );
    }
    if (changed.commitments.length > CAP_OVERNIGHT_ROWS) {
      lines.push(`  - …and ${changed.commitments.length - CAP_OVERNIGHT_ROWS} more`);
    }
  }
  if (changed.decisions.length > 0) {
    lines.push(
      `- ${changed.decisions.length} decision${changed.decisions.length === 1 ? "" : "s"}:`,
    );
    for (const d of changed.decisions.slice(0, CAP_OVERNIGHT_ROWS)) {
      lines.push(
        `  - ${truncate(d.question, CAP_TEXT_CHARS)} → ${truncate(d.chosen, CAP_TEXT_CHARS)}`,
      );
    }
    if (changed.decisions.length > CAP_OVERNIGHT_ROWS) {
      lines.push(`  - …and ${changed.decisions.length - CAP_OVERNIGHT_ROWS} more`);
    }
  }
  if (changed.relationships.length > 0) {
    lines.push(
      `- ${changed.relationships.length} relationship update${changed.relationships.length === 1 ? "" : "s"}`,
    );
  }
  return lines;
}

function escalationsLines(data: DayStateData): string[] {
  const e = data.escalations;
  const open = e.pending + e.batched;
  if (open === 0) return [];
  return [
    "ESCALATIONS",
    `- ${open} open (pending ${e.pending}, batched ${e.batched})`,
    ...e.byReason.map((r) => `- ${r.reason} ×${r.count}`),
  ];
}

export function renderDayStateText(data: DayStateData): string {
  const sections = [
    nowNextLines(data),
    waitingLines(data),
    blockedLines(data),
    unlockLines(data),
    overnightLines(data),
    escalationsLines(data),
  ].filter((section) => section.length > 0);

  const lines: string[] = [
    `Day state — ${dayStamp(data.now)}`,
    "",
    ...sections.flatMap((section) => [...section, ""]).slice(0, -1),
  ];
  if (sections.length === 1) {
    lines.push("", "All quiet — nothing waiting, nothing blocked.");
  }
  const caveats = freshnessLines(data.freshness.filter((f) => f.source === "calendar"));
  if (caveats.length > 0) {
    lines.push("", ...caveats);
  }
  return lines.map((line) => line.trimEnd()).join("\n") + "\n";
}
