-- 024_outcomes.sql (down) — remove the Outcome primitive (roadmap §5).
-- Order: triggers/functions first, then tables (waits/criteria cascade with
-- outcomes; drop children explicitly for clarity).

DROP TRIGGER IF EXISTS outcomes_completion_gate ON outcomes;
DROP FUNCTION IF EXISTS outcomes_completion_gate();
DROP TRIGGER IF EXISTS outcomes_transition_guard ON outcomes;
DROP FUNCTION IF EXISTS outcomes_transition_guard();
DROP TABLE IF EXISTS outcome_waits;
DROP TABLE IF EXISTS outcome_criteria;
DROP TABLE IF EXISTS outcomes;
