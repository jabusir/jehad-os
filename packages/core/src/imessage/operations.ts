// §22 build item 2 — the typed cognitive-operation registry (intelligence
// reset §22.2/§22.3/§22.4/§22.6, docs/plans/intelligence-reset.md).
//
// Three surfaces over EXISTING writers (import, never duplicate):
//
//   1. `parseCognitiveEnvelope` — the strict single-line-JSON envelope of
//      the single-author path: ≤3 catalog reads, ≤4 typed operations,
//      ≤2 proposal resolutions, an EPHEMERAL `interpretation` (never
//      persisted by this module — audit rows carry ids/counts/statuses
//      only), a structured `intent` enum, and an optional ≤1500-char
//      `reply` (present only under §22.3's finality rule — the loop owns
//      that rule; the parser only bounds the text).
//
//   2. `CONSENT_CLASS_BAR` / `resolutionAllowed` — §22.6's structural
//      consent bar: `proposal_resolutions` may `apply` ONLY
//      non-consequential parks; outcome_spec / calendar_action /
//      cross_principal_profile resolve exclusively through their token
//      lanes (§22.10.3/4).
//
//   3. `executeOperation` — thin executors delegating to the surviving
//      bridges (§22.11): applyTaskBatch, applySystemFeedback,
//      applyMemoryCandidate, applyConfigurationDirective, reminder
//      queries, applyCommitmentTransition, confirmOccurrence, the
//      calibration store fns, calendar propose. Parking IS execution
//      (§22.3): task_batch/outcome_spec park via the thread
//      pending-proposal slots; calendar_action parks as a
//      confirm-token intent. Round-0 mutation-window enforcement lives
//      in the loop, not here.
//
// Data hygiene, NOT word policing (owner correction 2, §22.2): validation
// is STRUCTURAL — type-registry membership, exact key sets, arg shapes,
// bounds, redaction via redactContent at parse. There is NO
// forbidden-word scan of `reply`, `interpretation`, titles, or any other
// payload text anywhere in this module. The ONE vocabulary door kept is
// the profile validators' own address-term name-shape door (§22.4: "All
// values pass the existing profile validators (name-shape door, forbidden
// vocabulary)") — a structural property of profile values, not a scan of
// conversational text.

import { createHash } from "node:crypto";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { UUID_RE } from "../events/envelope.js";
import { confirmOccurrence, CalendarEventNotFoundError, OccurrenceAlreadyGraduatedError } from "../calendar/occurrence.js";
import { applyCommitmentTransition } from "../commitments/transitions.js";
import { eligibleCalibrationItem, storeCalibrationRating, storeMissedFeedback } from "../calibration/service.js";
import {
  cancelReminder,
  completeReminder,
  createReminder,
  getReminder,
  renegotiateReminder,
} from "../reminders/queries.js";
import { computeFirstTouch, resolveWhenWords, REMINDER_POLICY } from "../reminders/lifecycle.js";
import { proposeCalendarAction, type CalendarActionPolicy } from "./calendar-actions.js";
import { resolveProposedSchedule } from "./propose-schedule.js";
import type { CalibrationCorrectionCategory } from "./calibration-verbs.js";
import { READ_SET_MAX_TOOLS, READ_SET_TOOLS, parseRouteJson, type ReadToolCall } from "./read-tools.js";
import { redactContent } from "./redact.js";
import type { CapturePolicy } from "./capture.js";
import {
  parseThreadMetadata,
  setThreadPendingProposals,
  type ThreadPendingProposal,
  type ThreadPendingProposalType,
} from "./threads.js";
import {
  JOSCTL_PROFILE_DEFINITION,
  PERSONA_FRAGMENT_FORBIDDEN_WORDS,
  activeProfile,
  applyDefinitionDelta,
  nextProfileVersion,
  seedProfile,
  type ProfileDefinitionDelta,
} from "./profiles.js";
import {
  applyConfigurationDirective,
  applyMemoryCandidate,
  applySystemFeedback,
  applyTaskBatch,
  FEEDBACK_DETAIL_MAX_CHARS,
  FEEDBACK_SUBJECT_MAX_CHARS,
  MEMORY_SUMMARY_MAX_CHARS,
  OUTCOME_CRITERION_MAX_CHARS,
  OUTCOME_DIRECTIVE_MAX_CHARS,
  OUTCOME_MAX_BUDGET_USD,
  OUTCOME_MAX_CRITERIA,
  OUTCOME_MAX_DEADLINE_DAYS,
  OUTCOME_TITLE_MAX_CHARS,
  TASK_BATCH_MAX_ITEMS,
  TASK_DUE_MAX_CHARS,
  TASK_TITLE_MAX_CHARS,
  type SystemFeedbackCategory,
  type TurnInterpretationDb,
} from "./turn-interpretation.js";
import {
  CALENDAR_ATTENDEE_MAX_CHARS,
  CALENDAR_ATTENDEES_MAX,
  CALENDAR_DESCRIPTION_MAX_CHARS,
  CALENDAR_DURATION_MAX_MS,
  CALENDAR_DURATION_MIN_MS,
  CALENDAR_LOCATION_MAX_CHARS,
  CALENDAR_TITLE_MAX_CHARS,
} from "./calendar-actions.js";

// ---------------------------------------------------------------------------
// Operation registry (§22.4) — pure validators, fail-closed (null, never a guess)
// ---------------------------------------------------------------------------

export type CognitiveOperationType =
  | "profile_update"
  | "task_batch"
  | "reminder_create"
  | "reminder_reply"
  | "commitment_transition"
  | "occurrence_update"
  | "calibration_feedback"
  | "system_feedback"
  | "memory_candidate"
  | "calendar_action"
  | "outcome_spec"
  | "cross_principal_profile";

export const COGNITIVE_OPERATION_TYPES: readonly CognitiveOperationType[] = [
  "profile_update",
  "task_batch",
  "reminder_create",
  "reminder_reply",
  "commitment_transition",
  "occurrence_update",
  "calibration_feedback",
  "system_feedback",
  "memory_candidate",
  "calendar_action",
  "outcome_spec",
  "cross_principal_profile",
];

const OPERATION_TYPE_NAMES: ReadonlySet<string> = new Set(COGNITIVE_OPERATION_TYPES);

/**
 * Self-preference profile change (§22.4 low-risk self-preference — the
 * incident-B fix, final form). At most ONE change field per operation;
 * a set replaces (address is single-valued) and set+remove combos reject
 * structurally at parse. Parsed branches carry the change key required.
 */
export type ProfileUpdateOperation =
  | { readonly type: "profile_update"; readonly addressOwnerName: string }
  | { readonly type: "profile_update"; readonly removeAddress: true }
  | { readonly type: "profile_update"; readonly toneNote: string }
  | { readonly type: "profile_update"; readonly brevityMaxSentences: number }
  | { readonly type: "profile_update"; readonly extraDirective: string };

/** One change key per op — the wire shape allows any ONE of exactly these. */
const PROFILE_CHANGE_KEYS: readonly string[] = [
  "addressOwnerName",
  "removeAddress",
  "toneNote",
  "brevityMaxSentences",
  "extraDirective",
];

