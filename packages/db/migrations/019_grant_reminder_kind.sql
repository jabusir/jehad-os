-- 019: grant-reminder notification kind (owner directive 2026-09-21 —
-- deterministic one-step renewal reminders for owner-held TTL grants,
-- e.g. imessage:ingest). Widens the vocabulary; 016 precedent.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom', 'calendar-change', 'reply', 'calibration', 'grant-reminder'));
