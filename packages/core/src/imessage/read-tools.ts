// Phase E grounded reads — the read-tool registry for the iMessage
// conversation path (docs/plans/ig-phase-e-contracts.md).
//
// Strictly read-only: every tool here executes a deterministic
// server-side query; there is no write path in this module by
// construction. Dates resolve server-side only (localDayBounds,
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
import {
  getGmailMessageContent,
  searchGmailContentByKeyword,
} from "../gmail/content.js";
import { whatWaitsOnMe } from "../queries/waiting.js";
import { BRIEF_DOMAIN_KEY } from "../briefs/data.js";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";
import {
  collectDayState,
  DAY_STATE_COVERAGE,
  renderDayStateText,
} from "../queries/day-state.js";
import { freshnessLines } from "../queries/staleness.js";
import {
  MEMORY_RECALL_COVERAGE,
  recallMemory,
  renderMemoryRecallBlock,
} from "../queries/memory-recall.js";
import {
  collectSystemState,
  renderSystemStateText,
  SYSTEM_STATE_COVERAGE,
} from "../queries/system-state.js";

export type ReadToolCall =
  | { readonly tool: "calendar.day"; readonly day: "today" | "tomorrow" }
  | { readonly tool: "calendar.next" }
  | { readonly tool: "commitments.waiting" }
  | { readonly tool: "gmail.recent" }
  | { readonly tool: "gmail.search"; readonly query?: string; readonly max_age_days?: number }
  | { readonly tool: "gmail.read"; readonly message_id?: string }
  | { readonly tool: "day.state" }
  | { readonly tool: "memory.recall" }
  | { readonly tool: "system.state" };

export type ReadSource = "calendar" | "commitments" | "gmail" | "state" | "memory" | "system";

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
// Phase GMAIL §8: gmail.recent caps — sender-domain field truncation,
// aggregate row cap 25, latest-arrivals bound 5. NEVER subjects/bodies.
const CAP_GMAIL_DOMAIN = 80;
const CAP_GMAIL_DOMAIN_ROWS = 25;
const CAP_GMAIL_LATEST = 5;
const GMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
// Intelligence reset C4 (docs/plans/intelligence-reset.md §11 C4):
// gmail_messages content reads — bounded keyword search + single-message
// read over ADR-0016's untrusted, principal-scoped, 7-day-retention
// records. Same discipline: read-only SELECTs, truncation + row caps
// before anything reaches a prompt.
const CAP_GMAIL_QUERY = 120;
const CAP_GMAIL_MESSAGE_ID = 200;
const CAP_GMAIL_SUBJECT = 120;
const CAP_GMAIL_SNIPPET = 160;
const CAP_GMAIL_SNIPPET_LEAD = 40;
const CAP_GMAIL_SEARCH_ROWS = 8;
const CAP_GMAIL_READ_BODY = 4000;
const GMAIL_CONTENT_MAX_AGE_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const CAP_DAY_STATE_TEXT = 4000;

const CALENDAR_COVERAGE =
  "calendar events only; email, chat, and notes are not connected";
const COMMITMENTS_COVERAGE =
  "manually captured commitments in the world model only";
// Coverage honesty (Phase GMAIL §8.4): Gmail = the owner's ONE connected
// account, metadata only — never "email" in general, never message content.
const GMAIL_COVERAGE =
  "Gmail (your connected account): recent inbox arrivals, last 24h (metadata only; no subjects or bodies)";
const GMAIL_NO_SENSOR_COVERAGE =
  "no gmail events ingested — gmail sensor may not be enabled";
// C4 coverage: the same one account, now with bounded content depth —
// 7-day window, keyword match, sanitized untrusted bodies.
const GMAIL_SEARCH_COVERAGE =
  "Gmail (your connected account): keyword match over subject, sender, and body text, last 7 days only; not full mail search (no operators, no attachments)";
const GMAIL_READ_COVERAGE =
  "Gmail (your connected account): one message by id, last 7 days only; body is sanitized untrusted content";
