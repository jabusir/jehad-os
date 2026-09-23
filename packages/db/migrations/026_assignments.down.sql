-- Down-path for 026_assignments (forward-only in intent; tested during dev).

DROP TRIGGER IF EXISTS assignments_terminal_freeze_trg ON assignments;
DROP FUNCTION IF EXISTS assignments_terminal_freeze();
DROP TRIGGER IF EXISTS assignments_transition_guard_trg ON assignments;
DROP FUNCTION IF EXISTS assignments_transition_guard();

ALTER TABLE model_calls
    DROP COLUMN IF EXISTS assignment_id,
    DROP COLUMN IF EXISTS outcome_id;

DROP TABLE IF EXISTS assignments;