const PROFILE_TONE_NOTE_MAX_CHARS = 120; // PROFILE_EXTRA_DIRECTIVE_MAX_CHARS convention (profiles.ts)
const PROFILE_BREVITY_MAX_SENTENCES_CEILING = 10; // op bound (schema ceiling is 20; the op is a target, kept tighter)

export interface OperationTaskItem {
  readonly title: string;
  /** The USER'S deadline words, verbatim ("by wednesday"); parsed at apply. */
  readonly due: string | null;
}

export interface TaskBatchOperation {
  readonly type: "task_batch";
  readonly items: readonly OperationTaskItem[];
}

/** parseReminderPhrase-shaped reminder ask (§22.4: apply immediately). */
export interface ReminderCreateTime {
  readonly hour: number;
  readonly minute: number;
}

export interface ReminderCreateOperation {
  readonly type: "reminder_create";
  readonly title: string;
  /** Principal-local civil date 'YYYY-MM-DD' (server-resolved or model-carried). */
  readonly dueDate: string | null;
  readonly dueTime: ReminderCreateTime | null;
  /** The user's when-words, verbatim ("tomorrow at 9am"); null when none. */
  readonly whenWords: string | null;
}

export type ReminderReplyKind = "done" | "stop" | "not_done" | "renegotiate";

export interface ReminderReplyOperation {
  readonly type: "reminder_reply";
  readonly reminderId: string;
  readonly kind: ReminderReplyKind;
  readonly whenText: string | null;
}

export type CommitmentTransitionVerb = "done" | "missed" | "renegotiated";

export interface CommitmentTransitionOperation {
  readonly type: "commitment_transition";
  readonly commitmentId: string;
  readonly verb: CommitmentTransitionVerb;
  readonly note: string | null;
}

export interface OccurrenceUpdateOperation {
  readonly type: "occurrence_update";
  readonly calendarEventId: string;
  readonly happened: boolean;
}

export type CalibrationFeedbackKind = "rating" | "miss" | "correction";

export type CalibrationFeedbackOperation =
  | { readonly type: "calibration_feedback"; readonly kind: "rating"; readonly rating: number }
  | { readonly type: "calibration_feedback"; readonly kind: "miss" }
  | {
      readonly type: "calibration_feedback";
      readonly kind: "correction";
      readonly category: CalibrationCorrectionCategory;
    };

export interface SystemFeedbackOperation {
  readonly type: "system_feedback";
  readonly category: SystemFeedbackCategory;
  readonly subject: string;
  readonly detail: string | null;
}

export interface MemoryCandidateOperation {
  readonly type: "memory_candidate";
  readonly summary: string;
}

/** Ported from action-route.ts's ActionRouteRequest shape (private there). */
export interface CalendarActionOperation {
  readonly type: "calendar_action";
  readonly title: string;
  readonly day: "today" | "tomorrow";
  readonly time: string | null;
  readonly endTime: string | null;
  readonly durationMinutes: number | null;
  readonly location: string | null;
  readonly description: string | null;
  readonly attendees: readonly string[] | null;
}

/** Ported from turn-interpretation.ts's coerceOutcomeSpec shape. */
export interface OutcomeSpecOperation {
  readonly type: "outcome_spec";
  readonly title: string;
  readonly directive: string;
  readonly criteria: readonly string[];
  readonly budget_usd: number | null;
  readonly deadline_days: number | null;
}

export interface CrossPrincipalProfileOperation {
  readonly type: "cross_principal_profile";
  readonly targetPrincipal: string;
  readonly change: { readonly ownerName?: string; readonly toneNote?: string };
}

export type CognitiveOperation =
  | ProfileUpdateOperation
  | TaskBatchOperation
  | ReminderCreateOperation
  | ReminderReplyOperation
  | CommitmentTransitionOperation
  | OccurrenceUpdateOperation
  | CalibrationFeedbackOperation
  | SystemFeedbackOperation
  | MemoryCandidateOperation
  | CalendarActionOperation
  | OutcomeSpecOperation
  | CrossPrincipalProfileOperation;

// ------------------------------------------------------------- shared helpers

/** Strip control chars + Cf format chars, collapse whitespace, trim (A2) —
 *  the repo sanitize convention (turn-interpretation.ts / action-route.ts). */
function sanitizeText(raw: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const noControls = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  const noFormat = noControls.replace(/\p{Cf}/gu, "");
  return noFormat.replace(/\s+/g, " ").trim();
}

/** Present keys are a subset of `keys` (no unknown keys). */
function exactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) return false;
  }
  return true;
}

/** Sanitize + redact + bound a payload string (data hygiene at parse). */
function coerceBoundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const text = redactContent(sanitizeText(value));
  if (text.length === 0 || text.length > maxChars) return null;
  return text;
}

function coerceIntInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/**
 * The profile lane's address-term door (§22.4): values must pass the
 * EXISTING profile validators' name-shape check (profiles.ts's private
 * ADDRESS_TERM_RE + the persona-fragment forbidden words it applies).
 * This is the profile validator itself, not an envelope text scan.
 */
const PROFILE_ADDRESS_TERM_RE = /^[A-Za-z0-9' .-]{1,60}$/;

function coerceProfileOwnerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const term = redactContent(sanitizeText(value));
  if (!PROFILE_ADDRESS_TERM_RE.test(term)) return null;
  const lower = term.toLowerCase();
  for (const word of PERSONA_FRAGMENT_FORBIDDEN_WORDS) {
    if (lower.includes(word)) return null;
  }
  return term;
}

const REMINDER_TITLE_MAX_CHARS = TASK_TITLE_MAX_CHARS;
const REMINDER_WHEN_MAX_CHARS = 40; // parseReminderPhrase due-word bound convention
const REMINDER_NOTE_MAX_CHARS = 120;
const DATE_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function coerceCivilDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_ISO_RE.test(value)) return null;
  return Number.isNaN(Date.parse(`${value}T12:00:00Z`)) ? null : value;
}

function coerceDueTime(value: unknown): ReminderCreateTime | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (!exactKeys(obj, ["hour", "minute"])) return null;
  const hour = coerceIntInRange(obj.hour, 0, 23);
  const minute = coerceIntInRange(obj.minute, 0, 59);
  if (hour === null || minute === null) return null;
  return { hour, minute };
}

const REMINDER_REPLY_KINDS: ReadonlySet<string> = new Set(["done", "stop", "not_done", "renegotiate"]);
const COMMITMENT_VERBS: ReadonlySet<string> = new Set(["done", "missed", "renegotiated"]);
const SYSTEM_FEEDBACK_CATEGORIES: ReadonlySet<string> = new Set(["capability_gap", "bug", "request"]);
const CALIBRATION_FEEDBACK_KINDS: ReadonlySet<string> = new Set(["rating", "miss", "correction"]);

// The 7 correction categories (calibration-verbs.ts's CalibrationCorrectionCategory).
const CALIBRATION_CORRECTION_CATEGORIES: readonly string[] = [
  "planned_not_observed",
  "observed_but_missing",
  "wrong_sequence",
  "wrong_priority",
  "wrong_completion_state",
  "source_coverage_gap",
  "overclaim",
];
const CALIBRATION_CORRECTION_CATEGORY_NAMES: ReadonlySet<string> = new Set(
  CALIBRATION_CORRECTION_CATEGORIES,
);

