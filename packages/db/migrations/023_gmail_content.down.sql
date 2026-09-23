-- 023_gmail_content.sql (down) — remove the Gmail content lane (ADR-0016).
--
-- Order matters: drop the content table first, then restore migration 015's
-- original two inline health CHECKs (dropping the merged constraint). The
-- down path tolerates rows only in gmail_sync_state (health may carry the
-- `content` dim — the restored 015 CHECKs would reject it, so the dim is
-- stripped defensively before the constraint swap when present; '{}' and
-- five-dim snapshots pass unchanged).

DROP TABLE IF EXISTS gmail_messages;

-- Strip the content dim if any snapshot carries it (deterministic jsonb
-- rebuild over the five original keys).
UPDATE gmail_sync_state SET health = jsonb_strip_nulls((
    SELECT jsonb_object_agg(key, value)
    FROM jsonb_each(health)
    WHERE key IN ('process', 'credential', 'cursor', 'decode', 'quota')
)) WHERE health ? 'content';

ALTER TABLE gmail_sync_state DROP CONSTRAINT IF EXISTS gmail_sync_state_health_dims_check;
ALTER TABLE gmail_sync_state ADD CONSTRAINT gmail_sync_state_health_check CHECK (
    jsonb_path_query_array(health, '$.keyvalue().key') <@ '["process", "credential", "cursor", "decode", "quota"]');
ALTER TABLE gmail_sync_state ADD CONSTRAINT gmail_sync_state_health_check1 CHECK (
    jsonb_path_query_array(health, '$.keyvalue().value') <@ '["healthy", "degraded", "failed"]');
