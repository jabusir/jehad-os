// SV3 lessons substrate (feedback-and-self-verification.md §SV3, lane
// sv-lessons): storage, lifecycle queries, and deterministic rendering for
// governed LESSONS over the feedback table (migration 022). The nightly
// harvest (packages/workflow lesson-harvest-workflows) PROPOSES; the owner
// RATIFIES or RETIRES through the W4 propose→confirm gate; only ratified
// rows feed the LESSONS block another lane injects into the answer prompt.
// "The system drafts its lessons; it never silently rewrites itself."
//
// Lifecycle: proposed → ratified | retired, guarded on verdict = 'proposed'
// (the reminders armed-guard precedent: touching a non-proposed row throws
// LessonNotProposedError, an unknown id LessonNotFoundError). A re-proposed
// identical subject REFRESHES note/source_refs/updated_at on the existing
// row instead of duplicating — dedupe key (item_type, item_id) =
// ('lesson', subject), enforced by the 022 partial unique index.
//
// Render contract: deterministic, terse, provenance-stamped ("learned" =
// the row's updated_at civil UTC date), char-budgeted (oldest dropped past
// LESSONS_BLOCK_CHAR_BUDGET). Content hygiene mirrors the self-brief rules:
// no model names, no handles, no secret-shaped tokens — enforced at the
// write path (fail loud, like malformed policy.yaml), never mutated at the
// render path.

import { UUID_RE } from "../events/envelope.js";
import { toIso, type QueryExecutor } from "./executor.js";

/** The lesson item world (schema CHECK, migration 022). */
export const LESSON_ITEM_TYPE = "lesson";

/** The propose→confirm gate vocabulary (schema CHECK, migration 022). */
export const LESSON_VERDICTS = ["proposed", "ratified", "retired"] as const;

export type LessonVerdict = (typeof LESSON_VERDICTS)[number];

/** collectRatifiedLessons cap when the caller does not pin one. */
export const LESSONS_DEFAULT_LIMIT = 6;

/** Total rendered-block char budget; oldest ratified lessons drop first. */
export const LESSONS_BLOCK_CHAR_BUDGET = 700;

export const LESSONS_BLOCK_HEADER =
  "LESSONS (earned, not configured — behavior contract from confirmed failures):";

/** feedback.item_id cap (the feedback service's own 280-char itemId rule). */
export const LESSON_SUBJECT_MAX_CHARS = 280;

/** feedback.note cap (the feedback service's own rule). */
export const LESSON_NOTE_MAX_CHARS = 2000;

export interface LessonRow {
  readonly id: string;
  readonly itemType: "lesson";
  /** The subject, verbatim (the dedupe key). */
  readonly itemId: string;
  readonly verdict: LessonVerdict;
  readonly note: string | null;
  readonly createdBy: string;
  /** Provenance: the audit_log ids the lesson was distilled from, or null. */
  readonly sourceRefs: readonly string[] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class LessonInputError extends Error {
  readonly code = "LESSON_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "LessonInputError";
  }
}

export class LessonNotFoundError extends Error {
  readonly code = "LESSON_NOT_FOUND";
  constructor(readonly lessonId: string) {
    super(`lesson ${lessonId} does not exist`);
    this.name = "LessonNotFoundError";
  }
}

export class LessonNotProposedError extends Error {
  readonly code = "LESSON_NOT_PROPOSED";
  constructor(
    readonly lessonId: string,
    readonly verdict: LessonVerdict,
  ) {
    super(
      `lesson ${lessonId} is "${verdict}", not "proposed"; the ratify/retire ` +
        "path only applies to proposed rows",
    );
    this.name = "LessonNotProposedError";
  }
}

const LESSON_COLUMNS = `
  SELECT id, item_type, item_id, verdict, note, created_by, source_refs,
         created_at, updated_at
`;

const RETURNING = `
  RETURNING id, item_type, item_id, verdict, note, created_by, source_refs,
         created_at, updated_at, (xmax = 0) AS created
`;

const PROPOSE_SQL = `
  INSERT INTO feedback (item_type, item_id, verdict, note, source_refs, created_by, created_at, updated_at)
  VALUES ('lesson', $2, 'proposed', $3, $4::jsonb, $1, $5::timestamptz, $5::timestamptz)
  ON CONFLICT (item_type, item_id) WHERE item_type = 'lesson'
  DO UPDATE SET note = EXCLUDED.note,
                source_refs = EXCLUDED.source_refs,
                updated_at = EXCLUDED.updated_at
  ${RETURNING}
`;