// Calendar-action arg bounds — ported from action-route.ts (private there);
// the exported calendar-actions.ts ceilings back the numbers.
const TIME_PATTERN = /^[0-9]{1,2}(:[0-5][0-9])?\s*(am|pm)?$/i;
const CAP_TIME_CHARS = 8;
const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const CALENDAR_DURATION_MIN_MINUTES = CALENDAR_DURATION_MIN_MS / 60_000;
const CALENDAR_DURATION_MAX_MINUTES = CALENDAR_DURATION_MAX_MS / 60_000;

function coerceWallClockString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > CAP_TIME_CHARS) return null;
  if (!TIME_PATTERN.test(value)) return null;
  return value;
}

function coerceCalendarAttendees(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    if (entry.length > CALENDAR_ATTENDEE_MAX_CHARS) return null;
    if (!EMAIL_PATTERN.test(entry)) return null;
    const lower = entry.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      list.push(lower);
    }
  }
  if (list.length > CALENDAR_ATTENDEES_MAX) return null;
  return list;
}

function coerceTaskItem(value: unknown): OperationTaskItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  // due is OPTIONAL — an omitted due means "no deadline" (same as null).
  if (!exactKeys(item, ["title", "due"]) && !exactKeys(item, ["title"])) return null;
  const title = coerceBoundedText(item.title, TASK_TITLE_MAX_CHARS);
  if (title === null) return null;
  if (item.due === null || item.due === undefined) return { title, due: null };
  if (typeof item.due !== "string") return null;
  const due = sanitizeText(item.due);
  if (due.length === 0 || due.length > TASK_DUE_MAX_CHARS || due.includes("\n")) return null;
  return { title, due };
}

/**
 * Strict single-operation validator (the envelope's per-op parser; also the
 * re-validation seam for parked payloads). Fail-closed: any structural
 * deviation — unknown type, unknown/missing keys, out-of-bounds values,
 * multi-change profile combos — returns null. NO vocabulary scan runs
 * anywhere in this function (owner correction 2).
 */
