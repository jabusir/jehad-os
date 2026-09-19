-- 009_notification_calendar_change.down.sql — restore the 006 vocabulary.
-- Dev-only down path: rows using the widened vocabulary are deleted first
-- (their audit_log rows are text projections and need no cascade).

DELETE FROM notifications WHERE kind = 'calendar-change' OR source_type = 'calendar';

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom'));

ALTER TABLE notifications DROP CONSTRAINT notifications_source_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_source_type_check
    CHECK (source_type IN ('escalation', 'brief', 'run'));
