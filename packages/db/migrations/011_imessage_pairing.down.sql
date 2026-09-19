-- 011_imessage_pairing.down.sql — reverse dependency order: transport
-- events lose the pairing probe column, model_calls loses principal/surface
-- accounting, notifications loses the reply recipient, then the pairing
-- tables die (no other table references them; audit_log rows are text
-- projections and need no cascade).

ALTER TABLE imessage_transport_events DROP COLUMN IF EXISTS pairing_attempt_hash;

ALTER TABLE model_calls DROP COLUMN IF EXISTS surface;
ALTER TABLE model_calls DROP COLUMN IF EXISTS principal_id;

DELETE FROM notifications WHERE recipient IS NOT NULL;
ALTER TABLE notifications DROP COLUMN IF EXISTS recipient;

DROP TABLE IF EXISTS imessage_pairing_sessions;
DROP TABLE IF EXISTS transport_identities;