export function parseCognitiveOperation(value: unknown): CognitiveOperation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string" || !OPERATION_TYPE_NAMES.has(obj.type)) return null;

  if (obj.type === "profile_update") {
    if (!exactKeys(obj, ["type", ...PROFILE_CHANGE_KEYS])) return null;
    const present = PROFILE_CHANGE_KEYS.filter((key) => obj[key] !== undefined);
    if (present.length !== 1) return null; // exactly ONE change; set+remove combos reject
    const key = present[0]!;
    if (key === "addressOwnerName") {
      const term = coerceProfileOwnerName(obj.addressOwnerName);
      return term === null ? null : { type: "profile_update", addressOwnerName: term };
    }
    if (key === "removeAddress") {
      return obj.removeAddress === true ? { type: "profile_update", removeAddress: true } : null;
    }
    if (key === "toneNote") {
      const note = coerceBoundedText(obj.toneNote, PROFILE_TONE_NOTE_MAX_CHARS);
      return note === null ? null : { type: "profile_update", toneNote: note };
    }
    if (key === "brevityMaxSentences") {
      const max = coerceIntInRange(obj.brevityMaxSentences, 1, PROFILE_BREVITY_MAX_SENTENCES_CEILING);
      return max === null ? null : { type: "profile_update", brevityMaxSentences: max };
    }
    const directive = coerceBoundedText(obj.extraDirective, PROFILE_TONE_NOTE_MAX_CHARS);
    return directive === null ? null : { type: "profile_update", extraDirective: directive };
  }

  if (obj.type === "task_batch") {
    if (!exactKeys(obj, ["type", "items"])) return null;
    if (!Array.isArray(obj.items)) return null;
    if (obj.items.length < 1 || obj.items.length > TASK_BATCH_MAX_ITEMS) return null;
    const items: OperationTaskItem[] = [];
    for (const raw of obj.items) {
      const item = coerceTaskItem(raw);
      if (item === null) return null;
      items.push(item);
    }
    return { type: "task_batch", items };
  }

  if (obj.type === "reminder_create") {
    if (!exactKeys(obj, ["type", "title", "dueDate", "dueTime", "whenWords"])) return null;
    if (obj.dueDate === undefined || obj.dueTime === undefined || obj.whenWords === undefined) return null;
    const title = coerceBoundedText(obj.title, REMINDER_TITLE_MAX_CHARS);
    if (title === null) return null;
    const dueDate = obj.dueDate === null ? null : coerceCivilDate(obj.dueDate);
    if (obj.dueDate !== null && dueDate === null) return null;
    const dueTime = obj.dueTime === null ? null : coerceDueTime(obj.dueTime);
    if (obj.dueTime !== null && dueTime === null) return null;
    const whenWords =
      obj.whenWords === null ? null : coerceBoundedText(obj.whenWords, REMINDER_WHEN_MAX_CHARS);
    if (obj.whenWords !== null && whenWords === null) return null;
    return { type: "reminder_create", title, dueDate, dueTime, whenWords };
  }

  if (obj.type === "reminder_reply") {
    if (!exactKeys(obj, ["type", "reminderId", "kind", "whenText"])) return null;
    if (typeof obj.reminderId !== "string" || !UUID_RE.test(obj.reminderId)) return null;
    if (typeof obj.kind !== "string" || !REMINDER_REPLY_KINDS.has(obj.kind)) return null;
    const whenText =
      obj.whenText === null || obj.whenText === undefined
        ? null
        : coerceBoundedText(obj.whenText, REMINDER_WHEN_MAX_CHARS);
    if (whenText === null && obj.whenText !== null && obj.whenText !== undefined) return null;
    return { type: "reminder_reply", reminderId: obj.reminderId, kind: obj.kind as ReminderReplyKind, whenText };
  }

  if (obj.type === "commitment_transition") {
    if (!exactKeys(obj, ["type", "commitmentId", "verb", "note"])) return null;
    if (typeof obj.commitmentId !== "string" || !UUID_RE.test(obj.commitmentId)) return null;
    if (typeof obj.verb !== "string" || !COMMITMENT_VERBS.has(obj.verb)) return null;
    const note =
      obj.note === null || obj.note === undefined
        ? null
        : coerceBoundedText(obj.note, REMINDER_NOTE_MAX_CHARS);
    if (note === null && obj.note !== null && obj.note !== undefined) return null;
    return {
      type: "commitment_transition",
      commitmentId: obj.commitmentId,
      verb: obj.verb as CommitmentTransitionVerb,
      note,
    };
  }

  if (obj.type === "occurrence_update") {
    if (!exactKeys(obj, ["type", "calendarEventId", "happened"])) return null;
    if (typeof obj.calendarEventId !== "string" || !UUID_RE.test(obj.calendarEventId)) return null;
    if (typeof obj.happened !== "boolean") return null;
    return { type: "occurrence_update", calendarEventId: obj.calendarEventId, happened: obj.happened };
  }

  if (obj.type === "calibration_feedback") {
    if (typeof obj.kind !== "string" || !CALIBRATION_FEEDBACK_KINDS.has(obj.kind)) return null;
    if (obj.kind === "rating") {
      if (!exactKeys(obj, ["type", "kind", "rating"])) return null;
      const rating = coerceIntInRange(obj.rating, 1, 5);
      if (rating === null) return null;
      return { type: "calibration_feedback", kind: "rating", rating };
    }
    if (obj.kind === "miss") {
      if (!exactKeys(obj, ["type", "kind"])) return null;
      return { type: "calibration_feedback", kind: "miss" };
    }
    if (!exactKeys(obj, ["type", "kind", "category"])) return null;
    if (typeof obj.category !== "string" || !CALIBRATION_CORRECTION_CATEGORY_NAMES.has(obj.category)) {
      return null;
    }
    return {
      type: "calibration_feedback",
      kind: "correction",
      category: obj.category as CalibrationCorrectionCategory,
    };
  }

  if (obj.type === "system_feedback") {
    if (!exactKeys(obj, ["type", "category", "subject", "detail"])) return null;
    if (typeof obj.category !== "string" || !SYSTEM_FEEDBACK_CATEGORIES.has(obj.category)) return null;
    if (obj.detail === undefined) return null;
    const subject = coerceBoundedText(obj.subject, FEEDBACK_SUBJECT_MAX_CHARS);
    if (subject === null) return null;
    const detail =
      obj.detail === null ? null : coerceBoundedText(obj.detail, FEEDBACK_DETAIL_MAX_CHARS);
    if (obj.detail !== null && detail === null) return null;
    return { type: "system_feedback", category: obj.category as SystemFeedbackCategory, subject, detail };
  }

  if (obj.type === "memory_candidate") {
    if (!exactKeys(obj, ["type", "summary"])) return null;
    const summary = coerceBoundedText(obj.summary, MEMORY_SUMMARY_MAX_CHARS);
    if (summary === null) return null;
    return { type: "memory_candidate", summary };
  }

  if (obj.type === "calendar_action") {
    if (
      !exactKeys(obj, [
        "type",
        "title",
        "day",
        "time",
        "endTime",
        "durationMinutes",
        "location",
        "description",
        "attendees",
      ])
    ) {
      return null;
    }
    for (const key of [
      "title",
      "day",
      "time",
      "endTime",
      "durationMinutes",
      "location",
      "description",
      "attendees",
    ]) {
      if (obj[key] === undefined) return null;
    }
    const title = coerceBoundedText(obj.title, CALENDAR_TITLE_MAX_CHARS);
    if (title === null) return null;
    if (obj.day !== "today" && obj.day !== "tomorrow") return null;
    const time = obj.time === null ? null : coerceWallClockString(obj.time);
    if (obj.time !== null && time === null) return null;
    const endTime = obj.endTime === null ? null : coerceWallClockString(obj.endTime);
    if (obj.endTime !== null && endTime === null) return null;
    let durationMinutes: number | null = null;
    if (obj.durationMinutes !== null) {
      durationMinutes = coerceIntInRange(
        obj.durationMinutes,
        CALENDAR_DURATION_MIN_MINUTES,
        CALENDAR_DURATION_MAX_MINUTES,
      );
      if (durationMinutes === null) return null;
    }
    const location = obj.location === null ? null : coerceBoundedText(obj.location, CALENDAR_LOCATION_MAX_CHARS);
    if (obj.location !== null && location === null) return null;
    const description =
      obj.description === null ? null : coerceBoundedText(obj.description, CALENDAR_DESCRIPTION_MAX_CHARS);
    if (obj.description !== null && description === null) return null;
    const attendees = coerceCalendarAttendees(obj.attendees);
    if (obj.attendees !== null && attendees === null) return null;
    return { type: "calendar_action", title, day: obj.day, time, endTime, durationMinutes, location, description, attendees };
  }

  if (obj.type === "outcome_spec") {
    // coerceOutcomeSpec semantics: directive optional (empty = honest no
    // verbatim ask), criteria 1..5 ×≤200, budget 0..50 (2dp), deadline int 1..30.
    if (
      !exactKeys(obj, ["type", "title", "directive", "criteria", "budget_usd", "deadline_days"]) &&
      !exactKeys(obj, ["type", "title", "criteria", "budget_usd", "deadline_days"])
    ) {
      return null;
    }
    if (obj.budget_usd === undefined || obj.deadline_days === undefined) return null;
    const title = coerceBoundedText(obj.title, OUTCOME_TITLE_MAX_CHARS);
    if (title === null) return null;
    let directive: string | null = null;
    if (obj.directive !== undefined && obj.directive !== null) {
      directive = coerceBoundedText(obj.directive, OUTCOME_DIRECTIVE_MAX_CHARS);
      if (directive === null) return null;
    }
    if (!Array.isArray(obj.criteria)) return null;
    if (obj.criteria.length < 1 || obj.criteria.length > OUTCOME_MAX_CRITERIA) return null;
    const criteria: string[] = [];
    for (const raw of obj.criteria) {
      const criterion = coerceBoundedText(raw, OUTCOME_CRITERION_MAX_CHARS);
      if (criterion === null) return null;
      criteria.push(criterion);
    }
    let budgetUsd: number | null = null;
    if (obj.budget_usd !== null && obj.budget_usd !== undefined) {
      if (typeof obj.budget_usd !== "number" || !Number.isFinite(obj.budget_usd)) return null;
      if (obj.budget_usd < 0 || obj.budget_usd > OUTCOME_MAX_BUDGET_USD) return null;
      budgetUsd = Math.round(obj.budget_usd * 100) / 100;
    }
    let deadlineDays: number | null = null;
    if (obj.deadline_days !== null && obj.deadline_days !== undefined) {
      deadlineDays = coerceIntInRange(obj.deadline_days, 1, OUTCOME_MAX_DEADLINE_DAYS);
      if (deadlineDays === null) return null;
    }
    return {
      type: "outcome_spec",
      title,
      directive: directive ?? "",
      criteria,
      budget_usd: budgetUsd,
      deadline_days: deadlineDays,
    };
  }

  // cross_principal_profile
  if (!exactKeys(obj, ["type", "targetPrincipal", "change"])) return null;
  if (typeof obj.targetPrincipal !== "string") return null;
  const targetPrincipal = redactContent(sanitizeText(obj.targetPrincipal));
  if (targetPrincipal.length === 0 || targetPrincipal.length > 60 || targetPrincipal === "self") {
    return null; // cross-principal by NAME — self preferences ride profile_update
  }
  if (typeof obj.change !== "object" || obj.change === null || Array.isArray(obj.change)) return null;
  const change = obj.change as Record<string, unknown>;
  if (!exactKeys(change, ["ownerName", "toneNote"])) return null;
  const parsedChange: { ownerName?: string; toneNote?: string } = {};
  if (change.ownerName !== undefined) {
    const ownerName = coerceProfileOwnerName(change.ownerName);
    if (ownerName === null) return null;
    parsedChange.ownerName = ownerName;
  }
  if (change.toneNote !== undefined) {
    const toneNote = coerceBoundedText(change.toneNote, PROFILE_TONE_NOTE_MAX_CHARS);
    if (toneNote === null) return null;
    parsedChange.toneNote = toneNote;
  }
  if (Object.keys(parsedChange).length < 1) return null;
  return { type: "cross_principal_profile", targetPrincipal, change: parsedChange };
}

// ---------------------------------------------------------------------------
// Envelope (§22.2) — strict single-line JSON, fail-closed
// ---------------------------------------------------------------------------