const GMAIL_READ_NOT_FOUND_COVERAGE =
  "Gmail (your connected account): message not found — mail content is kept for 7 days only, so older messages are no longer available";

export function readToolSource(tool: ReadToolCall["tool"]): ReadSource {
  if (tool === "commitments.waiting") return "commitments";
  if (tool === "gmail.recent" || tool === "gmail.search" || tool === "gmail.read") return "gmail";
  if (tool === "day.state") return "state";
  if (tool === "memory.recall") return "memory";
  if (tool === "system.state") return "system";
  return "calendar";
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
  if (obj["tool"] === "gmail.search") {
    if (
      keys.length < 2 ||
      keys.length > 3 ||
      !keys.every((key) => key === "tool" || key === "query" || key === "max_age_days")
    ) {
      return null;
    }
    const query = obj["query"];
    if (typeof query !== "string" || query.trim().length < 1 || query.length > CAP_GMAIL_QUERY) {
      return null;
    }
    const call: { tool: "gmail.search"; query: string; max_age_days?: number } = {
      tool: "gmail.search",
      query: query.trim(),
    };
    const maxAgeDays = obj["max_age_days"];
    if (maxAgeDays !== undefined) {
      if (
        typeof maxAgeDays !== "number" ||
        !Number.isInteger(maxAgeDays) ||
        maxAgeDays < 1 ||
        maxAgeDays > GMAIL_CONTENT_MAX_AGE_DAYS
      ) {
        return null;
      }
      call.max_age_days = maxAgeDays;
    }
    return call;
  }
  if (obj["tool"] === "gmail.read") {
    if (keys.length !== 2 || obj["message_id"] === undefined) return null;
    const messageId = obj["message_id"];
    if (typeof messageId !== "string" || messageId.length < 1 || messageId.length > CAP_GMAIL_MESSAGE_ID) {
      return null;
    }
    return { tool: "gmail.read", message_id: messageId };
  }
  if (
    obj["tool"] === "calendar.next" ||
    obj["tool"] === "commitments.waiting" ||
    obj["tool"] === "gmail.recent" ||
    obj["tool"] === "day.state" ||
    obj["tool"] === "memory.recall" ||
    obj["tool"] === "system.state"
  ) {
    if (keys.length !== 1) return null;
    return { tool: obj["tool"] } as ReadToolCall;
  }
  return null; // "none", unknown tools, garbage — all fail safe
}

/** True for the router's intentional no-lookup declaration — NOT a parse
 *  failure, so it must never trigger fallback escalation. */
export function isRouteNoneJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    return Object.keys(obj).length === 1 && obj["tool"] === "none";
  } catch {
    return false;
  }
}

/**
 * The gmail.recent instruction line for the route pass (Phase GMAIL §8).
 * buildRoutingPrompt is orchestrator-owned; the orchestrator splices this
 * line in with the other tool lines. Pure constant — returns the exact
 * route JSON plus its natural-language triggers.
 */
export function gmailRoutingLine(): string {
  return '{"tool":"gmail.recent"} — asks what email arrived recently / what came in over email / inbox today';
}

/** C4 content-retrieval routing lines (intelligence-reset §11 C4). */
export function gmailSearchRoutingLine(): string {
  return '{"tool":"gmail.search","query":"<text>","max_age_days":<1-7, optional>} — asks what an email said / who wrote about X / what did <sender> say / any email mentioning X — pass a short keyword phrase, not a sentence (searches subject, sender, and body of the last 7 days)';
}

export function gmailReadRoutingLine(): string {
  return '{"tool":"gmail.read","message_id":"<messageId>"} — asks to open one specific email by the messageId shown in an earlier gmail.search result';
}

export const READ_SET_TOOLS = [
  "calendar.next",
  "commitments.waiting",
  "gmail.recent",
  "gmail.search",
  "gmail.read",
  "day.state",
  "memory.recall",
  "system.state",
] as const;

export type ReadSetTool = (typeof READ_SET_TOOLS)[number];

