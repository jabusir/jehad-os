-- 016_calibration.down.sql — tested down path (AGENTS.md). Dev-only:
-- purges calibration-vocabulary rows BEFORE narrowing every CHECK, drops
-- the additive feedback columns (calibration_item_id's FK goes with the
-- column), then the calibration_items table.

DELETE FROM notifications WHERE kind = 'calibration' OR source_type = 'calibration';

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom', 'calendar-change', 'reply'));

ALTER TABLE notifications DROP CONSTRAINT notifications_source_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_source_type_check
    CHECK (source_type IN ('escalation', 'brief', 'run', 'calendar'));

DELETE FROM feedback WHERE item_type = 'calibration';

DROP INDEX IF EXISTS feedback_calibration_item_idx;
ALTER TABLE feedback DROP COLUMN IF EXISTS calibration_item_id;
ALTER TABLE feedback DROP COLUMN IF EXISTS source_attribution;
ALTER TABLE feedback DROP COLUMN IF EXISTS target_ref;
ALTER TABLE feedback DROP COLUMN IF EXISTS target_type;

ALTER TABLE feedback DROP CONSTRAINT feedback_item_type_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_item_type_check
    CHECK (item_type IN ('notification', 'attention_item', 'review_item', 'brief_section', 'event'));

DROP TABLE IF EXISTS calibration_items;