export type CognitiveIntent =
  | "question"
  | "directive"
  | "preference"
  | "correction"
  | "feedback"
  | "delegation"
  | "capability"
  | "chat";

export const COGNITIVE_INTENTS: readonly CognitiveIntent[] = [
  "question",
  "directive",
  "preference",
  "correction",
  "feedback",
  "delegation",
  "capability",
  "chat",
];

const COGNITIVE_INTENT_NAMES: ReadonlySet<string> = new Set(COGNITIVE_INTENTS);

/** A proposal resolution over a live pending id `<type>:<4-hex>` (§22.2/§22.6). */
export interface CognitiveResolution {
  readonly id: string;
  readonly action: "apply" | "decline";
}

export interface CognitiveEnvelope {
  readonly reads_requested: readonly ReadToolCall[];
  readonly operations_requested: readonly CognitiveOperation[];
  readonly proposal_resolutions: readonly CognitiveResolution[];
  /** EPHEMERAL (≤200 chars) — consumed within the turn, NEVER persisted. */
  readonly interpretation: string;
  /** Structured audit intent (owner correction 5). */
  readonly intent: CognitiveIntent;
  /** Present only under §22.3's finality rule; ≤1500 chars (edge render cap). */
  readonly reply: string | null;
}

/** The read catalog the envelope may name: READ_SET_TOOLS + calendar.day. */
export const COGNITIVE_READ_CATALOG: readonly string[] = ["calendar.day", ...READ_SET_TOOLS];

export const OPERATIONS_MAX_PER_TURN = 4; // §22.2 (PROPOSALS_MAX_PER_TURN parity)
export const RESOLUTIONS_MAX_PER_TURN = 2; // §22.2
export const ENVELOPE_INTERPRETATION_MAX_CHARS = 200; // §22.2
export const ENVELOPE_REPLY_MAX_CHARS = 1500; // §22.2 (edge render cap)

const ENVELOPE_KEYS: readonly string[] = [
  "reads_requested",
  "operations_requested",
  "proposal_resolutions",
  "interpretation",
  "intent",
  "reply",
];
const ENVELOPE_REQUIRED_KEYS: readonly string[] = [
  "reads_requested",
  "operations_requested",
  "proposal_resolutions",
  "interpretation",
  "intent",
];

export const PENDING_PROPOSAL_ID_RE = /^[a-z_]+:[0-9a-f]{4}$/;

/**
 * Deterministic pending id `<type>:<4-hex>` — the §22.14 read-time
 * derivation (hash of type + at) computed at park time, so both derive
 * the SAME id (per-type slots make type+at unique).
 */
export function pendingProposalId(type: ThreadPendingProposalType | CognitiveOperationType, atIso: string): string {
  const hex = createHash("sha256").update(`${type}:${atIso}`, "utf8").digest("hex").slice(0, 4);
  return `${type}:${hex}`;
}

/**
 * STRICT parse of the cognitive envelope (§22.2). Fail-closed on ANY
 * deviation: prose, markdown fences, multi-line JSON, arrays, unknown
 * top-level keys, missing required keys, over-bound arrays/strings,
 * unknown tools, per-tool arg violations, unknown op types, malformed
 * ops, unknown resolution actions, or malformed pending ids — all null.
 * There is NO vocabulary scan of any text field (owner correction 2).
 */
export function parseCognitiveEnvelope(text: string): CognitiveEnvelope | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  if (trimmed.includes("\n")) return null; // single line — fences/prose reject
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!exactKeys(obj, ENVELOPE_KEYS)) return null;
  for (const key of ENVELOPE_REQUIRED_KEYS) {
    if (obj[key] === undefined) return null;
  }

  // reads: catalog membership + per-tool args via the EXISTING strict
  // route parser (parseRouteJson owns the allowlist — no duplicate list).
  if (!Array.isArray(obj.reads_requested)) return null;
  if (obj.reads_requested.length > READ_SET_MAX_TOOLS) return null;
  const reads: ReadToolCall[] = [];
  const seenTools = new Set<string>();
  for (const entry of obj.reads_requested) {
    let serialized: string;
    try {
      serialized = JSON.stringify(entry);
    } catch {
      return null;
    }
    const call = parseRouteJson(serialized);
    if (call === null) return null;
    if (seenTools.has(call.tool)) return null;
    seenTools.add(call.tool);
    reads.push(call);
  }

  // operations: ≤4, at most one per type (per-type pending slots, §22.6).
  if (!Array.isArray(obj.operations_requested)) return null;
  if (obj.operations_requested.length > OPERATIONS_MAX_PER_TURN) return null;
  const operations: CognitiveOperation[] = [];
  const seenTypes = new Set<string>();
  for (const entry of obj.operations_requested) {
    const operation = parseCognitiveOperation(entry);
    if (operation === null) return null;
    if (seenTypes.has(operation.type)) return null;
    seenTypes.add(operation.type);
    operations.push(operation);
  }

  // resolutions: exact shape, live-id format, ≤2, unique ids.
  if (!Array.isArray(obj.proposal_resolutions)) return null;
  if (obj.proposal_resolutions.length > RESOLUTIONS_MAX_PER_TURN) return null;
  const resolutions: CognitiveResolution[] = [];
  const seenIds = new Set<string>();
  for (const entry of obj.proposal_resolutions) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const resolution = entry as Record<string, unknown>;
    if (!exactKeys(resolution, ["id", "action"])) return null;
    if (typeof resolution.id !== "string" || !PENDING_PROPOSAL_ID_RE.test(resolution.id)) return null;
    const typePart = resolution.id.slice(0, resolution.id.lastIndexOf(":"));
    if (!OPERATION_TYPE_NAMES.has(typePart)) return null;
    if (resolution.action !== "apply" && resolution.action !== "decline") return null;
    if (seenIds.has(resolution.id)) return null;
    seenIds.add(resolution.id);
    resolutions.push({ id: resolution.id, action: resolution.action });
  }

  // interpretation: bounded, one line, EPHEMERAL (callers never persist it).
  if (typeof obj.interpretation !== "string") return null;
  const interpretation = sanitizeText(obj.interpretation);
  if (interpretation.length === 0 || interpretation.length > ENVELOPE_INTERPRETATION_MAX_CHARS) {
    return null;
  }

  // intent: structured enum (the durable audit field).
  if (typeof obj.intent !== "string" || !COGNITIVE_INTENT_NAMES.has(obj.intent)) return null;

  // reply: optional (§22.3 finality); bounded by the edge render cap.
  // Newlines are legal here (JSON-escaped in the envelope; the edge
  // renders multi-line replies) — only length + redaction apply. Explicit
  // JSON null is accepted and means "omitted" (models habitually emit it).
  let reply: string | null = null;
  if (obj.reply !== undefined && obj.reply !== null) {
    if (typeof obj.reply !== "string") return null;
    reply = redactContent(obj.reply.trim());
    if (reply.length === 0 || reply.length > ENVELOPE_REPLY_MAX_CHARS) return null;
  }

  return {
    reads_requested: reads,
    operations_requested: operations,
    proposal_resolutions: resolutions,
    interpretation,
    intent: obj.intent as CognitiveIntent,
    reply,
  };
}

