// Phase H action routing — the action arm of the route pass
// (calendar proposals). Mirrors read-tools.ts parseRouteJson's
// fail-safe posture: any deviation → null, never a throw.
// Deterministic day/time resolution (bounds, wall-clock parsing)
// lives in calendar-actions; this module only extracts, sanitizes,
// and bounds the route model's JSON. Titles pass the same denylist
// redaction as stored content (redact.ts) before anything downstream
// can consume them.

import { redactContent } from "./redact.js";

/**
 * A parsed calendar.create action request. Unknown extra keys in the
 * route JSON are ALLOWED (forward-compat with provider quirks) but
 * only these fields are ever consumed downstream. location/
 * description/attendees are null when the payload omits them (old
 * minimal payloads parse unchanged).
 */
export interface ActionRouteRequest {
  readonly action: "calendar.create";
  readonly title: string;
  readonly day: "today" | "tomorrow";
  readonly time: string | null;
  readonly endTime: string | null;
  readonly durationMinutes: number | null;
  readonly location: string | null;
  readonly description: string | null;
  readonly attendees: readonly string[] | null;
}

/** Wall-clock strings are taken verbatim from the message; strict
 *  time parsing is downstream's job. This only bounds length and
 *  charset — deliberately loose ("25:00" passes here, "7pm" and
 *  "19:00" are the norms). */
const TIME_PATTERN = /^[0-9]{1,2}(:[0-5][0-9])?\s*(am|pm)?$/i;
const CAP_TIME_CHARS = 8;
const TITLE_MIN = 1;
const TITLE_MAX = 120;
const DURATION_MIN = 15;
const DURATION_MAX = 720;
const LOCATION_MAX = 200;
const DESCRIPTION_MAX = 2000;
const ATTENDEE_EMAIL_MAX = 254;
const ATTENDEE_MAX = 10;
const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * First JSON object in the text — fenced, bare, or prose-wrapped;
 * leftmost object wins. Same sniff-then-JSON.parse posture as
 * read-tools.ts parseRouteJson, extended to skip fences/prose and
 * to stop at the FIRST object when several appear.
 */
function firstJsonObject(text: string): Record<string, unknown> | null {
  for (
    let start = text.indexOf("{");
    start !== -1;
    start = text.indexOf("{", start + 1)
  ) {
    for (
      let end = text.indexOf("}", start);
      end !== -1;
      end = text.indexOf("}", end + 1)
    ) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        continue;
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  }
  return null;
}

/** Strip control chars, collapse whitespace runs, trim, then redact
 *  secrets — in that order. Shared by title, location, and
 *  description. */
function sanitizeText(raw: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const noControls = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  // Adversary A2: Cf format chars (RTL override U+202E etc.) visually
  // reorder the render — strip the whole category.
  const noFormat = noControls.replace(/\p{Cf}/gu, "");
  const collapsed = noFormat.replace(/\s+/g, " ").trim();
  return redactContent(collapsed);
}

/**
 * Strict parse of the action route arm. Requires reply_kind
 * "action" (missing → invalid), action "calendar.create", day in
 * enum, a bounded time string or null, an integer duration 15–240
 * or null, and a title that survives sanitization + redaction at
 * 1–120 chars. Optional: sanitized location (1–200) / description
 * (1–2000), and attendees — strict lowercased emails, deduped
 * first-seen order, at most 10 after dedupe (never redacted:
 * redaction patterns cannot match a valid email). Missing or null
 * optional keys → null fields. Extra keys are allowed. Every
 * reject path returns null; this never throws.
 */
export function parseActionRouteJson(text: string): ActionRouteRequest | null {
  const obj = firstJsonObject(text);
  if (obj === null) return null;
  if (obj["reply_kind"] !== "action") return null;
  if (obj["action"] !== "calendar.create") return null;
  const day = obj["day"];
  if (day !== "today" && day !== "tomorrow") return null;
  const rawTime = obj["time"];
  let time: string | null = null;
  if (rawTime !== null) {
    if (typeof rawTime !== "string") return null;
    if (rawTime.length > CAP_TIME_CHARS) return null;
    if (!TIME_PATTERN.test(rawTime)) return null;
    time = rawTime;
  }
  const rawEndTime = obj["end_time"] ?? null;
  let endTime: string | null = null;
  if (rawEndTime !== null) {
    if (typeof rawEndTime !== "string") return null;
    if (rawEndTime.length > CAP_TIME_CHARS) return null;
    if (!TIME_PATTERN.test(rawEndTime)) return null;
    endTime = rawEndTime;
  }
  const rawDuration = obj["duration_minutes"];
  let durationMinutes: number | null = null;
  if (rawDuration !== null) {
    if (typeof rawDuration !== "number") return null;
    if (!Number.isInteger(rawDuration)) return null;
    if (rawDuration < DURATION_MIN || rawDuration > DURATION_MAX) return null;
    durationMinutes = rawDuration;
  }
  if (typeof obj["title"] !== "string") return null;
  const title = sanitizeText(obj["title"]);
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) return null;
  const rawLocation = obj["location"] ?? null;
  let location: string | null = null;
  if (rawLocation !== null) {
    if (typeof rawLocation !== "string") return null;
    location = sanitizeText(rawLocation);
    if (location.length < 1 || location.length > LOCATION_MAX) return null;
  }
  const rawDescription = obj["description"] ?? null;
  let description: string | null = null;
  if (rawDescription !== null) {
    if (typeof rawDescription !== "string") return null;
    description = sanitizeText(rawDescription);
    if (description.length < 1 || description.length > DESCRIPTION_MAX) return null;
  }
  const rawAttendees = obj["attendees"] ?? null;
  let attendees: readonly string[] | null = null;
  if (rawAttendees !== null) {
    if (!Array.isArray(rawAttendees)) return null;
    const seen = new Set<string>();
    const list: string[] = [];
    for (const entry of rawAttendees) {
      if (typeof entry !== "string") return null;
      if (entry.length > ATTENDEE_EMAIL_MAX) return null;
      if (!EMAIL_PATTERN.test(entry)) return null;
      const lower = entry.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        list.push(lower);
      }
    }
    if (list.length > ATTENDEE_MAX) return null;
    attendees = list;
  }
  return {
    action: "calendar.create",
    title,
    day,
    time,
    endTime,
    durationMinutes,
    location,
    description,
    attendees,
  };
}

