// Deterministic text rendering for the morning brief / evening close (§31
// shapes; plan §13). Pure functions over the collected data models — no DB,
// no clock, no model calls — so a golden string pins the exact output. Every
// line is trailing-whitespace-trimmed (same convention as metrics/render.ts).

import type { CommitmentListItem, WaitsOnMeItem } from "../queries/waiting.js";
import type { BlockedItem, StalledItem } from "../queries/blocked.js";
import type { EveningCloseData, MorningBriefData } from "./data.js";

function blank(): string {
  return "";
}

function dayStamp(iso: string): string {
  return iso.slice(0, 10);
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

function renderWaitingOnYou(data: MorningBriefData): string[] {
  const w = data.waitingOnYou;
  if (w.overdue.length === 0 && w.dueSoon.length === 0 && w.otherOpenCount === 0) {
    return ["WAITING ON YOU", "- nothing overdue or due soon"];
  }
  const lines = ["WAITING ON YOU"];
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
    return ["BLOCKED OR SILENTLY STALLED", "- nothing blocked or stalled"];
  }
  const lines = ["BLOCKED OR SILENTLY STALLED"];
  for (const item of blocked) lines.push(blockedLine(item, newEdgeIds.has(item.edgeId)));
  for (const item of stalled) lines.push(stalledLine(item));
  return lines;
}

function renderUnlockBrief(data: MorningBriefData): string[] {
  if (data.unlock === null) {
    return ["TODAY'S HIGHEST-LEVERAGE UNLOCK", "- no blocked downstream work to unlock"];
  }
  const u = data.unlock;
  return [
    "TODAY'S HIGHEST-LEVERAGE UNLOCK",
    `- ${u.question} (chosen: ${u.chosen})`,
    `  unblocks ${u.transitiveDownstreamCount} downstream items (${u.directDownstreamCount} direct)`,
    ...u.topBlockedItems.map((item) => `  - ${item.label}`),
  ];
}

function renderEscalations(data: MorningBriefData): string[] {
  const e = data.escalations;
  const open = e.pending + e.batched;
  if (open === 0) return ["OPEN ESCALATIONS", "- none open"];
  return [
    "OPEN ESCALATIONS",
    `- ${open} open (pending ${e.pending}, batched ${e.batched})`,
    ...e.byReason.map((r) => `- ${r.reason} ×${r.count}`),
  ];
}

/** §31 "while you were away" morning shape — delta first, then attention state. */
export function renderMorningBriefText(data: MorningBriefData): string {
  const changed = data.changed;
  const deltaEmpty =
    changed.eventGroups.length === 0 &&
    changed.commitments.length === 0 &&
    changed.decisions.length === 0 &&
    changed.relationships.length === 0;

  const whileAway: string[] = ["WHILE YOU WERE AWAY"];
  if (deltaEmpty) {
    whileAway.push("- no changes in window");
  } else {
    if (changed.eventGroups.length > 0) {
      whileAway.push(`- events: ${changed.eventGroups.reduce((n, g) => n + g.count, 0)}`);
      for (const group of changed.eventGroups) {
        whileAway.push(`  - ${group.type} ×${group.count}`);
      }
    }
    if (changed.commitments.length > 0) {
      whileAway.push(`- commitments changed: ${changed.commitments.length}`);
      for (const c of changed.commitments) {
        whileAway.push(`  - ${c.description} (${c.direction}, ${c.status})`);
      }
    }
    if (changed.decisions.length > 0) {
      whileAway.push(`- decisions changed: ${changed.decisions.length}`);
      for (const d of changed.decisions) {
        whileAway.push(`  - ${d.question} → ${d.chosen}`);
      }
    }
    if (changed.relationships.length > 0) {
      const byShape = new Map<string, number>();
      for (const r of changed.relationships) {
        const shape = `${r.fromType} ${r.relation} ${r.toType}`;
        byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
      }
      whileAway.push(`- relationships changed: ${changed.relationships.length}`);
      for (const [shape, count] of [...byShape.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        whileAway.push(`  - ${shape} ×${count}`);
      }
    }
  }

  const lines: string[] = [
    `MORNING BRIEF — ${dayStamp(data.now)} (${data.domainId})`,
    `delta since ${data.since}`,
    blank(),
    ...whileAway,
    blank(),
    ...renderWaitingOnYou(data),
    blank(),
    ...renderBlockedStalled(data.blocked, data.stalled, new Set<string>()),
    blank(),
    ...renderUnlockBrief(data),
    blank(),
    ...renderEscalations(data),
  ];
  return lines.map((line) => line.trimEnd()).join("\n") + "\n";
}

/** §31 "TODAY" evening shape — counts first, then standing state + tomorrow's unlock. */
export function renderEveningCloseText(data: EveningCloseData): string {
  const newEdges = new Set(data.newBlockedEdgeIds);
  const overdueWaiting = data.stillWaiting.filter((c) => c.overdue);
  const calmWaiting = data.stillWaiting.filter((c) => !c.overdue);

  const lines: string[] = [
    `EVENING CLOSE — ${dayStamp(data.now)} (${data.domainId})`,
    `delta since ${data.since}`,
    blank(),
    "TODAY",
    blank(),
    `Decisions made: ${data.decisionsMade.length}`,
    ...data.decisionsMade.map((d) => `- ${d.question} → ${d.chosen}`),
    blank(),
    `New commitments: ${data.newCommitments.length}`,
    ...data.newCommitments.map((c) => `- ${c.description} (${c.direction})`),
    blank(),
    `Completed: ${data.completed.length}`,
    ...data.completed.map((c) => `- ${c.description}`),
    blank(),
    `Still waiting: ${data.stillWaiting.length}`,
    ...overdueWaiting.map((c) => waitLine(c, "OVERDUE")),
    ...calmWaiting.map((c) => waitLine(c, null)),
    blank(),
    `New risks / blocked: ${data.blocked.length + data.stalled.length}`,
    ...data.blocked.map((b) => blockedLine(b, newEdges.has(b.edgeId))),
    ...data.stalled.map((s) => stalledLine(s)),
    blank(),
    "Tomorrow's highest-leverage unlock:",
    data.unlock === null
      ? "none"
      : `${data.unlock.question} (unblocks ${data.unlock.transitiveDownstreamCount} downstream items)`,
  ];
  return lines.map((line) => line.trimEnd()).join("\n") + "\n";
}
