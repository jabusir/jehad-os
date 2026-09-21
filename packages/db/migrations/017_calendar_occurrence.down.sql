-- 017_calendar_occurrence.down.sql — tested down path (AGENTS.md).
-- Dropping the columns drops their column-level CHECKs with them; the
-- named graduation constraint goes first.

DROP INDEX IF EXISTS calendar_events_occurrence_sweep_idx;
ALTER TABLE calendar_events
  DROP CONSTRAINT IF EXISTS calendar_events_occurrence_graduation_check,
  DROP COLUMN IF EXISTS occurrence_confirmed_by,
  DROP COLUMN IF EXISTS occurrence;