// ---------------------------------------------------------------------------
// Consent-class bar (§22.6)
// ---------------------------------------------------------------------------

/**
 * The pending types a `proposal_resolutions{action:"apply"}` may resolve.
 * Everything EXCEPT the consequential three — outcome_spec, calendar,
 * cross-principal — which apply exclusively through their §22.10.3/4
 * token lanes. A structural type-set check, not a heuristic.
 */
export const CONSENT_CLASS_BAR: ReadonlySet<CognitiveOperationType> = new Set(
  COGNITIVE_OPERATION_TYPES.filter(
    (type) => type !== "outcome_spec" && type !== "calendar_action" && type !== "cross_principal_profile",
  ),
);

/** True when `pendingType` may be `apply`-resolved from an envelope. */
export function resolutionAllowed(pendingType: CognitiveOperationType | string): boolean {
  return (CONSENT_CLASS_BAR as ReadonlySet<string>).has(pendingType);
}

// ---------------------------------------------------------------------------
// Executor surface (§22.3/§22.4) — thin delegation to the surviving bridges
// ---------------------------------------------------------------------------

export type OperationResultStatus = "applied" | "parked" | "queued" | "failed" | "rejected";

/** §22.3's execution record: a terminal outcome for the ledger/cognition. */
export interface OperationResult {
  readonly status: OperationResultStatus;
  readonly id?: string;
  readonly detail?: string;
}

export interface OperationContext {
  /** The authenticated principal emitting the op (round 0 = their turn). */
  readonly principalId: string;
  /** Display name (feedback/reminder/profile staging conventions). */
  readonly principalName: string;
  /** The active interaction thread (parks need it; null = honest fail). */
  readonly threadId: string | null;
  readonly now: Date;
  /** Capture policy for memory_candidate (defaults to the repo default). */
  readonly capturePolicy?: CapturePolicy | null;
  /** Calendar-action policy (defaults to DEFAULT_CALENDAR_ACTION_POLICY). */
  readonly calendarPolicy?: CalendarActionPolicy | null;
}

/** Structural DB slice (pg.Pool / @jehad/db subset — the bridges' union). */
export type OperationsDb = TurnInterpretationDb;

/** Audit actor for operations executed here (convention: system:<domain>). */
export const COGNITIVE_OPERATIONS_ACTOR = "system:cognitive-operations";

const OPERATION_PROFILE_SURFACE = "imessage";
const OPERATION_DETAIL_MAX_CHARS = 200;

function auditOperation(
  db: SqlExecutor,
  action: string,
  outputs: Record<string, unknown>,
): Promise<void> {
  return recordAudit(db, {
    actor: COGNITIVE_OPERATIONS_ACTOR,
    action,
    reversible: true,
    outputsRef: JSON.stringify(outputs),
  });
}

function failureDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : "operation failed";
  return message.slice(0, OPERATION_DETAIL_MAX_CHARS);
}

// Mirrors conversation.ts's private nextCivilDay (PT civil tomorrow).
function nextCivilDay(now: Date): string {
  const pt = new Intl.DateTimeFormat("en-CA", {
    timeZone: REMINDER_POLICY.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const rolled = new Date(`${pt}T12:00:00Z`);
  rolled.setUTCDate(rolled.getUTCDate() + 1);
  return rolled.toISOString().slice(0, 10);
}

// Mirrors conversation.ts's private rollForwardPastTime (never past-due).
function rollForwardPastTime(
  dueDate: string,
  dueTime: ReminderCreateTime | null,
  now: Date,
): { dueDate: string; dueTime: ReminderCreateTime | null } {
  if (dueTime === null) return { dueDate, dueTime };
  const first = computeFirstTouch({ dueDate, dueTime, now });
  if (first.at.getTime() > now.getTime()) return { dueDate, dueTime };
  return { dueDate: nextCivilDay(now), dueTime };
}

/**
 * Park a pending proposal into the thread's per-type slots (§22.3:
 * parking IS execution). Siblings persist; a same-type re-park replaces
 * the slot (side-effect idempotent). The stored `offered` line is a
 * deterministic bounded placeholder — under §22 the MODEL authors the
 * offer in its own words next round; this field is legacy pending-slot
 * metadata, kept shape-valid for the shared parser.
 */
async function parkPendingProposal(
  db: OperationsDb,
  ctx: OperationContext,
  type: ThreadPendingProposalType,
  payload: unknown,
  offered: string,
): Promise<OperationResult> {
  if (ctx.threadId === null) {
    return { status: "failed", detail: "no-active-thread" };
  }
  const row = await db.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
    ctx.threadId,
  ]);
  const metadata = parseThreadMetadata(row.rows[0]?.metadata ?? null);
  const existing =
    metadata?.pendingProposals !== undefined
      ? [...metadata.pendingProposals]
      : metadata?.pendingProposal !== undefined
        ? [metadata.pendingProposal]
        : [];
  const at = ctx.now.toISOString();
  const entry: ThreadPendingProposal = { type, at, payload, offered };
  const merged = [...existing.filter((pending) => pending.type !== type), entry];
  await setThreadPendingProposals(db, {
    threadId: ctx.threadId,
    principalId: ctx.principalId,
    pending: merged,
  });
  const id = pendingProposalId(type, at);
  await auditOperation(db, `operation.${type}.parked`, {
    principalId: ctx.principalId,
    pendingId: id,
    threadId: ctx.threadId,
    at,
  });
  return { status: "parked", id };
}

// ------------------------------------------------------------- profile_update

/**
 * §22.4 low-risk self-preference — the incident-B fix. Seed-if-needed +
 * applyDefinitionDelta + nextProfileVersion(via:'self'), the exact
 * applyConfigurationDirective conventions. The op's change keys map 1:1
 * onto applyDefinitionDelta's fields; brevityMaxSentences is a TARGET, so
 * the additive delta is computed against the active definition once.
 */
async function executeProfileUpdate(
  db: OperationsDb,
  op: ProfileUpdateOperation,
  ctx: OperationContext,
): Promise<OperationResult> {
  let base = await activeProfile(db, { principalId: ctx.principalId, surface: OPERATION_PROFILE_SURFACE });
  if (base === null) {
    await seedProfile(db, {
      principalId: ctx.principalId,
      surface: OPERATION_PROFILE_SURFACE,
      definition: JOSCTL_PROFILE_DEFINITION,
    });
    base = { definition: JOSCTL_PROFILE_DEFINITION, version: 1 };
  }
  let delta: ProfileDefinitionDelta;
  let changeKey: string;
  if ("addressOwnerName" in op) {
    delta = { addressOwnerName: op.addressOwnerName };
    changeKey = "addressOwnerName";
  } else if ("removeAddress" in op) {
    delta = { removeAddress: true };
    changeKey = "removeAddress";
  } else if ("toneNote" in op) {
    delta = { extraDirective: `Voice note: ${op.toneNote}` };
    changeKey = "toneNote";
  } else if ("brevityMaxSentences" in op) {
    delta = {
      brevityDelta: { maxSentences: op.brevityMaxSentences - base.definition.brevity.maxSentences },
    };
    changeKey = "brevityMaxSentences";
  } else {
    delta = { extraDirective: op.extraDirective };
    changeKey = "extraDirective";
  }
  const definition = applyDefinitionDelta(base.definition, delta);
  const version = await nextProfileVersion(db, {
    principalId: ctx.principalId,
    surface: OPERATION_PROFILE_SURFACE,
    definition,
    via: "self",
  });
  await auditOperation(db, "operation.profile_update.applied", {
    principalId: ctx.principalId,
    version,
    change: changeKey,
    at: ctx.now.toISOString(),
  });
  return { status: "applied", id: `profile:v${version}`, detail: `profile version ${version}` };
}

