-- 020_system_feedback.down.sql — tested down path (AGENTS.md). Dev-only:
-- purge widened-vocabulary rows BEFORE narrowing every CHECK (016 precedent).

DELETE FROM feedback WHERE item_type = 'system_feedback';

ALTER TABLE feedback DROP CONSTRAINT feedback_item_type_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_item_type_check
    CHECK (item_type IN ('notification', 'attention_item', 'review_item', 'brief_section', 'event', 'calibration'));

ALTER TABLE feedback DROP CONSTRAINT feedback_verdict_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_verdict_check
    CHECK (verdict IN ('useful', 'noise', 'missed', 'incorrect', 'interruptive'));
