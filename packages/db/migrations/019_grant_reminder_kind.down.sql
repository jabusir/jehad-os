-- Down: purge widened rows BEFORE narrowing (016 precedent).
DELETE FROM notifications WHERE kind = 'grant-reminder';
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom', 'calendar-change', 'reply', 'calibration'));