export const READ_SET_MAX_TOOLS = 3;

export const READ_BLOCK_CHAR_BUDGET = 1500;

const READ_SET_TOOL_NAMES: ReadonlySet<string> = new Set(READ_SET_TOOLS);

export function parseRouteReadSet(text: string): readonly ReadToolCall[] | null {
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
  if (obj["tools"] !== undefined) {
    if (Object.keys(obj).length !== 1) return null;
    if (!Array.isArray(obj["tools"])) return null;
    const names: unknown[] = obj["tools"];
    if (names.length < 1 || names.length > READ_SET_MAX_TOOLS) return null;
    const seen = new Set<string>();
    const calls: ReadToolCall[] = [];
    for (const name of names) {
      if (typeof name !== "string" || !READ_SET_TOOL_NAMES.has(name)) return null;
      if (seen.has(name)) return null;
      seen.add(name);
      calls.push({ tool: name as ReadSetTool });
    }
    return calls;
  }
  const single = parseRouteJson(trimmed);
  return single === null ? null : [single];
}

export interface ReadSetBlock {
  readonly tool: string;
  readonly source: ReadSource;
  readonly coverage: string;
  readonly data: unknown;
  readonly serialized?: string;
  readonly truncated: boolean;
  readonly charBudget: number;
}

export interface ReadSetOptions {
  readonly now?: () => Date;
  readonly blockCharBudget?: number;
  readonly queryText?: string;
}

export async function runReadSet(
  db: SqlExecutor,
  principalId: string,
  tools: readonly string[],
  opts: ReadSetOptions = {},
): Promise<readonly ReadSetBlock[]> {
  if (tools.length < 1 || tools.length > READ_SET_MAX_TOOLS) {
    throw new RangeError(`read set must carry 1 to ${READ_SET_MAX_TOOLS} tools, got ${tools.length}`);
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    if (typeof tool !== "string" || !READ_SET_TOOL_NAMES.has(tool)) {
      throw new RangeError(`read set tool '${String(tool)}' is not allowlisted`);
    }
    if (seen.has(tool)) {
      throw new RangeError(`read set tool '${tool}' appears more than once`);
    }
    seen.add(tool);
  }
  const charBudget = opts.blockCharBudget ?? READ_BLOCK_CHAR_BUDGET;
  if (!Number.isFinite(charBudget) || charBudget < 1) {
    throw new RangeError(`blockCharBudget must be a positive number, got ${String(opts.blockCharBudget)}`);
  }
  const calls: ReadToolCall[] = tools.map((tool) => ({ tool: tool as ReadSetTool }));
  const results = await Promise.all(
    calls.map((call) =>
      executeReadTool(db, call, { now: opts.now, principalId, queryText: opts.queryText }),
    ),
  );
  return results.map((result) => {
    const serialized = JSON.stringify(result.data);
    if (serialized.length <= charBudget) {
      return { ...result, serialized, truncated: false, charBudget };
    }
    return {
      tool: result.tool,
      source: result.source,
      coverage: result.coverage,
      data: truncate(serialized, charBudget),
      serialized,
      truncated: true,
      charBudget,
    };
  });
}

export function dayStateRoutingLine(): string {
  return '{"tool":"day.state"} — asks what is going on / for an overview of today and where things stand overall';
}

export function memoryRecallRoutingLine(): string {
  return '{"tool":"memory.recall"} — asks about something previously decided, committed, noted, or remembered ("what did I decide about X", "did I say anything about X")';
}

export function systemStateRoutingLine(): string {
  return '{"tool":"system.state"} — asks what the system can see/do, its sources, version, cost, coverage, or limitations ("what can you see", "what are you")';
}

