-- 022_lesson_vocabulary.down.sql — tested down path (AGENTS.md). Dev-only:
-- purge widened-vocabulary rows BEFORE narrowing every CHECK and dropping
-- the lesson columns/indexes (the 016/020 precedent).

DELETE FROM feedback WHERE item_type = 'lesson';

DROP INDEX IF EXISTS feedback_lesson_ratified_idx;
DROP INDEX IF EXISTS feedback_lesson_subject_unique;

ALTER TABLE feedback DROP COLUMN IF EXISTS source_refs;
ALTER TABLE feedback DROP COLUMN IF EXISTS updated_at;

ALTER TABLE feedback DROP CONSTRAINT feedback_item_type_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_item_type_check
    CHECK (item_type IN ('notification', 'attention_item', 'review_item', 'brief_section', 'event', 'calibration', 'system_feedback'));

ALTER TABLE feedback DROP CONSTRAINT feedback_verdict_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_verdict_check
    CHECK (verdict IN ('useful', 'noise', 'missed', 'incorrect', 'interruptive', 'capability_gap', 'bug', 'request'));
