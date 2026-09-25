// Control-plane reliability wave, goal 3 — typed, principal-scoped selector
// resolution for user-authorized mutations (directive 2026-09-25).
//
// THE PROBLEM THIS SOLVES: round-0 operations like commitment_transition /
// reminder_reply / occurrence_update previously required internal UUIDs the
// user never knows — and the only way cognition could learn a UUID is a
// read, which closes the §22.2 mutation window. Result: "mark seating chart
// done" was structurally impossible on the single path.
//
// THE PATTERN: cognition echoes the USER'S round-0 referent words into a
// typed selector ({"target":{"text":"seating chart"}}); THIS module resolves
// that selector deterministically against the authenticated principal's
// CANONICAL state inside the executor — after the authorization (the user's
// turn) and before the write. No external/tool data is consulted, so the
// mutation-window invariant is untouched: retrieved Gmail/calendar content
// can never authorize anything, because resolution reads only canonical
// tables owned by the control plane.
//
// Deterministic, never-guessing match semantics (shared by all resolvers):
// normalize (casefold, strip diacritics + punctuation, collapse whitespace,
// drop a fixed function-word list) then token-set containment EITHER
// direction. Exactly one candidate → resolved. Zero → not_found. More than
// one → ambiguous with bounded candidate labels. There is no scoring, no
// ranking, no fuzzy distance — ambiguity is an honest outcome the model
// turns into a natural clarifying question.

import type { SqlExecutor } from "../actions/audit.js";
import { localDayBounds } from "../calendar/projection.js";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";
import { listReminders } from "../reminders/queries.js";

export type TargetResolution<T> =
  | { readonly status: "resolved"; readonly value: T }
  | { readonly status: "not_found"; readonly searched: string }
  | {
      readonly status: "ambiguous";
      readonly searched: string;
      readonly candidates: readonly string[];
    };

/** Bounded candidate labels handed back to cognition (≤3, ≤80 chars each). */
const MAX_CANDIDATES = 3;
const CANDIDATE_LABEL_MAX_CHARS = 80;
export const SELECTOR_TEXT_MAX_CHARS = 80;

/** Function words + generic container nouns stripped from BOTH sides before
 *  containment matching. A fixed structural normalization list — never a
 *  semantic interpretation of the user's language. */
const SELECTOR_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "my", "your", "that", "this", "these", "those", "it", "its",
  "is", "was", "are", "were", "be", "been", "to", "for", "of", "on", "in",
  "at", "and", "or", "with", "about", "thing", "things", "stuff", "item",
  "items", "one", "please", "just", "actually",
]);

/** Clock-like tokens ("3pm", "15:00", "noon") — structural time noise on
 *  BOTH sides of the match, not identity words ("the 3pm dentist thing"
 *  names the dentist event; "3pm" is not its name). */
const TIME_TOKEN_RE = /^(\d{1,2}(:\d{2})?\s*(am|pm)?|noon|midnight|oclock)$/;

export function normalizeSelectorTokens(text: string): readonly string[] {
  const casefolded = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const tokens = casefolded
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(
      (token) =>
        token.length > 0 && !SELECTOR_STOPWORDS.has(token) && !TIME_TOKEN_RE.test(token),
    );
  return tokens;
}

/** Token-set containment in EITHER direction (both sides non-empty). */
export function selectorMatches(selectorText: string, candidateText: string): boolean {
  const selector = normalizeSelectorTokens(selectorText);
  const candidate = normalizeSelectorTokens(candidateText);
  if (selector.length === 0 || candidate.length === 0) return false;
  const selectorSet = new Set(selector);
  const candidateSet = new Set(candidate);
  const selectorInCandidate = selector.every((token) => candidateSet.has(token));
  const candidateInSelector = candidate.every((token) => selectorSet.has(token));
  return selectorInCandidate || candidateInSelector;
}

function boundLabel(label: string): string {
  return label.length <= CANDIDATE_LABEL_MAX_CHARS
    ? label
    : `${label.slice(0, CANDIDATE_LABEL_MAX_CHARS - 1)}…`;
}

function resolveFromCandidates<T>(
  searched: string,
  candidates: readonly { readonly label: string; readonly value: T }[],
): TargetResolution<T> {
  if (candidates.length === 1) {
    return { status: "resolved", value: candidates[0]!.value };
  }
  if (candidates.length === 0) {
    return { status: "not_found", searched };
  }
  return {
    status: "ambiguous",
    searched,
    candidates: candidates.slice(0, MAX_CANDIDATES).map((c) => boundLabel(c.label)),
  };
}

