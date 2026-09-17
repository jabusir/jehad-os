-- 002_action_transition_guard.sql (down) — tested down path (AGENTS.md).
-- Forward-only in production intent; rolling this back removes the DB-level
-- transition guard only (no data is touched).

DROP TRIGGER IF EXISTS action_attempts_outcome_guard_trigger ON action_attempts;
DROP FUNCTION IF EXISTS action_attempts_outcome_guard();
