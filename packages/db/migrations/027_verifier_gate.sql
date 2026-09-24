-- 027_verifier_gate.sql — D3: the verifier half of the completion gate.
--
-- 024's completion gate enforced the criteria half (`completed` requires
-- every criterion verified/waived); its comment promised the
-- verifier-assignment half would land with assignments. It does here:
--
--   1. The FK deferred in 024 (outcome_criteria.verified_by_assignment_id →
--      assignments.id) — a verified criterion now structurally points at a
--      real assignment row.
--   2. verifying → completed is refused when any criterion claims WORKER
--      verification (verified_by_assignment_id set) unless a SUCCEEDED
--      verifier assignment exists for the outcome AND at least one evidence
--      row (source_type='assignment') carries that verifier's id in
--      metadata->>'assignmentId' — the traceable provenance
--      completeAssignment writes. No independent verification, no
--      completion: builders don't self-verify (ADR-0013). Owner-verified
--      criteria (evidence_ref, owner act) are NOT gated — owner judgment
--      needs no worker paper trail; the worker claim is what does.

ALTER TABLE outcome_criteria
    ADD CONSTRAINT outcome_criteria_verified_by_fk
    FOREIGN KEY (verified_by_assignment_id) REFERENCES assignments(id);

CREATE OR REPLACE FUNCTION outcomes_verifier_gate() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'verifying' AND NEW.status = 'completed' THEN
        IF EXISTS (
            SELECT 1 FROM outcome_criteria c
             WHERE c.outcome_id = NEW.id
               AND c.verified_by_assignment_id IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM assignments a
                    WHERE a.outcome_id = NEW.id
                      AND a.role = 'verifier'
                      AND a.status = 'succeeded'
                      AND EXISTS (
                          SELECT 1 FROM evidence e
                           WHERE e.source_type = 'assignment'
                             AND e.metadata->>'assignmentId' = a.id::text
                      )
               )
        ) THEN
            RAISE EXCEPTION 'outcomes: cannot complete — worker-verified criteria require a succeeded verifier assignment with verifier evidence (D3 gate)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcomes_verifier_gate
    BEFORE UPDATE OF status ON outcomes
    FOR EACH ROW EXECUTE FUNCTION outcomes_verifier_gate();
