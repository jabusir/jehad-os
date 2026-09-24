-- Down-path for 027_verifier_gate (forward-only in intent; tested during dev).

DROP TRIGGER IF EXISTS outcomes_verifier_gate ON outcomes;
DROP FUNCTION IF EXISTS outcomes_verifier_gate();
ALTER TABLE outcome_criteria DROP CONSTRAINT IF EXISTS outcome_criteria_verified_by_fk;
