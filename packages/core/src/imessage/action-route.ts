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
 * only these five fields are ever consumed downstream.
 */
export interface ActionRouteRequest {
  readonly action: "calendar.create";
  readonly title: string;
  readonly day: "today" | "tomorrow";
  readonly time: string | null;
  readonly durationMinutes: number | null;
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
const DURATION_MAX = 240;

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
 *  secrets — in that order. */
function sanitizeTitle(raw: string): string {
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
 * 1–120 chars. Extra keys are allowed. Every reject path returns
 * null; this never throws.
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
  const rawDuration = obj["duration_minutes"];
  let durationMinutes: number | null = null;
  if (rawDuration !== null) {
    if (typeof rawDuration !== "number") return null;
    if (!Number.isInteger(rawDuration)) return null;
    if (rawDuration < DURATION_MIN || rawDuration > DURATION_MAX) return null;
    durationMinutes = rawDuration;
  }
  if (typeof obj["title"] !== "string") return null;
  const title = sanitizeTitle(obj["title"]);
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) return null;
  return { action: "calendar.create", title, day, time, durationMinutes };
}

/**
 * Prompt block for the route pass: when to emit the calendar.create
 * action JSON. Deterministic phrasing, merged above the lookup arm
 * of the routing prompt.
 */
export function buildActionRoutingInstructions(): string {
  return [
    "Scheduling actions: in addition to the lookups above, if the user imperatively asks you to add an event to their calendar, respond with ONLY this JSON object on a single line, no prose, no markdown:",
    '{"reply_kind":"action","action":"calendar.create","title":"<event name>","day":"today"|"tomorrow","time":"<wall-clock string>"|null,"duration_minutes":<minutes integer>|null}',
    "Field rules:",
    '- day: "today" or "tomorrow" only. An unsaid day means today. If the user names any other day ("tuesday", "next week"), do NOT emit the action — fall back to {"tool":"none"}.',
    '- title: the event name WITHOUT the day/time words, at most 120 characters ("schedule Dentist tomorrow at 7pm" → title "Dentist").',
    '- time: the wall-clock string exactly as written ("7pm", "19:00"), or null if no time was stated. Never invent a time.',
    '- duration_minutes: an integer, only when explicitly stated ("for 90 minutes" → 90); otherwise null.',
    'Emit the action ONLY for imperative scheduling requests: "add X to my calendar", "schedule X tomorrow at 7pm", "put X on my calendar".',
    "Emit exactly ONE JSON object in total — either the lookup shape or the action shape, never both, never two.",
    'NEVER emit the action for questions ("do I have anything tomorrow?"), hypotheticals ("maybe I should schedule X"), negations ("don\'t schedule X"), or events beyond tomorrow (later this week, next week).',
    "Examples:",
    '"put Dentist on my calendar tomorrow at 7pm for 90 minutes" → {"reply_kind":"action","action":"calendar.create","title":"Dentist","day":"tomorrow","time":"7pm","duration_minutes":90}',
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
