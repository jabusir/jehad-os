-- 010_imessage_sensor.down.sql — reverse dependency order: transport events
-- (FK → fingerprints), fingerprints (FK → notifications), sensor state, then
-- the notifications reply-rule columns/vocabulary (rows using them die
-- first; their audit_log rows are text projections and need no cascade).

DROP TABLE IF EXISTS imessage_sensor_state;
DROP TABLE IF EXISTS imessage_transport_events;
DROP TABLE IF EXISTS sent_message_fingerprints;

ALTER TABLE notifications DROP COLUMN IF EXISTS third_party_recipient;
ALTER TABLE notifications DROP COLUMN IF EXISTS conversation_principal_id;
ALTER TABLE notifications DROP COLUMN IF EXISTS requesting_principal_id;
ALTER TABLE notifications DROP COLUMN IF EXISTS surface;

DELETE FROM notifications WHERE kind = 'reply';
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom', 'calendar-change'));