export function multiReadRoutingLine(): string {
  return '{"tools":["calendar.next","commitments.waiting","gmail.recent","day.state","memory.recall","system.state"]} — a composite question that clearly needs 2 or 3 of the lookups at once; 1 to 3 names, no repeats, names only (calendar.day keeps its single-tool shape)';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

// Phase GMAIL §8.1: deterministic SQL over gmail.message.received events
// (contract §4: source `adapter:gmail`; content-free payloads — only
// fromDomain + the event timestamp are ever read). Read-only SELECTs,
// personal-domain-scoped like every other read. Lane G2 owns the sync
// that emits these rows; if its source naming differs from the contract,
// these constants are the single place to reconcile.
const GMAIL_EVENT_TYPE = "gmail.message.received";
const GMAIL_EVENT_SOURCE = "adapter:gmail";

const GMAIL_DOMAIN_AGGREGATE_SQL = `
  SELECT ev.payload->>'fromDomain' AS from_domain, count(*)::int AS n
  FROM events ev JOIN domains d ON d.id = ev.domain_id
  WHERE ev.type = $1 AND ev.source = $2
    AND ev.occurred_at >= $3::timestamptz AND ev.occurred_at < $4::timestamptz
    AND d.key = $5
  GROUP BY ev.payload->>'fromDomain'
  ORDER BY n DESC, from_domain ASC
`;

const GMAIL_LATEST_SQL = `
  SELECT ev.occurred_at
  FROM events ev JOIN domains d ON d.id = ev.domain_id
  WHERE ev.type = $1 AND ev.source = $2
    AND ev.occurred_at >= $3::timestamptz AND ev.occurred_at < $4::timestamptz
    AND d.key = $5
  ORDER BY ev.occurred_at DESC, ev.id DESC
  LIMIT $6::int
`;

const GMAIL_SENSOR_EXISTS_SQL = `
  SELECT 1 AS ok
  FROM events ev JOIN domains d ON d.id = ev.domain_id
  WHERE ev.type = $1 AND ev.source = $2 AND d.key = $3
  LIMIT 1
`;

/**
 * Times are PRE-RENDERED server-side in BRIEF_TIMEZONE (deterministic
 * temporal resolution — the model never does date/timezone math; the
 * owner directive caught a live 16:00Z → "4:00 PM" misrender on
 * 2026-09-19). Raw ISO instants never reach the prompt.
 */
function hhmm(instant: Date): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    timeZone: BRIEF_TIMEZONE,
  }).format(instant);
  return formatted.replace(":00 ", " ");
}

