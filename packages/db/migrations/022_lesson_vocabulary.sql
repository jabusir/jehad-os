-- 022_lesson_vocabulary.sql — SV3/SV4 grounded-lessons landing
-- (feedback-and-self-verification.md §SV3 "nightly grounded harvest →
-- LESSONS", plan-review rev 2026-09-22): distilled lessons ride the EXISTING
-- feedback table — widened additively, never duplicated (the 016/020
-- drop/recreate constraint precedent).
--
-- Vocabulary choice (documented in the lane report):
--   item_type + 'lesson'                        — one new item world
--   verdict   + 'proposed'|'ratified'|'retired' — the W4 propose→confirm
--               gate as a verdict dimension: the harvester proposes, the
--               owner ratifies (installed into the LESSONS block) or
--               retires. The gate state IS the verdict dimension for
--               lessons (the 020 interpreter-category precedent; no extra
--               column, no second table).
--   updated_at  timestamptz NOT NULL DEFAULT now() — lessons are the first
--               MUTABLE feedback world: a re-proposed identical subject
--               refreshes note/updated_at instead of duplicating (harvest
--               idempotency), and ratification re-stamps it — for a
--               ratified row updated_at IS the "earned" instant the render
--               cites.
--   source_refs jsonb NULL — provenance: the audit_log ids the lesson was
--               distilled from (the converse.claim_audit ledger / sentinel
--               actions). source_attribution stays calibration vocabulary
--               (the 020 rule: reusing it would lie).
--
-- item_id carries the subject verbatim; the lesson dedupe key is
-- (item_type, item_id) = ('lesson', subject), enforced by the partial
-- unique index below — every other feedback world keeps its append-only
-- multi-row semantics untouched.
--
-- Row mapping: note = counts + dates evidence line (no transcript prose),
-- created_by = the owning principal. No NOT NULL added to existing columns;
-- nothing removed.

ALTER TABLE feedback DROP CONSTRAINT feedback_item_type_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_item_type_check
    CHECK (item_type IN ('notification', 'attention_item', 'review_item', 'brief_section', 'event', 'calibration', 'system_feedback', 'lesson'));

ALTER TABLE feedback DROP CONSTRAINT feedback_verdict_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_verdict_check
    CHECK (verdict IN ('useful', 'noise', 'missed', 'incorrect', 'interruptive', 'capability_gap', 'bug', 'request', 'proposed', 'ratified', 'retired'));

ALTER TABLE feedback ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE feedback ADD COLUMN source_refs jsonb;

-- Lesson dedupe: one row per subject — the nightly harvest re-proposes
-- idempotently. Partial: other item worlds stay append-only.
CREATE UNIQUE INDEX feedback_lesson_subject_unique
    ON feedback (item_type, item_id)
    WHERE item_type = 'lesson';

-- collectRatifiedLessons: the LESSONS-block feed, most recently ratified first.
CREATE INDEX feedback_lesson_ratified_idx
    ON feedback (updated_at DESC)
    WHERE item_type = 'lesson' AND verdict = 'ratified';
