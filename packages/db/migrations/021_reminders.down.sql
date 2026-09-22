-- 021_reminders.down.sql — tested down path (AGENTS.md). Reminders are
-- inert without the worker lane; drop indexes then the table.

DROP INDEX IF EXISTS reminders_armed_touch_idx;
DROP INDEX IF EXISTS reminders_principal_status_idx;
DROP TABLE IF EXISTS reminders;
