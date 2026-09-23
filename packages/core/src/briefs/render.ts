// Deterministic text rendering for the morning brief / evening close (§31
// shapes; plan §13). Pure functions over the collected data models — no DB,
// no clock, no model calls — so a golden string pins the exact output. Every
// line is trailing-whitespace-trimmed (same convention as metrics/render.ts).

import type { CommitmentListItem, WaitsOnMeItem } from "../queries/waiting.js";
import type { BlockedItem, StalledItem } from "../queries/blocked.js";
import { BRIEF_TIMEZONE } from "./timezone.js";
import type { TodayScheduleItem } from "../calendar/projection.js";
import type {
  OutcomesBriefSection,
  OutcomeBriefItem, EveningCloseData, MorningBriefData } from "./data.js";
import { OUTCOMES_BRIEF_MAX_PER_LIST } from "./data.js";
import { renderDivergenceBlock } from "./divergence.js";

function blank(): string {
  return "";
}

function dayStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(iso));
}

function waitLine(
  item: CommitmentListItem | WaitsOnMeItem,
  flag: "OVERDUE" | "DUE SOON" | null,
): string {
  const flagPart = flag === null ? "" : `${flag} `;
  const duePart = item.dueAt === null ? "" : ` — due ${item.dueAt}`;
  return `- ${flagPart}${item.description}${duePart} (${item.direction} ${item.counterpartyText})`;
}

function blockedLine(item: BlockedItem, isNew: boolean): string {
  const newPart = isNew ? "NEW " : "";
  const cyclePart = item.cycle ? " (dependency cycle)" : "";
  return `- ${newPart}${item.itemLabel} — blocked by ${item.blockerType} "${item.blockerLabel}"${cyclePart}`;
}

function stalledLine(item: StalledItem): string {
  return `- ${item.itemLabel} — stalled ${item.stalledForDays.toFixed(1)}d (threshold ${item.thresholdDays}d)`;
}

/** W6-phase-2: parked reminders surface once, here — terse, no follow-up promised. */
function renderStoppedReminders(data: EveningCloseData): string[] {
  if (data.stoppedReminders.length === 0) {
    return []; // suppression rule
  }
  return [
    "Stopped reminders",
    ...data.stoppedReminders.map((r) => `- Stopped texting about: ${r.title} — still open.`),
  ];
}

function renderWaitingOnYou(data: MorningBriefData): string[] {
  const w = data.waitingOnYou;
  if (w.overdue.length === 0 && w.dueSoon.length === 0 && w.otherOpenCount === 0) {
    return []; // suppression rule
  }
  const lines = ["Waiting on you"];
  for (const item of w.overdue) lines.push(waitLine(item, "OVERDUE"));
  for (const item of w.dueSoon) lines.push(waitLine(item, "DUE SOON"));
  if (w.otherOpenCount > 0) {
    lines.push(`- ${w.otherOpenCount} more open commitments without near due dates`);
  }
  return lines;
}

function renderBlockedStalled(
  blocked: readonly BlockedItem[],
  stalled: readonly StalledItem[],
  newEdgeIds: ReadonlySet<string>,
): string[] {
  if (blocked.length === 0 && stalled.length === 0) {
    return []; // suppression rule: nothing to say says nothing
  }
  const lines = ["Blocked or stalled"];
  for (const item of blocked) lines.push(blockedLine(item, newEdgeIds.has(item.edgeId)));
  for (const item of stalled) lines.push(stalledLine(item));
  return lines;
}

function renderUnlockBrief(data: MorningBriefData): string[] {
  if (data.unlock === null) {
    return []; // suppression rule
  }
  const u = data.unlock;
  return [
    "Best unlock today",
    `- ${u.question} (chosen: ${u.chosen})`,
    `  unblocks ${u.transitiveDownstreamCount} downstream items (${u.directDownstreamCount} direct)`,
    ...u.topBlockedItems.map((item) => `  - ${item.label}`),
  ];
}

/** Owner-local times (BRIEF_TIMEZONE) — the reader's wall clock wins over
 *  the event creator's timezone (an interview created as "12 PM Eastern"
 *  is 9 AM to the owner). */
function hhmm(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BRIEF_TIMEZONE,
  }).format(d);
  return formatted.replace(":00 ", " "); // "9:00 AM" → "9 AM"
}

/** Next-up is by definition a future day — always carry its date. */
function datedScheduleLine(item: TodayScheduleItem): string {
  const datePart = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(item.startTime));
  return `${datePart} · ${scheduleLine(item).slice(2)}`;
}

function scheduleLine(item: TodayScheduleItem): string {
  const title = item.summary.length > 0 ? item.summary : "(untitled)";
  const startF = hhmm(item.startTime);
  const endF = item.endTime === null ? null : hhmm(item.endTime);
  // Compact range: "9–10 AM" instead of "9 AM–10 AM" (same meridiem).
  const when =
    endF === null
      ? startF
      : endF.endsWith(startF.slice(-3))
        ? `${startF.slice(0, -3)}–${endF}`
        : `${startF}–${endF}`;
  const locationPart = item.location === null ? "" : ` (${item.location})`;
  return `- ${when} ${title}${locationPart}`;
}