const RATIFY_SQL = `
  UPDATE feedback
     SET verdict = $3::text,
         updated_at = $4::timestamptz
   WHERE id = $1::uuid AND item_type = 'lesson' AND verdict = 'proposed'
     AND created_by = $2
  ${RETURNING}
`;

const COLLECT_SQL = `
  ${LESSON_COLUMNS}
  FROM feedback
  WHERE item_type = 'lesson' AND verdict = 'ratified' AND created_by = $1
  ORDER BY updated_at DESC, id ASC
  LIMIT $2
`;

const GET_SQL = `${LESSON_COLUMNS} FROM feedback WHERE id = $1::uuid AND item_type = 'lesson'`;

// Content hygiene (self-brief rules, write-path enforcement): no model
// names, no @handles, no secret-shaped tokens in subject or note.
const FORBIDDEN_CONTENT: readonly RegExp[] = [
  /\b(gpt-\d|gpt-oss|claude[-\w]*|gemini[-\w]*|openai|anthropic|google\/|deepseek[-\w]*|grok[-\w]*|llama[-\w]*|mistral[-\w]*|qwen[-\w]*)/i,
  /(^|[\s("'[])@[A-Za-z0-9_]{2,}/,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\b[A-Za-z0-9+/]{40,}\b/,
];

function rowToLesson(row: Record<string, unknown>): LessonRow {
  let sourceRefs: readonly string[] | null = null;
  if (row.source_refs !== null && row.source_refs !== undefined) {
    const parsed = row.source_refs;
    if (!Array.isArray(parsed)) {
      throw new Error("row has malformed source_refs: expected a jsonb array");
    }
    sourceRefs = parsed.map((ref) => String(ref));
  }
  return {
    id: String(row.id),
    itemType: "lesson",
    itemId: String(row.item_id),
    verdict: String(row.verdict) as LessonVerdict,
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdBy: String(row.created_by),
    sourceRefs,
    createdAt: toIso(row.created_at, "created_at"),
    updatedAt: toIso(row.updated_at, "updated_at"),
  };
}

function validateUuid(value: string, field: string): void {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new LessonInputError(`${field} must be a uuid`);
  }
}

function validatePrincipalId(principalId: string, field: string): void {
  if (typeof principalId !== "string" || !UUID_RE.test(principalId)) {
    throw new LessonInputError(`${field} must be a principals uuid`);
  }
}

function validateSubject(subject: string): void {
  if (typeof subject !== "string" || subject.trim().length === 0) {
    throw new LessonInputError("subject must be a non-empty string");
  }
  if (subject.length > LESSON_SUBJECT_MAX_CHARS) {
    throw new LessonInputError(
      `subject must be at most ${LESSON_SUBJECT_MAX_CHARS} chars, got ${subject.length}`,
    );
  }
  assertCleanContent("subject", subject);
}

function validateNote(note: string): void {
  if (typeof note !== "string" || note.trim().length === 0) {
    throw new LessonInputError("note must be a non-empty string");
  }
  if (note.length > LESSON_NOTE_MAX_CHARS) {
    throw new LessonInputError(
      `note must be at most ${LESSON_NOTE_MAX_CHARS} chars, got ${note.length}`,
    );
  }
  assertCleanContent("note", note);
}

function assertCleanContent(field: string, value: string): void {
  for (const pattern of FORBIDDEN_CONTENT) {
    if (pattern.test(value)) {
      throw new LessonInputError(
        `${field} must stay count/date-shaped evidence (no model names, handles, or secret-shaped tokens)`,
      );
    }
  }
}

function validateSourceAuditIds(sourceAuditIds: readonly string[] | null | undefined): void {
  if (sourceAuditIds === null || sourceAuditIds === undefined) return;
  if (!Array.isArray(sourceAuditIds)) {
    throw new LessonInputError("sourceAuditIds must be an array of audit_log uuids");
  }
  for (const id of sourceAuditIds) {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw new LessonInputError(`sourceAuditIds entries must be audit_log uuids, got ${String(id)}`);
    }
  }
}

function resolveNow(opts: { now?: Date } | undefined): Date {
  const now = opts?.now;
  if (now === undefined) return new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new LessonInputError("now must be a valid Date");
  }
  return now;
}

/**
 * Proposes a lesson (or refreshes an identical subject's existing row —
 * dedupe key (item_type, item_id) = ('lesson', subject); the unique partial
 * index makes the upsert race-safe). The verdict is NEVER changed here: a
 * re-proposed ratified/retired row keeps its gate state.
 */
