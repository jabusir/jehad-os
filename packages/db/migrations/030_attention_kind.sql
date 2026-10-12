-- 030_attention_kind.sql — W1 attention delivery (ADR-0018 §4; w1-contract
-- "Migration 030"): widen the notifications vocabulary for the attention
-- producer (009 drop/recreate precedent).
--
--   kind        + 'attention'  (attention item delivery rows —
--                               enqueueAttentionNotification)
--   source_type + 'attention'  (provenance: source_id = attention_items.id)
--
-- Approval stays in the policy layer (notifications.autoApproveKinds — the
-- owner ratified 'attention' alongside 'brief'); the schema only admits the
-- vocabulary. Forward-only in intent; the down path restores the 019
-- vocabularies and is dev-only.

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom', 'calendar-change', 'reply', 'calibration', 'grant-reminder', 'attention'));

ALTER TABLE notifications DROP CONSTRAINT notifications_source_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_source_type_check
    CHECK (source_type IN ('escalation', 'brief', 'run', 'calendar', 'calibration', 'attention'));
