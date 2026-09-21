-- 020_system_feedback.sql — W6(a) Turn Interpreter system_feedback landing
-- (jarvis-v1.md §7 W6(a), rev 3 R8/R10): a confirmed system_feedback proposal
-- ("log it") records through the EXISTING append-only feedback table — widened
-- additively, never duplicated (the 016 drop/recreate precedent).
--
-- Minimal vocabulary choice (documented in the lane report):
--   item_type + 'system_feedback'              — one new item world
--   verdict   + 'capability_gap'|'bug'|'request' — the interpreter category
--               enum lands verbatim in the existing verdict slot (the
--               category IS the verdict dimension for self-reported system
--               feedback; no extra column, no second table).
-- Row mapping: item_id = 'system-feedback:<principalId>:<confirmedAt ISO>',
-- note = redacted 'subject — detail' (or subject alone), created_by =
-- confirming principal. target_type/target_ref/source_attribution stay NULL
-- (they are calibration-targeting vocabulary; reusing them would lie).
--
-- No other table changes; no NOT NULL added; nothing removed.

ALTER TABLE feedback DROP CONSTRAINT feedback_item_type_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_item_type_check
    CHECK (item_type IN ('notification', 'attention_item', 'review_item', 'brief_section', 'event', 'calibration', 'system_feedback'));

ALTER TABLE feedback DROP CONSTRAINT feedback_verdict_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_verdict_check
    CHECK (verdict IN ('useful', 'noise', 'missed', 'incorrect', 'interruptive', 'capability_gap', 'bug', 'request'));