/**
 * Prompt block for the route pass: when to emit the calendar.create
 * action JSON. Deterministic phrasing, merged above the lookup arm
 * of the routing prompt.
 */
export function buildActionRoutingInstructions(): string {
  return [
    "Scheduling actions: in addition to the lookups above, if the user imperatively asks you to add an event to their calendar, respond with ONLY this JSON object on a single line, no prose, no markdown:",
    '{"reply_kind":"action","action":"calendar.create","title":"<event name>","day":"today"|"tomorrow","time":"<wall-clock string>"|null,"end_time":"<wall-clock string>"|null,"duration_minutes":<minutes integer>|null,"location":"<place or address>"|null,"description":"<note>"|null,"attendees":["<email>"]|null}',
    "Field rules:",
    '- day: "today" or "tomorrow" only. An unsaid day means today. If the user names any other day ("tuesday", "next week"), do NOT emit the action — fall back to {"tool":"none"}.',
    '- title: the event name WITHOUT the day/time words, at most 120 characters ("schedule Dentist tomorrow at 7pm" → title "Dentist").',
    '- time: the wall-clock string exactly as written ("7pm", "19:00"), or null if no time was stated. Never invent a time.',
    '- duration_minutes: an integer, only when explicitly stated ("for 90 minutes" → 90); otherwise null.',
    '- end_time: the wall-clock END time when the user gives a range ("from 2pm to 11pm" → time "2pm", end_time "11pm", duration_minutes null). Prefer end_time over duration_minutes when both are inferable; never invent one.',
    '- location: the place/address exactly as the user wrote it, only when stated ("at 15038 River Rock, Fontana CA" → "15038 River Rock, Fontana CA"); never invent one; null otherwise.',
    '- description: extra details only when the user gives a note/description ("note: bring snacks" → "bring snacks"); keep it verbatim-ish, at most 2000 chars; null otherwise.',
    '- attendees: ONLY literal email addresses the user names as guests/invitees ("invite sam@example.com" → ["sam@example.com"]); never invent or guess emails from names; null when none.',
    'Emit the action ONLY for imperative scheduling requests: "add X to my calendar", "schedule X tomorrow at 7pm", "put X on my calendar".',
    "Emit exactly ONE JSON object in total — either the lookup shape or the action shape, never both, never two.",
    'NEVER emit the action for questions ("do I have anything tomorrow?"), hypotheticals ("maybe I should schedule X"), negations ("don\'t schedule X"), or events beyond tomorrow (later this week, next week).',
    "Examples:",
    '"put Dentist on my calendar tomorrow at 7pm for 90 minutes" → {"reply_kind":"action","action":"calendar.create","title":"Dentist","day":"tomorrow","time":"7pm","end_time":null,"duration_minutes":90,"location":null,"description":null,"attendees":null}',
    '"add Henna tomorrow from 2pm to 11pm" → {"reply_kind":"action","action":"calendar.create","title":"Henna","day":"tomorrow","time":"2pm","end_time":"11pm","duration_minutes":null,"location":null,"description":null,"attendees":null}',
    '"schedule Henna tomorrow from 2pm to 11pm at 15038 River Rock, Fontana CA, invite sam@example.com and lea@example.com, note: bring snacks" → {"reply_kind":"action","action":"calendar.create","title":"Henna","day":"tomorrow","time":"2pm","end_time":"11pm","duration_minutes":null,"location":"15038 River Rock, Fontana CA","description":"bring snacks","attendees":["sam@example.com","lea@example.com"]}',
    '"do I have anything on my calendar tomorrow?" → NOT an action → {"tool":"calendar.day","day":"tomorrow"}',
  ].join("\n");
}

/** Cheap branch test: the first JSON object has reply_kind "action".
 *  (Presence of a well-formed action payload is parseActionRouteJson's
 *  job — this only decides whether to attempt the full parse.) */
export function isActionRouteOutput(text: string): boolean {
  const obj = firstJsonObject(text);
  return obj !== null && obj["reply_kind"] === "action";
}