// ------------------------------------------------------------ reminder_create

/** The "remind me to X" conventions (conversation.ts:1568-1642), ported
 *  onto the op shape: honest reject for unresolvable when-words, the
 *  task-batch bridge writes the commitment, createReminder arms the
 *  promise, past times roll forward, no-when defaults to tomorrow. */
async function executeReminderCreate(
  db: OperationsDb,
  op: ReminderCreateOperation,
  ctx: OperationContext,
): Promise<OperationResult> {
  const when = op.whenWords !== null ? resolveWhenWords(op.whenWords, ctx.now) : null;
  if (op.whenWords !== null && when === null) {
    return { status: "failed", detail: `unsupported-when: ${op.whenWords}` };
  }
  const askedDueDate = op.dueDate ?? when?.dueDate ?? nextCivilDay(ctx.now);
  const target = rollForwardPastTime(askedDueDate, op.dueTime ?? when?.dueTime ?? null, ctx.now);
  const firstTouch = computeFirstTouch({ dueDate: target.dueDate, dueTime: target.dueTime, now: ctx.now });
  const safeFirstTouch =
    firstTouch.at.getTime() <= ctx.now.getTime()
      ? computeFirstTouch({ dueDate: nextCivilDay(ctx.now), dueTime: target.dueTime, now: ctx.now })
      : firstTouch;
  const applied = await applyTaskBatch(db, {
    proposal: { type: "task_batch", items: [{ title: op.title, due: op.whenWords }] },
    principalId: ctx.principalId,
    now: ctx.now,
  });
  if (!applied.applied) {
    return { status: "failed", detail: applied.reason ?? "task-write-failed" };
  }
  const reminder = await createReminder(db, {
    principal: ctx.principalName,
    title: op.title,
    commitmentId: applied.commitmentIds[0] ?? null,
    dueDate: target.dueDate,
    dueTime: target.dueTime,
    firstTouchAt: safeFirstTouch.at,
    firstTouchKind: safeFirstTouch.kind,
    ...(ctx.threadId !== null ? { threadId: ctx.threadId } : {}),
  });
  return { status: "applied", id: reminder.id, detail: `due ${target.dueDate}` };
}

// -------------------------------------------------------------- reminder_reply

/** The probe-reply resolution path (conversation.ts:1485-1541) onto the op
 *  shape: done/stop/renegotiate mutate through the reminder queries +
 *  commitment transitions; not_done is an honest defer (no write). */
async function executeReminderReply(
  db: OperationsDb,
  op: ReminderReplyOperation,
  ctx: OperationContext,
): Promise<OperationResult> {
  const row = await getReminder(db, op.reminderId);
  if (row === null) {
    return { status: "failed", detail: "unknown-reminder" };
  }
  if (row.status !== "armed") {
    return { status: "failed", detail: `reminder-${row.status}` };
  }
  if (row.principal !== ctx.principalName) {
    return { status: "rejected", detail: "not-reminder-owner" };
  }
  if (op.kind === "done") {
    await completeReminder(db, row.id, "user_reply");
    if (row.commitmentId !== null) {
      await applyCommitmentTransition(db, {
        commitmentId: row.commitmentId,
        verb: "done",
        principalId: ctx.principalId,
        now: () => ctx.now,
      });
    }
  } else if (op.kind === "stop") {
    await cancelReminder(db, row.id, "user");
  } else if (op.kind === "renegotiate") {
    const when = op.whenText !== null ? resolveWhenWords(op.whenText, ctx.now) : null;
    if (when !== null) {
      const target = rollForwardPastTime(when.dueDate, when.dueTime, ctx.now);
      const first = computeFirstTouch({ dueDate: target.dueDate, dueTime: target.dueTime, now: ctx.now });
      await renegotiateReminder(db, row.id, {
        dueDate: target.dueDate,
        dueTime: target.dueTime,
        firstTouchAt: first.at,
        firstTouchKind: first.kind,
      });
      if (row.commitmentId !== null) {
        await applyCommitmentTransition(db, {
          commitmentId: row.commitmentId,
          verb: "renegotiated",
          note: `moved to ${target.dueDate}`,
          principalId: ctx.principalId,
          now: () => ctx.now,
        });
      }
    }
    // whenText null/unresolvable → honest defer, like the probe path.
  }
  // not_done (and unresolvable renegotiate) intentionally write nothing.
  await auditOperation(db, "operation.reminder_reply.applied", {
    principalId: ctx.principalId,
    reminderId: row.id,
    kind: op.kind,
    at: ctx.now.toISOString(),
  });
  return { status: "applied", id: row.id, detail: op.kind };
}

// ------------------------------------------------------ calibration_feedback

/**
 * Ratings store on the sole eligible open item (the §22.10 "4"-rating
 * case); misses/corrections store through storeMissedFeedback. The
 * feedback note is a FIXED marker, never user content — `interpretation`
 * is ephemeral and free text never rides the durable row.
 */
const CALIBRATION_MISS_NOTE = "calibration miss recorded from conversation";

async function executeCalibrationFeedback(
  db: OperationsDb,
  op: CalibrationFeedbackOperation,
  ctx: OperationContext,
): Promise<OperationResult> {
  const eligible = await eligibleCalibrationItem(db, { principalId: ctx.principalId, now: ctx.now });
  if (op.kind === "rating") {
    if (eligible.kind !== "sole") {
      return { status: "failed", detail: eligible.kind === "none" ? "no-open-item" : "ambiguous-open-items" };
    }
    await storeCalibrationRating(db, {
      principalId: ctx.principalId,
      itemId: eligible.item.id,
      rating: op.rating,
      surface: OPERATION_PROFILE_SURFACE,
      now: () => ctx.now,
    });
    return { status: "applied", id: eligible.item.id, detail: `rating ${op.rating}` };
  }
  const note =
    op.kind === "correction" ? `calibration correction (${op.category}) recorded from conversation` : CALIBRATION_MISS_NOTE;
  const stored = await storeMissedFeedback(db, {
    principalId: ctx.principalId,
    itemId: eligible.kind === "sole" ? eligible.item.id : null,
    text: note,
    ...(op.kind === "correction" ? { category: op.category } : {}),
    surface: OPERATION_PROFILE_SURFACE,
    now: () => ctx.now,
  });
  return { status: "applied", id: stored.feedbackId, detail: stored.category };
}

// ---------------------------------------------------------- calendar_action

/** §22.4 consequential: park via the EXISTING propose lane — the
 *  confirm token is issued and returned to cognition as data (the MODEL
 *  authors the ask, quoting the token verbatim). */