function civilDateLabel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(at);
}

function timeLabel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/**
 * OPEN commitments in the conversation's world-model domain (canonical
 * table only). NOTE: commitments are domain-scoped in the canonical model
 * (no principal column — the conversation surface serves the 'personal'
 * domain's single world model); the transition itself records the
 * principal as provenance, exactly like the UUID-form operation.
 */
const SELECTOR_DOMAIN_KEY = "personal";

export async function resolveOpenCommitmentByText(
  db: SqlExecutor,
  input: { readonly text: string; readonly now: Date },
): Promise<TargetResolution<{ readonly commitmentId: string; readonly description: string }>> {
  const result = await db.query(
    `SELECT c.id, c.description, c.due_at FROM commitments c
      JOIN domains dom ON dom.id = c.domain_id
      WHERE dom.key = $1 AND c.status = 'open'
      ORDER BY c.created_at ASC`,
    [SELECTOR_DOMAIN_KEY],
  );
  const candidates = result.rows
    .filter((row) => selectorMatches(input.text, String(row.description ?? "")))
    .map((row) => ({
      label: String(row.description ?? ""),
      value: { commitmentId: String(row.id), description: String(row.description ?? "") },
    }));
  return resolveFromCandidates(input.text, candidates);
}

/**
 * Calendar events starting today or tomorrow (civil, BRIEF_TIMEZONE),
 * non-cancelled — the canonical projection the occurrence service owns.
 * Occurrence corrections are same-day/next-day by nature; anything older
 * belongs to the calibration lane, not a round-0 mutation.
 */
export async function resolveCalendarOccurrenceByText(
  db: SqlExecutor,
  input: { readonly text: string; readonly now: Date },
): Promise<TargetResolution<{ readonly calendarEventId: string; readonly summary: string }>> {
  const today = localDayBounds(input.now, BRIEF_TIMEZONE);
  const tomorrowStart = new Date(today.dayEnd.getTime());
  const tomorrow = localDayBounds(tomorrowStart, BRIEF_TIMEZONE);
  const result = await db.query(
    `SELECT id, summary, start_time FROM calendar_events
      WHERE status <> 'cancelled'
        AND start_time >= $1::timestamptz
        AND start_time < $2::timestamptz
      ORDER BY start_time ASC`,
    [today.dayStart.toISOString(), tomorrow.dayEnd.toISOString()],
  );
  const candidates = result.rows
    .filter((row) => selectorMatches(input.text, String(row.summary ?? "")))
    .map((row) => {
      const start = row.start_time instanceof Date ? row.start_time : null;
      const when =
        start !== null
          ? ` (${civilDateLabel(start, BRIEF_TIMEZONE)} ${timeLabel(start, BRIEF_TIMEZONE)})`
          : "";
      return {
        label: `${String(row.summary ?? "")}${when}`,
        value: { calendarEventId: String(row.id), summary: String(row.summary ?? "") },
      };
    });
  return resolveFromCandidates(input.text, candidates);
}

/**
 * ARMED reminders of the authenticated principal (keyed by principal NAME —
 * the reminders table's convention). `checkIn: "live"` resolves the single
 * armed check-in awaiting a reply; a text selector matches armed titles.
 * Completed/parked/cancelled reminders are never resolvable — replying to
 * those is a not-found the model relays honestly.
 */
export async function resolveArmedReminder(
  db: SqlExecutor,
  input: {
    readonly principalName: string;
    readonly text: string | null;
    readonly checkIn: boolean;
    readonly now: Date;
  },
): Promise<TargetResolution<{ readonly reminderId: string; readonly title: string }>> {
  const armed = await listReminders(db, input.principalName, { statuses: ["armed"] });
  const candidates = armed
    .filter((row) => {
      if (input.checkIn) return true;
      return input.text !== null && selectorMatches(input.text, row.title);
    })
    .map((row) => {
      const time =
        row.dueTime !== null
          ? ` ${row.dueTime.slice(11, 16)}`
          : "";
      return {
        label: `${row.title} (due ${row.dueDate}${time})`,
        value: { reminderId: row.id, title: row.title },
      };
    });
  return resolveFromCandidates(input.checkIn ? "(live check-in)" : String(input.text), candidates);
}
