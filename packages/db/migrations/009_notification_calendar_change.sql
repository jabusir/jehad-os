-- 009_notification_calendar_change.sql — E4-S: widen the notifications
-- vocabulary for the calendar-change producer (packages/core calendar sync).
--
-- 006 constrained both kind and source_type with CHECKs; this widens BOTH:
--   kind        + 'calendar-change'  (disruptive near-term schedule changes)
--   source_type + 'calendar'          (provenance: the calendar sync sensor)
--
-- Noise gate (policy.yaml autoApproveKinds + the 48h filter in the
-- producer) stays in the application/policy layer — the schema only admits
-- the vocabulary. Forward-only in intent; the down path below restores the
-- 006 vocabulary and is dev-only.

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom', 'calendar-change'));

ALTER TABLE notifications DROP CONSTRAINT notifications_source_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_source_type_check
    CHECK (source_type IN ('escalation', 'brief', 'run', 'calendar'));