export async function proposeLesson(
  db: QueryExecutor,
  input: {
    readonly principalId: string;
    readonly subject: string;
    readonly note: string;
    readonly sourceAuditIds?: readonly string[] | null;
  },
  opts: { now?: Date } = {},
): Promise<{ lesson: LessonRow; created: boolean }> {
  validatePrincipalId(input.principalId, "principalId");
  validateSubject(input.subject);
  validateNote(input.note);
  validateSourceAuditIds(input.sourceAuditIds);
  const now = resolveNow(opts);
  const sourceRefs =
    input.sourceAuditIds === undefined || input.sourceAuditIds === null || input.sourceAuditIds.length === 0
      ? null
      : JSON.stringify([...input.sourceAuditIds]);
  const result = await db.query(PROPOSE_SQL, [
    input.principalId,
    input.subject,
    input.note,
    sourceRefs,
    now.toISOString(),
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error("proposeLesson: upsert returned no row");
  const created = Boolean(row.created);
  return { lesson: rowToLesson(row), created };
}

/**
 * The owner's gate: proposed → ratified (installed into the LESSONS block)
 * or → retired. Guarded on verdict = 'proposed' (the armed-guard precedent):
 * an unknown id, another principal's row, or a non-proposed row never
 * transitions — LessonNotFoundError / LessonNotProposedError.
 */
export async function ratifyLesson(
  db: QueryExecutor,
  input: {
    readonly lessonId: string;
    readonly principalId: string;
    readonly ratified: boolean;
  },
  opts: { now?: Date } = {},
): Promise<LessonRow> {
  validateUuid(input.lessonId, "lessonId");
  validatePrincipalId(input.principalId, "principalId");
  if (typeof input.ratified !== "boolean") {
    throw new LessonInputError("ratified must be a boolean");
  }
  const now = resolveNow(opts);
  const verdict = input.ratified ? "ratified" : "retired";
  const result = await db.query(RATIFY_SQL, [
    input.lessonId,
    input.principalId,
    verdict,
    now.toISOString(),
  ]);
  const row = result.rows[0];
  if (row !== undefined) return rowToLesson(row);
  // No-row: unknown id, foreign row, or already-gated — never a silent no-op.
  const existing = await db.query(GET_SQL, [input.lessonId]);
  const current = existing.rows[0];
  if (current === undefined) throw new LessonNotFoundError(input.lessonId);
  if (String(current.created_by) !== input.principalId) {
    // Authorization precedes state: another principal's row "does not exist".
    throw new LessonNotFoundError(input.lessonId);
  }
  throw new LessonNotProposedError(input.lessonId, String(current.verdict) as LessonVerdict);
}

/**
 * The LESSONS-block feed: one principal's ratified lessons, most recently
 * ratified first (updated_at DESC — ratification re-stamps it).
 */
export async function collectRatifiedLessons(
  db: QueryExecutor,
  input: { readonly principalId: string; readonly limit?: number },
): Promise<LessonRow[]> {
  validatePrincipalId(input.principalId, "principalId");
  const limit = input.limit ?? LESSONS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new LessonInputError("limit must be an integer in [1, 100]");
  }
  const result = await db.query(COLLECT_SQL, [input.principalId, limit]);
  return result.rows.map(rowToLesson);
}

/**
 * Deterministic render: header line, then "- <subject> — <note>
 * [learned <YYYY-MM-DD>]" per lesson (learned = updated_at's UTC civil
 * date). Null when there are no lessons. Char-budgeted: the newest lesson
 * always renders (a lone over-budget lesson beats an empty block); older
 * lessons drop whole-line, most-recent-first, once the block would exceed
 * LESSONS_BLOCK_CHAR_BUDGET chars. Pure: derived only from the rows.
 */
export function renderLessonsBlock(lessons: readonly LessonRow[]): string | null {
  if (lessons.length === 0) return null;
  const lines: string[] = [];
  let total = LESSONS_BLOCK_HEADER.length;
  for (const [index, lesson] of lessons.entries()) {
    const line = lessonLine(lesson);
    if (index > 0) {
      if (total + 1 + line.length > LESSONS_BLOCK_CHAR_BUDGET) break;
    }
    lines.push(line);
    total += (index > 0 ? 1 : 0) + line.length;
  }
  return [LESSONS_BLOCK_HEADER, ...lines].join("\n");
}

function lessonLine(lesson: LessonRow): string {
  return `- ${lesson.itemId} — ${lesson.note ?? ""} [learned ${lesson.updatedAt.slice(0, 10)}]`;
}