/** E3: today's calendar from the projection — deterministic, calendar-native times. */
function renderTodaySchedule(
  schedule: readonly TodayScheduleItem[],
  nextUpcoming: TodayScheduleItem | null,
): string[] {
  if (schedule.length > 0) return ["Today", ...schedule.map(scheduleLine)];
  if (nextUpcoming !== null) {
    return ["Today", "- nothing scheduled", `- next up: ${datedScheduleLine(nextUpcoming)}`];
  }
  return ["Today", "- nothing scheduled"];
}

function renderEscalations(data: MorningBriefData): string[] {
  const e = data.escalations;
  const open = e.pending + e.batched;
  if (open === 0) return [];
  return [
    "Escalations",
    `- ${open} open (pending ${e.pending}, batched ${e.batched})`,
    ...e.byReason.map((r) => `- ${r.reason} ×${r.count}`),
  ];
}

/**
 * Phase G "Needs your call" section (ig-phase-g-contracts.md §4.2): live
 * review refs with one-line item summaries (the candidate statement IS the
 * review surface — ≤80 chars), bounded to the digest the data layer
 * collected. Suppressed entirely when nothing waits (§31 no-noise rule).
 */
function renderReviewSection(data: MorningBriefData): string[] {
  const review = data.review;
  if (review === null) return [];
  const items = review.candidates.length + review.escalations.length;
  if (items === 0) return []; // suppression rule
  const lines = ["Needs your call"];
  for (const c of review.candidates) lines.push(`- [${c.ref}] ${c.summary}`);
  for (const e of review.escalations) lines.push(`- [${e.ref}] escalation ${e.summary}`);
  const more = review.moreCandidates + review.moreEscalations;
  if (more > 0) lines.push(`- …and ${more} more`);
  return lines;
}

/** Bulk import collapse: a single change kind with a large count is a
 *  backfill, not a human-readable delta (e.g. initial calendar sync). */
const BULK_CHANGE_THRESHOLD = 20;

function friendlyEventGroups(
  groups: ReadonlyArray<{ type: string; count: number }>,
): string[] {
  const lines: string[] = [];
  for (const g of groups) {
    if (g.count >= BULK_CHANGE_THRESHOLD) {
      const label = g.type.replace(/^calendar\.event\./, "").replace(/\./g, " ");
      lines.push(`- calendar sync: ${g.count} upcoming events ${label} (bulk import)`);
    }
  }
  const normal = groups.filter((g) => g.count < BULK_CHANGE_THRESHOLD);
  if (normal.length > 0) {
    lines.push(`- ${normal.reduce((n, g) => n + g.count, 0)} events:`);
    for (const g of normal.slice(0, 3)) lines.push(`  - ${g.type} ×${g.count}`);
    if (normal.length > 3) lines.push(`  - …and ${normal.length - 3} more kinds`);
  }
  return lines;
}

/** §31 "while you were away" morning shape — delta first, then attention state.
 *  Suppression rule (plan M6B): a section with nothing to say says nothing. */
/**
 * Delegated-outcome progress (D0 finisher). Honest + bounded: needs-you
 * first (the brief is the nudge, not an interrupt), then in-flight, then
 * window-resolved with their terminal status. §31: an empty section never
 * renders.
 */
export function renderOutcomesSection(outcomes: OutcomesBriefSection | null | undefined): string[] {
  if (outcomes === null || outcomes === undefined) return [];
  const lines: string[] = ["Delegated outcomes"];
  const cap = (items: readonly OutcomeBriefItem[], render: (item: OutcomeBriefItem) => string): string[] => {
    const out = items.slice(0, OUTCOMES_BRIEF_MAX_PER_LIST).map(render);
    if (items.length > OUTCOMES_BRIEF_MAX_PER_LIST) out.push(`  - …and ${items.length - OUTCOMES_BRIEF_MAX_PER_LIST} more`);
    return out;
  };
  lines.push(...cap(outcomes.needsYou, (o) => `- ${o.ref} needs your verification — "${o.title}"`));
  lines.push(...cap(outcomes.active, (o) => `- ${o.ref} in progress — "${o.title}"`));
  lines.push(...cap(outcomes.resolved, (o) => `- ${o.ref} ${o.status === "completed" ? "completed" : "failed"} — "${o.title}"`));
  for (const result of outcomes.results ?? []) {
    const summary = result.summary.length > 0 ? `: ${result.summary}` : "";
    lines.push(`- ${result.ref} ${result.role} result — "${result.title}"${summary}`);
  }
  return lines.length > 1 ? lines : [];
}

