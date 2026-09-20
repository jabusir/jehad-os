// Phase E grounded reads — the read-tool registry for the iMessage
// conversation path (docs/plans/ig-phase-e-contracts.md).
//
// Strictly read-only: exactly three tools exist here, each executing a
// deterministic server-side query; there is no write path in this module
// by construction. Dates resolve server-side only (localDayBounds,
// BRIEF_TIMEZONE — DST-safe); the model never does date math.
// Everything that reaches a prompt is truncated + row-capped first
// (injection-door minimization), and tool results are DATA, never
// authority — the answer prompt wraps them in a marked untrusted block.

import type { SqlExecutor } from "../actions/audit.js";
import type { QueryExecutor } from "../queries/executor.js";
import {
  getCalendarDaySchedule,
  getUpcomingEvents,
  localDayBounds,
} from "../calendar/projection.js";
import { whatWaitsOnMe } from "../queries/waiting.js";
import { BRIEF_DOMAIN_KEY } from "../briefs/data.js";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";

export type ReadToolCall =
  | { readonly tool: "calendar.day"; readonly day: "today" | "tomorrow" }
  | { readonly tool: "calendar.next" }
  | { readonly tool: "commitments.waiting" };

export type ReadSource = "calendar" | "commitments";

export interface ReadToolResult {
  readonly tool: string;
  readonly source: ReadSource;
  /** Coverage-honesty sentence — what this source does and does not see. */
  readonly coverage: string;
  /** JSON-serializable, already truncated + row-capped. */
  readonly data: unknown;
}

/** Truncation/row caps before anything reaches a prompt (contract §4). */
const CAP_EVENT_SUMMARY = 120;
const CAP_LOCATION = 80;
const CAP_DESCRIPTION = 160;
const CAP_DAY_ROWS = 25;
const CAP_NEXT_ROWS = 3;
const CAP_WAITING_ROWS = 15;

const CALENDAR_COVERAGE =
  "calendar events only; email, chat, and notes are not connected";
const COMMITMENTS_COVERAGE =
  "manually captured commitments in the world model only";

export function readToolSource(tool: ReadToolCall["tool"]): ReadSource {
  return tool === "commitments.waiting" ? "commitments" : "calendar";
}

/**
 * Strict parse of the route pass (contract §2): one JSON object, exact
 * keys, exact enum values, nothing else. Any deviation → null (fail safe
 * to plain chat). Prose, markdown fences, arrays, extra fields, unknown
 * tools (e.g. a "calendar.write" injection) all parse to null.
 */
export function parseRouteJson(text: string): ReadToolCall | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (obj["tool"] === "calendar.day") {
    if (keys.length !== 2 || obj["day"] === undefined) return null;
    if (obj["day"] !== "today" && obj["day"] !== "tomorrow") return null;
    return { tool: "calendar.day", day: obj["day"] };
  }
  if (obj["tool"] === "calendar.next" || obj["tool"] === "commitments.waiting") {
    if (keys.length !== 1) return null;
    return { tool: obj["tool"] } as ReadToolCall;
  }
  return null; // "none", unknown tools, garbage — all fail safe
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function dayItem(event: {
  readonly summary: string;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly location: string | null;
}): { readonly start: string; readonly end: string | null; readonly title: string; readonly location: string | null } {
  return {
    start: event.startTime,
    end: event.endTime,
    title: truncate(event.summary, CAP_EVENT_SUMMARY),
    location: event.location === null ? null : truncate(event.location, CAP_LOCATION),
  };
}

/** Resolve a calendar.day call to explicit civil-day bounds, DST-safe
 *  (tomorrow = the day that starts at today.dayEnd + 1ms). */
export function resolveDayBounds(
  day: "today" | "tomorrow",
  now: Date,
): { dayStart: Date; dayEnd: Date; dateIso: string } {
  const today = localDayBounds(now, BRIEF_TIMEZONE);
  if (day === "today") {
    return { dayStart: today.dayStart, dayEnd: today.dayEnd, dateIso: dayIso(today.dayStart) };
  }
  const tomorrow = localDayBounds(new Date(today.dayEnd.getTime() + 1), BRIEF_TIMEZONE);
  return { dayStart: tomorrow.dayStart, dayEnd: tomorrow.dayEnd, dateIso: dayIso(tomorrow.dayStart) };
}

function dayIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Execute one policy-approved read tool. Deterministic, read-only. */
export async function executeReadTool(
  db: SqlExecutor,
  call: ReadToolCall,
  opts: { readonly now?: () => Date } = {},
): Promise<ReadToolResult> {
  const now = opts.now?.() ?? new Date();
  const query = db as unknown as QueryExecutor;
  switch (call.tool) {
    case "calendar.day": {
      const { dayStart, dayEnd, dateIso } = resolveDayBounds(call.day, now);
      const events = await getCalendarDaySchedule(query, { dayStart, dayEnd });
      return {
        tool: call.tool,
        source: "calendar",
        coverage: CALENDAR_COVERAGE,
        data: {
          date: dateIso,
          timezone: BRIEF_TIMEZONE,
          total: events.length,
          items: events.slice(0, CAP_DAY_ROWS).map(dayItem),
          truncated: events.length > CAP_DAY_ROWS,
        },
      };
    }
    case "calendar.next": {
      const { dayEnd } = localDayBounds(now, BRIEF_TIMEZONE);
      const events = await getUpcomingEvents(query, { dayEnd, limit: CAP_NEXT_ROWS });
      return {
        tool: call.tool,
        source: "calendar",
        coverage: CALENDAR_COVERAGE,
        data: {
          timezone: BRIEF_TIMEZONE,
          items: events.map(dayItem),
        },
      };
    }
    case "commitments.waiting": {
      const waiting = await whatWaitsOnMe(query, {
        domainId: BRIEF_DOMAIN_KEY,
        now: () => now,
      });
      const overdue = waiting.filter((c) => c.overdue);
      const dueSoon = waiting.filter((c) => !c.overdue && c.dueSoon);
      const item = (c: (typeof waiting)[number]) => ({
        description: truncate(c.description, CAP_DESCRIPTION),
        counterparty: truncate(c.counterpartyText, CAP_LOCATION),
        due: c.dueAt,
      });
      const otherOpen = waiting.length - overdue.length - dueSoon.length;
      return {
        tool: call.tool,
        source: "commitments",
        coverage: COMMITMENTS_COVERAGE,
        data: {
          overdueCount: overdue.length,
          overdue: overdue.slice(0, CAP_WAITING_ROWS).map(item),
          dueSoonCount: dueSoon.length,
          dueSoon: dueSoon.slice(0, CAP_WAITING_ROWS).map(item),
          otherOpenCount: otherOpen,
        },
      };
    }
  }
}