function dayItem(event: {
  readonly summary: string;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly location: string | null;
}): { readonly when: string; readonly title: string; readonly location: string | null } {
  const start = new Date(event.startTime);
  const end = event.endTime === null ? null : new Date(event.endTime);
  const when = end === null ? hhmm(start) : `${hhmm(start)}–${hhmm(end)}`;
  return {
    when,
    title: truncate(event.summary, CAP_EVENT_SUMMARY),
    location: event.location === null ? null : truncate(event.location, CAP_LOCATION),
  };
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

/** A mail message's received time as one pre-rendered civil string
 *  ("Sat, Sep 19 9:41 AM") — raw ISO instants never reach the prompt. */
function mailDayTime(instant: string | null): string | null {
  if (instant === null) return null;
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  return `${dueDay(date.toISOString())} ${hhmm(date)}`;
}

/** C4: the search snippet is the window around the query's FIRST match
 *  in the body — not the body's start. Whitespace collapses to single
 *  spaces (compact, and no raw newlines exist to ride); cut points are
 *  ellipsis-marked; the total stays within CAP_GMAIL_SNIPPET. */
function gmailSnippet(body: string, needle: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const match = flat.toLowerCase().indexOf(needle);
  const start = Math.max(0, match - CAP_GMAIL_SNIPPET_LEAD);
  const raw =
    (start > 0 ? "…" : "") +
    flat.slice(start, start + CAP_GMAIL_SNIPPET) +
    (start + CAP_GMAIL_SNIPPET < flat.length ? "…" : "");
  return truncate(raw, CAP_GMAIL_SNIPPET);
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

/** Civil date of the day's START in BRIEF_TIMEZONE (verifier C2 — a UTC
 *  slice would mislabel days in zones east of UTC). */
function dayIso(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRIEF_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Execute one policy-approved read tool. Deterministic, read-only. */
export async function executeReadTool(
  db: SqlExecutor,
  call: ReadToolCall,
  opts: {
    readonly now?: () => Date;
    readonly principalId?: string;
    readonly queryText?: string;
    readonly policyReads?: readonly string[];
    readonly actionsEnabled?: boolean | null;
  } = {},
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
        due: dueDay(c.dueAt),
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
    case "gmail.recent": {
      // Last 24h rolling window, resolved server-side from the injected
      // clock (deterministic, pinnable); half-open like every other read.
      const windowStart = new Date(now.getTime() - GMAIL_WINDOW_MS);
      const params = [
        GMAIL_EVENT_TYPE,
        GMAIL_EVENT_SOURCE,
        windowStart.toISOString(),
        now.toISOString(),
        BRIEF_DOMAIN_KEY,
      ];
      const [byDomain, latest, sensor] = await Promise.all([
        query.query(GMAIL_DOMAIN_AGGREGATE_SQL, params),
        query.query(GMAIL_LATEST_SQL, [...params, CAP_GMAIL_LATEST]),
        query.query(GMAIL_SENSOR_EXISTS_SQL, [
          GMAIL_EVENT_TYPE,
          GMAIL_EVENT_SOURCE,
          BRIEF_DOMAIN_KEY,
        ]),
      ]);
      const domains = byDomain.rows.map((row) => ({
        fromDomain:
          row.from_domain === null || row.from_domain === undefined
            ? null
            : truncate(String(row.from_domain), CAP_GMAIL_DOMAIN),
        count: Number(row.n ?? 0),
      }));
      const total = domains.reduce((sum, d) => sum + d.count, 0);
      return {
        tool: call.tool,
        source: "gmail",
        coverage:
          sensor.rows.length > 0 ? GMAIL_COVERAGE : GMAIL_NO_SENSOR_COVERAGE,
        data: {
          timezone: BRIEF_TIMEZONE,
          windowHours: GMAIL_WINDOW_MS / 3_600_000,
          totalMessages: total,
          domains: domains.slice(0, CAP_GMAIL_DOMAIN_ROWS),
          truncated: domains.length > CAP_GMAIL_DOMAIN_ROWS,
          // SQL LIMIT bounds the query; the slice re-asserts the cap at the
          // render layer (contract §8.1) regardless of executor behavior.
          latestTimes: latest.rows
            .slice(0, CAP_GMAIL_LATEST)
            .map((row) => hhmm(new Date(row.occurred_at as string))),
        },
      };
    }
    case "gmail.search": {
      if (opts.principalId === undefined) {
        throw new Error("gmail.search requires principalId (content reads are principal-scoped)");
      }
      const query = (call.query ?? opts.queryText ?? "").trim().slice(0, CAP_GMAIL_QUERY);
      if (query.length < 1) {
        throw new Error("gmail.search requires a query (parsed or queryText — keywords from the user's message)");
      }
      const maxAgeDays = Math.min(
        Math.max(call.max_age_days ?? GMAIL_CONTENT_MAX_AGE_DAYS, 1),
        GMAIL_CONTENT_MAX_AGE_DAYS,
      );
      const records = await searchGmailContentByKeyword(db, opts.principalId, {
        text: query,
        since: new Date(now.getTime() - maxAgeDays * MS_PER_DAY).toISOString(),
        limit: CAP_GMAIL_SEARCH_ROWS,
      });
      const needle = query.toLowerCase();
      // SQL LIMIT bounds the query; the slice re-asserts the row cap at
      // the render layer regardless of executor behavior.
      const matches = records.slice(0, CAP_GMAIL_SEARCH_ROWS).map((record) => ({
        messageId: record.gmailMessageId,
        from: record.fromAddr === null ? null : truncate(record.fromAddr, CAP_GMAIL_DOMAIN),
        subject: record.subject === null ? null : truncate(record.subject, CAP_GMAIL_SUBJECT),
        date: mailDayTime(record.internalDate ?? record.ingestedAt),
        snippet: gmailSnippet(record.bodyText ?? "", needle),
      }));
      return {
        tool: call.tool,
        source: "gmail",
        coverage: GMAIL_SEARCH_COVERAGE,
        data: {
          timezone: BRIEF_TIMEZONE,
          query,
          windowDays: maxAgeDays,
          matchCount: matches.length,
          matches,
          truncated: records.length > CAP_GMAIL_SEARCH_ROWS,
        },
      };
    }
    case "gmail.read": {
      if (opts.principalId === undefined) {
        throw new Error("gmail.read requires principalId (content reads are principal-scoped)");
      }
      const notFound: ReadToolResult = {
        tool: call.tool,
        source: "gmail",
        coverage: GMAIL_READ_NOT_FOUND_COVERAGE,
        data: { found: false },
      };
      const messageId = call.message_id ?? "";
      if (messageId.length < 1 || messageId.length > CAP_GMAIL_MESSAGE_ID) return notFound;
      const record = await getGmailMessageContent(db, opts.principalId, messageId);
      if (record === null) return notFound;
      const received = new Date(record.internalDate ?? record.ingestedAt);
      if (
        !Number.isFinite(received.getTime()) ||
        received.getTime() < now.getTime() - GMAIL_CONTENT_MAX_AGE_DAYS * MS_PER_DAY
      ) {
        return notFound;
      }
      return {
        tool: call.tool,
        source: "gmail",
        coverage: GMAIL_READ_COVERAGE,
        data: {
          found: true,
          messageId: record.gmailMessageId,
          from: record.fromAddr === null ? null : truncate(record.fromAddr, CAP_GMAIL_DOMAIN),
          subject: record.subject === null ? null : truncate(record.subject, CAP_GMAIL_SUBJECT),
          date: mailDayTime(record.internalDate ?? record.ingestedAt),
          bodyTruncated: record.bodyTruncated,
          body: truncate(record.bodyText ?? "", CAP_GMAIL_READ_BODY),
        },
      };
    }
    case "day.state": {
      if (opts.principalId === undefined) {
        throw new Error("day.state requires principalId (escalations are principal-scoped)");
      }
      const state = await collectDayState(query, opts.principalId, { now: () => now });
      return {
        tool: call.tool,
        source: "state",
        coverage: DAY_STATE_COVERAGE,
        data: {
          timezone: BRIEF_TIMEZONE,
          date: dayIso(localDayBounds(now, BRIEF_TIMEZONE).dayStart),
          stale: freshnessLines(state.freshness.filter((f) => f.source === "calendar")),
          text: truncate(renderDayStateText(state), CAP_DAY_STATE_TEXT),
        },
      };
    }
    case "memory.recall": {
      if (opts.principalId === undefined) {
        throw new Error("memory.recall requires principalId (recall is principal-scoped)");
      }
      if (opts.queryText === undefined) {
        throw new Error("memory.recall requires queryText (relevance matches the user's message)");
      }
      const items = await recallMemory(query, {
        principalId: opts.principalId,
        queryText: opts.queryText,
        now: () => now,
      });
      return {
        tool: call.tool,
        source: "memory",
        coverage: MEMORY_RECALL_COVERAGE,
        data: {
          recalled: items.length,
          lines: renderMemoryRecallBlock(items),
        },
      };
    }
    case "system.state": {
      if (opts.principalId === undefined) {
        throw new Error("system.state requires principalId (introspection is principal-scoped)");
      }
      const state = await collectSystemState(query, {
        principalId: opts.principalId,
        now: () => now,
        policyReads: opts.policyReads,
        actionsEnabled: opts.actionsEnabled ?? null,
      });
      return {
        tool: call.tool,
        source: "system",
        coverage: SYSTEM_STATE_COVERAGE,
        data: {
          text: truncate(renderSystemStateText(state), CAP_DAY_STATE_TEXT),
        },
      };
    }
  }
}