export function renderMorningBriefText(data: MorningBriefData): string {
  const changed = data.changed;
  const deltaEmpty =
    changed.eventGroups.length === 0 &&
    changed.commitments.length === 0 &&
    changed.decisions.length === 0 &&
    changed.relationships.length === 0;

  const whileAway: string[] = [];
  if (!deltaEmpty) {
    whileAway.push(...friendlyEventGroups(changed.eventGroups));
    if (changed.commitments.length > 0) {
      whileAway.push(`- ${changed.commitments.length} commitment${changed.commitments.length === 1 ? "" : "s"} captured:`);
      for (const c of changed.commitments.slice(0, 5)) {
        whileAway.push(`  - ${c.description} (${c.direction}, ${c.status})`);
      }
      if (changed.commitments.length > 5) {
        whileAway.push(`  - …and ${changed.commitments.length - 5} more`);
      }
    }
    if (changed.decisions.length > 0) {
      whileAway.push(`- ${changed.decisions.length} decision${changed.decisions.length === 1 ? "" : "s"}:`);
      for (const d of changed.decisions.slice(0, 5)) {
        whileAway.push(`  - ${d.question} → ${d.chosen}`);
      }
    }
    if (changed.relationships.length > 0) {
      whileAway.push(`- ${changed.relationships.length} relationship update${changed.relationships.length === 1 ? "" : "s"}`);
    }
  }

  const waiting = renderWaitingOnYou(data);
  const blocked = renderBlockedStalled(data.blocked, data.stalled, new Set<string>());
  const unlock = renderUnlockBrief(data);
  const escalations = renderEscalations(data);
  const review = renderReviewSection(data);
  const outcomes = renderOutcomesSection(data.outcomes);

  const sections: string[][] = [
    renderTodaySchedule(data.todaySchedule, data.nextUpcoming),
    whileAway.length > 0 ? ["Overnight", ...whileAway] : [],
    waiting,
    blocked,
    unlock,
    escalations,
    outcomes,
    review,
  ].filter((section) => section.length > 0);

  const quiet = sections.length === 1 && whileAway.length === 0;
  const lines: string[] = [
    `Morning brief — ${dayStamp(data.now)}`,
    blank(),
    ...sections.flatMap((section) => [...section, blank()]).slice(0, -1),
    ...(quiet ? [blank(), "All quiet — nothing waiting on you."] : []),
  ];
  return lines.map((line) => line.trimEnd()).join("\n") + "\n";
}

/** §31 "TODAY" evening shape — counts first, then standing state + tomorrow's unlock. */
export function renderEveningCloseText(data: EveningCloseData): string {
  const newEdges = new Set(data.newBlockedEdgeIds);
  const overdueWaiting = data.stillWaiting.filter((c) => c.overdue);
  const calmWaiting = data.stillWaiting.filter((c) => !c.overdue);

  // Suppression rule (plan M6B): a section with nothing to say says nothing.
  const sections: string[][] = [
    data.decisionsMade.length > 0
      ? ["Decisions made", ...data.decisionsMade.map((d) => `- ${d.question} → ${d.chosen}`)]
      : [],
    data.newCommitments.length > 0
      ? ["New commitments", ...data.newCommitments.map((c) => `- ${c.description} (${c.direction})`)]
      : [],
    data.completed.length > 0
      ? ["Completed", ...data.completed.map((c) => `- ${c.description}`)]
      : [],
    data.stillWaiting.length > 0
      ? [
          `Still waiting: ${data.stillWaiting.length}`,
          ...overdueWaiting.map((c) => waitLine(c, "OVERDUE")),
          ...calmWaiting.map((c) => waitLine(c, null)),
        ]
      : [],
    data.blocked.length + data.stalled.length > 0
      ? [
          "New risks / blocked",
          ...data.blocked.map((b) => blockedLine(b, newEdges.has(b.edgeId))),
          ...data.stalled.map((s) => stalledLine(s)),
        ]
      : [],
    renderStoppedReminders(data),
    renderOutcomesSection(data.outcomes),
    data.unlock !== null
      ? [
          "Tomorrow's best unlock",
          `- ${data.unlock.question} (unblocks ${data.unlock.transitiveDownstreamCount} downstream items)`,
        ]
      : [],
    // W5(d): plan churn renders LAST as its own honesty-pinned section;
    // suppressed entirely on quiet days (divergence === null).
    data.divergence !== null ? renderDivergenceBlock(data.divergence) : [],
  ].filter((section) => section.length > 0);

  const quiet = sections.length === 0;
  const lines: string[] = [
    `Evening close — ${dayStamp(data.now)}`,
    blank(),
    ...(quiet ? ["Quiet day — nothing carried, nothing waiting."] : []),
    ...sections.flatMap((section) => [...section, blank()]).slice(0, -1),
  ];
  return lines.map((line) => line.trimEnd()).join("\n") + "\n";
}
