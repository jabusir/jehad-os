// Lessons substrate integration tests (SV3 lane, sv-lessons; plan
// feedback-and-self-verification.md §SV3) against an isolated migrated
// database. Covers the data-layer contract: propose + subject dedupe
// (refresh, never duplicate), the propose-guarded ratify/retire transitions
// (LessonNotProposedError / LessonNotFoundError, principal authorization),
// collectRatifiedLessons ordering + default limit + principal scoping, the
// exact renderLessonsBlock strings with the 700-char budget drop, the
// write-path content-hygiene rules, and migration 022 up/down. Needs
// PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsDir, migrateDown, migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  collectRatifiedLessons,
  LESSONS_BLOCK_CHAR_BUDGET,
  LESSONS_BLOCK_HEADER,
  LESSONS_DEFAULT_LIMIT,
  LessonInputError,
  LessonNotFoundError,
  LessonNotProposedError,
  proposeLesson,
  ratifyLesson,
  renderLessonsBlock,
  type LessonRow,
} from "./lessons.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const T0 = new Date("2026-09-22T10:00:00.000Z");
const H = 3_600_000;

// line = "- <subject> — <note> [learned <YYYY-MM-DD>]" → subject+note+26 chars.
const LINE_OVERHEAD = 26;

describe.skipIf(!TEST_DATABASE_URL)("lessons substrate (integration)", () => {
  let db: IsolatedDb;
  const owner = randomUUID();
  const other = randomUUID();

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "svlessons");
    await migrateUp(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    await db.pool.query(`DELETE FROM feedback WHERE item_type = 'lesson'`);
  });

  const propose = (
    subject: string,
    note: string,
    at: Date = T0,
    principalId: string = owner,
  ) => proposeLesson(db.pool, { principalId, subject, note }, { now: at });

  it("proposeLesson creates a proposed row; an identical subject refreshes instead of duplicating", async () => {
    const first = await propose("answers drift on persistence", "2 mismatches on 2026-09-22");
    expect(first.created).toBe(true);
    expect(first.lesson.itemType).toBe("lesson");
    expect(first.lesson.itemId).toBe("answers drift on persistence");
    expect(first.lesson.verdict).toBe("proposed");
    expect(first.lesson.note).toBe("2 mismatches on 2026-09-22");
    expect(first.lesson.createdBy).toBe(owner);
    expect(first.lesson.sourceRefs).toBeNull();
    expect(first.lesson.createdAt).toBe(T0.toISOString());
    expect(first.lesson.updatedAt).toBe(T0.toISOString());

    const auditId = randomUUID();
    const second = await proposeLesson(
      db.pool,
      {
        principalId: owner,
        subject: "answers drift on persistence",
        note: "3 mismatches on 2026-09-22",
        sourceAuditIds: [auditId],
      },
      { now: new Date(T0.getTime() + H) },
    );
    expect(second.created).toBe(false);
    expect(second.lesson.id).toBe(first.lesson.id);
    expect(second.lesson.note).toBe("3 mismatches on 2026-09-22");
    expect(second.lesson.sourceRefs).toEqual([auditId]);
    expect(second.lesson.verdict).toBe("proposed");
    expect(second.lesson.updatedAt).toBe(new Date(T0.getTime() + H).toISOString());

    const rows = await db.pool.query(
      `SELECT count(*)::int AS n FROM feedback WHERE item_type = 'lesson'`,
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("ratify/retire transition only proposed rows (guards: unknown, foreign, non-proposed)", async () => {
    const { lesson } = await propose("never invent reply words", "any affirmative means yes");
    const ratifiedAt = new Date(T0.getTime() + H);
    const ratified = await ratifyLesson(
      db.pool,
      { lessonId: lesson.id, principalId: owner, ratified: true },
      { now: ratifiedAt },
    );
    expect(ratified.verdict).toBe("ratified");
    expect(ratified.updatedAt).toBe(ratifiedAt.toISOString());

    // Non-proposed rows never transition again (the armed-guard precedent).
    await expect(
      ratifyLesson(db.pool, { lessonId: lesson.id, principalId: owner, ratified: false }),
    ).rejects.toThrow(LessonNotProposedError);
    await expect(
      ratifyLesson(db.pool, { lessonId: lesson.id, principalId: owner, ratified: true }),
    ).rejects.toThrow(/is "ratified", not "proposed"/);

    const missing = randomUUID();
    await expect(
      ratifyLesson(db.pool, { lessonId: missing, principalId: owner, ratified: true }),
    ).rejects.toThrow(LessonNotFoundError);

    // Another principal's row "does not exist" (authorization precedes state).
    const foreign = await propose("keep replies terse", "owner call-out on 2026-09-21", T0, other);
    await expect(
      ratifyLesson(db.pool, { lessonId: foreign.lesson.id, principalId: owner, ratified: true }),
    ).rejects.toThrow(LessonNotFoundError);

    // The retire path works from proposed.
    const retired = await ratifyLesson(
      db.pool,
      { lessonId: foreign.lesson.id, principalId: other, ratified: false },
      { now: new Date(T0.getTime() + 2 * H) },
    );
    expect(retired.verdict).toBe("retired");
    expect(retired.updatedAt).toBe(new Date(T0.getTime() + 2 * H).toISOString());
  });

  it("collectRatifiedLessons returns the principal's ratified rows, most recently ratified first, default limit 6", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const { lesson } = await propose(
        `subject ${i}`,
        `note ${i}`,
        new Date(T0.getTime() + i * H),
      );
      ids.push(lesson.id);
    }
    // Ratify out of creation order: 1, 3, 0, 2, 4, 5, 6 — collect must be
    // ratification-ordered (newest first), not creation-ordered.
    const ratifyOrder = [1, 3, 0, 2, 4, 5, 6];
    for (const [slot, index] of ratifyOrder.entries()) {
      await ratifyLesson(
        db.pool,
        { lessonId: ids[index]!, principalId: owner, ratified: true },
        { now: new Date(T0.getTime() + 24 * H + slot * H) },
      );
    }
    const collected = await collectRatifiedLessons(db.pool, { principalId: owner });
    expect(collected).toHaveLength(LESSONS_DEFAULT_LIMIT);
    expect(collected.map((l) => l.itemId)).toEqual([
      "subject 6",
      "subject 5",
      "subject 4",
      "subject 2",
      "subject 0",
      "subject 3",
    ]);

    // Proposed/retired rows and other principals never leak in.
    await propose("subject proposed", "note", new Date(T0.getTime() + 40 * H));
    await propose("subject retired", "note", T0, other);
    const retiredRow = await collectRatifiedLessons(db.pool, { principalId: other });
    expect(retiredRow).toEqual([]);
    const limited = await collectRatifiedLessons(db.pool, { principalId: owner, limit: 2 });
    expect(limited.map((l) => l.itemId)).toEqual(["subject 6", "subject 5"]);
  });

  it("input validation rejects bad principals, subjects, notes, and unsafe content", async () => {
    await expect(propose("s", "n", T0, "not-a-uuid")).rejects.toThrow(LessonInputError);
    await expect(propose("   ", "n")).rejects.toThrow(/subject/);
    await expect(propose("s", "   ")).rejects.toThrow(/note/);
    await expect(propose("s", "x".repeat(2001))).rejects.toThrow(/note/);
    await expect(propose("s".repeat(281), "n")).rejects.toThrow(/subject/);
    await expect(propose("always blame the model", "use gpt-4o-mini for everything")).rejects.toThrow(
      /model names/,
    );
    await expect(propose("ping @someone daily", "n")).rejects.toThrow(/secret-shaped|handles/);
    await expect(
      propose("s", "token sk-abcdefghijklmnop1234 leaked"),
    ).rejects.toThrow(/secret-shaped|handles/);
    await expect(
      ratifyLesson(db.pool, { lessonId: "nope", principalId: owner, ratified: true }),
    ).rejects.toThrow(LessonInputError);
  });

  it("renderLessonsBlock renders the exact deterministic block, null when empty", () => {
    expect(renderLessonsBlock([])).toBeNull();
    const lesson = (subject: string, note: string, updatedAt: string): LessonRow => ({
      id: randomUUID(),
      itemType: "lesson",
      itemId: subject,
      verdict: "ratified",
      note,
      createdBy: owner,
      sourceRefs: null,
      createdAt: updatedAt,
      updatedAt,
    });
    const a = lesson(
      "never invent reply words",
      "any affirmative means yes",
      "2026-09-22T18:00:00.000Z",
    );
    const b = lesson(
      "answers drift on persistence",
      "3 mismatches on 2026-09-22",
      "2026-09-21T18:00:00.000Z",
    );
    expect(renderLessonsBlock([a])).toBe(
      `${LESSONS_BLOCK_HEADER}\n` +
        "- never invent reply words — any affirmative means yes [learned 2026-09-22]",
    );
    expect(renderLessonsBlock([a, b])).toBe(
      `${LESSONS_BLOCK_HEADER}\n` +
        "- never invent reply words — any affirmative means yes [learned 2026-09-22]\n" +
        "- answers drift on persistence — 3 mismatches on 2026-09-22 [learned 2026-09-21]",
    );
  });

  it("renderLessonsBlock drops the oldest lessons past the 700-char budget", () => {
    expect(LESSONS_BLOCK_CHAR_BUDGET).toBe(700);
    const lesson = (subject: string, note: string, updatedAt: string): LessonRow => ({
      id: randomUUID(),
      itemType: "lesson",
      itemId: subject,
      verdict: "ratified",
      note,
      createdBy: owner,
      sourceRefs: null,
      createdAt: updatedAt,
      updatedAt,
    });
    // Each line is subject+note+26 chars; newest first (collect order).
    const newest = lesson("alpha", "x".repeat(200), "2026-09-22T10:00:00.000Z");
    const middle = lesson("beta", "y".repeat(200), "2026-09-21T10:00:00.000Z");
    const oldest = lesson("gamma", "z".repeat(200), "2026-09-20T10:00:00.000Z");
    const newestLine = newest.itemId.length + (newest.note?.length ?? 0) + LINE_OVERHEAD;
    const middleLine = middle.itemId.length + (middle.note?.length ?? 0) + LINE_OVERHEAD;
    const oldestLine = oldest.itemId.length + (oldest.note?.length ?? 0) + LINE_OVERHEAD;
    const twoFit = LESSONS_BLOCK_HEADER.length + 1 + newestLine + 1 + middleLine;
    expect(twoFit).toBeLessThanOrEqual(LESSONS_BLOCK_CHAR_BUDGET);
    expect(twoFit + 1 + oldestLine).toBeGreaterThan(LESSONS_BLOCK_CHAR_BUDGET);

    const block = renderLessonsBlock([newest, middle, oldest])!;
    expect(block.length).toBe(twoFit);
    expect(block).toContain("- alpha — ");
    expect(block).toContain("- beta — ");
    expect(block).not.toContain("- gamma — ");

    // The newest lesson always renders, even when it alone busts the budget.
    const huge = lesson("omega", "w".repeat(900), "2026-09-22T10:00:00.000Z");
    const loneBlock = renderLessonsBlock([huge])!;
    expect(loneBlock.startsWith(`${LESSONS_BLOCK_HEADER}\n- omega — `)).toBe(true);
    expect(loneBlock.length).toBeGreaterThan(LESSONS_BLOCK_CHAR_BUDGET);
  });

  it("migration 022 up/down: the lesson vocabulary widens and narrows", async () => {
    // Up state (current): the widened CHECKs admit the row.
    const { lesson } = await propose("migration probe", "n");
    expect(lesson.verdict).toBe("proposed");

    // Roll back exactly 022 — the down path purges then narrows.
    expect(await migrateDown(db.pool, { to: "021_reminders" }, defaultMigrationsDir())).toEqual([
      "024_outcomes",
      "023_gmail_content",
      "022_lesson_vocabulary",
    ]);
    await expect(
      db.pool.query(
        `INSERT INTO feedback (item_type, item_id, verdict, note, created_by)
         VALUES ('lesson', 't2', 'proposed', 'n', $1)`,
        [owner],
      ),
    ).rejects.toThrow(/feedback_item_type_check/);
    await expect(
      db.pool.query(
        `INSERT INTO feedback (item_type, item_id, verdict, note, created_by)
         VALUES ('event', 't3', 'ratified', 'n', $1)`,
        [owner],
      ),
    ).rejects.toThrow(/feedback_verdict_check/);
    const columns = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'feedback' AND column_name IN ('updated_at', 'source_refs')`,
    );
    expect(columns.rows).toEqual([]);

    // Re-up restores the widened vocabulary.
    expect(await migrateUp(db.pool, defaultMigrationsDir())).toEqual(["022_lesson_vocabulary", "023_gmail_content", "024_outcomes"]);
    const restored = await propose("migration probe", "n");
    expect(restored.created).toBe(true);
  });
});