async function executeCalendarAction(
  db: OperationsDb,
  op: CalendarActionOperation,
  ctx: OperationContext,
): Promise<OperationResult> {
  const resolved = resolveProposedSchedule(
    { day: op.day, time: op.time, endTime: op.endTime, durationMinutes: op.durationMinutes },
    ctx.now,
  );
  if (!resolved.ok) {
    return { status: "failed", detail: `schedule-${resolved.reason}` };
  }
  const proposed = await proposeCalendarAction(db, {
    principalId: ctx.principalId,
    principalName: ctx.principalName,
    title: op.title,
    startIso: resolved.startIso,
    endIso: resolved.endIso,
    location: op.location,
    description: op.description,
    attendees: op.attendees,
    threadId: ctx.threadId,
    now: ctx.now,
    policy: ctx.calendarPolicy ?? undefined,
  });
  if (proposed.status === "proposed") {
    return { status: "parked", id: proposed.intentId, detail: `confirm ${proposed.confirmToken}` };
  }
  return { status: "rejected", detail: proposed.status };
}

// ----------------------------------------------------- cross_principal_profile

/** Owner-gated staging via the EXISTING applyConfigurationDirective bridge
 *  (W6 security: only the owner principal may stage another principal's
 *  profile; activation honestly requires the policy allowlist). toneNote
 *  maps onto the bridge's `tone` key (its Voice-note convention). */
async function executeCrossPrincipalProfile(
  db: OperationsDb,
  op: CrossPrincipalProfileOperation,
  ctx: OperationContext,
): Promise<OperationResult> {
  const change: Record<string, string> = {};
  if (op.change.ownerName !== undefined) change.ownerName = op.change.ownerName;
  if (op.change.toneNote !== undefined) change.tone = op.change.toneNote;
  const result = await applyConfigurationDirective(db, {
    proposal: {
      type: "configuration_directive",
      target_principal: op.targetPrincipal,
      target: "interaction_profile",
      change,
    },
    principalId: ctx.principalId,
    actorPrincipalName: ctx.principalName,
    now: ctx.now,
  });
  if (!result.applied) {
    return result.reason === "not-owner"
      ? { status: "rejected", detail: "not-owner" }
      : { status: "failed", detail: result.reason ?? "staging-failed" };
  }
  return {
    status: "queued",
    ...(result.version !== null ? { id: `profile:v${result.version}` } : {}),
    detail: "staged; activation requires the personas policy allowlist",
  };
}

// ------------------------------------------------------------------ dispatch

/**
 * Execute one cognitive operation through the surviving bridges (§22.3:
 * every op class is results_needed — this result returns to cognition as
 * typed data). Parking IS execution. Side-effect-idempotent where the
 * underlying seam allows (parks replace per-type slots; memory candidates
 * are deterministic-id deduped; occurrence/commitment replays land as
 * honest no-ops); the append-only writers (feedback rows, profile
 * versions, reminders) keep their existing single-shot semantics —
 * single-execution is the loop's round-0 contract. Failures return as
 * data ({status:"failed"}), never throw.
 */
export async function executeOperation(
  db: OperationsDb,
  op: CognitiveOperation,
  ctx: OperationContext,
): Promise<OperationResult> {
  if (!UUID_RE.test(ctx.principalId)) {
    return { status: "failed", detail: "invalid-principal-id" };
  }
  try {
    switch (op.type) {
      case "profile_update":
        return await executeProfileUpdate(db, op, ctx);
      case "task_batch": {
        // §22.4: multi-item batches PARK as a pending proposal; cognition
        // asks for the yes in its own words; a later resolution (or the
        // legacy confirm lane) applies via applyTaskBatch. `due` is stored
        // omitted-when-null for headroom under the pending-payload cap.
        const payload = {
          type: "task_batch" as const,
          items: op.items.map((item) =>
            item.due === null ? { title: item.title } : { title: item.title, due: item.due },
          ),
        };
        return await parkPendingProposal(
          db,
          ctx,
          "task_batch",
          payload,
          `task_batch (${op.items.length} items)`,
        );
      }
      case "reminder_create":
        return await executeReminderCreate(db, op, ctx);
      case "reminder_reply":
        return await executeReminderReply(db, op, ctx);
      case "commitment_transition": {
        const result = await applyCommitmentTransition(db, {
          commitmentId: op.commitmentId,
          verb: op.verb,
          note: op.note ?? undefined,
          principalId: ctx.principalId,
          now: () => ctx.now,
        });
        if (!result.applied) {
          if (result.reason === "not_found") {
            return { status: "failed", detail: "unknown-commitment" };
          }
          // not_open: already resolved — no new side effect (idempotent replay).
          return { status: "applied", id: op.commitmentId, detail: "already-resolved" };
        }
        return { status: "applied", id: op.commitmentId, detail: result.toStatus };
      }
      case "occurrence_update": {
        try {
          const confirmed = await confirmOccurrence(db, {
            calendarEventId: op.calendarEventId,
            happened: op.happened,
            principalId: ctx.principalId,
            now: ctx.now,
          });
          return { status: "applied", id: op.calendarEventId, detail: confirmed.occurrence };
        } catch (err) {
          if (err instanceof CalendarEventNotFoundError) {
            return { status: "failed", detail: "unknown-calendar-event" };
          }
          if (err instanceof OccurrenceAlreadyGraduatedError) {
            return { status: "failed", detail: "already-graduated" };
          }
          throw err;
        }
      }
      case "calibration_feedback":
        return await executeCalibrationFeedback(db, op, ctx);
      case "system_feedback": {
        const result = await applySystemFeedback(db, {
          proposal: { type: "system_feedback", category: op.category, subject: op.subject, detail: op.detail },
          principalId: ctx.principalId,
          now: ctx.now,
        });
        if (!result.applied) {
          return { status: "failed", detail: result.reason ?? "feedback-write-failed" };
        }
        return { status: "applied", ...(result.feedbackId !== null ? { id: result.feedbackId } : {}), detail: op.category };
      }
      case "memory_candidate": {
        const result = await applyMemoryCandidate(db, {
          proposal: { type: "memory_candidate", summary: op.summary },
          principalId: ctx.principalId,
          now: ctx.now,
          ...(ctx.capturePolicy !== undefined ? { policy: ctx.capturePolicy } : {}),
        });
        if (!result.applied) {
          if (result.reason === "duplicate") {
            // Deterministic candidate id already in review — idempotent replay.
            return { status: "applied", ...(result.candidateId !== null ? { id: result.candidateId } : {}), detail: "already-in-review" };
          }
          return { status: "rejected", detail: result.reason ?? "capture-refused" };
        }
        return { status: "applied", ...(result.candidateId !== null ? { id: result.candidateId } : {}) };
      }
      case "calendar_action":
        return await executeCalendarAction(db, op, ctx);
      case "outcome_spec": {
        // §22.4 consequential: park in the pending slot; applyOutcomeSpec
        // remains the token-lane applier (outside this module per §22.6).
        const payload = {
          type: "outcome_spec" as const,
          title: op.title,
          directive: op.directive,
          criteria: [...op.criteria],
          budget_usd: op.budget_usd,
          deadline_days: op.deadline_days,
        };
        return await parkPendingProposal(db, ctx, "outcome_spec", payload, `outcome_spec: ${op.title}`);
      }
      case "cross_principal_profile":
        return await executeCrossPrincipalProfile(db, op, ctx);
    }
  } catch (err) {
    return { status: "failed", detail: failureDetail(err) };
  }
}
