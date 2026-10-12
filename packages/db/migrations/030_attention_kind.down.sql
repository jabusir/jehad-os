-- 030_attention_kind.down.sql — restore the 019 vocabularies (tested down
-- path, AGENTS.md). Dev-only: rows using the widened vocabulary are deleted
-- first (their audit_log rows are text projections and need no cascade).

DELETE FROM notifications WHERE kind = 'attention' OR source_type = 'attention';

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom', 'calendar-change', 'reply', 'calibration', 'grant-reminder'));

ALTER TABLE notifications DROP CONSTRAINT notifications_source_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_source_type_check
    CHECK (source_type IN ('escalation', 'brief', 'run', 'calendar', 'calibration'));
