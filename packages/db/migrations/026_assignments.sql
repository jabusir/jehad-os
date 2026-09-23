-- Migration 026: assignments (D1 — the worker contract, roadmap §8.3).
--
-- An assignment is a ROLE with a typed envelope: the executive (the outcome
-- executor) mints it, hands it a bounded context package + explicit success
-- criteria + its own capability grant + a budget + a deadline; the worker
-- returns a bounded result envelope (artifact + citations + typed blocker +
-- cost). Workers do not own canonical truth: this table records what they
-- RETURNED — world-model mutation only ever happens through the domain
-- services the executive runs afterwards (verification lands in D3).
--
-- Status vocabulary (roadmap §8.3): proposed|queued|running|succeeded|
-- failed|cancelled|blocked. The trigger guard below enforces the machine;
-- terminal states are locked exactly like outcomes.
--
-- model_calls gains nullable outcome_id/assignment_id attribution columns —
-- per-assignment budgets police the model_calls ledger the same way the
-- gateway polices per-principal windows (the global monthly caps unchanged).

CREATE TABLE assignments (
    id                     uuid PRIMARY KEY,
    outcome_id             uuid REFERENCES outcomes(id),
    principal_id           uuid NOT NULL REFERENCES principals(id),
    role                   text NOT NULL
                           CHECK (role IN ('research', 'verifier')),
    status                 text NOT NULL DEFAULT 'queued'
                           CHECK (status IN (
                             'proposed', 'queued', 'running',
                             'succeeded', 'failed', 'cancelled', 'blocked')),
    input                  jsonb NOT NULL,        -- bounded context package + task spec
    success_criteria       jsonb NOT NULL DEFAULT '[]'::jsonb,
    capability_grant_id    uuid REFERENCES capability_grants(id),
    budget_usd             numeric NOT NULL CHECK (budget_usd >= 0),
    spent_usd              numeric NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
    deadline_at            timestamptz,
    result                 jsonb,                 -- bounded result envelope (validated in service)
    result_ref             uuid REFERENCES artifacts(id),
    verifies_assignment_id uuid REFERENCES assignments(id),  -- builder ≠ verifier (D3)
    blocker                jsonb,                 -- typed: need_judgment|need_capability|external_wait|mechanical_failure
    failure_reason         text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assignments_outcome_idx ON assignments (outcome_id);
CREATE INDEX assignments_principal_status_idx ON assignments (principal_id, status);

CREATE FUNCTION assignments_transition_guard() RETURNS trigger AS $$
BEGIN
    IF OLD.status = NEW.status THEN RETURN NEW; END IF;
    IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
        RAISE EXCEPTION 'assignments: terminal status % cannot transition to %', OLD.status, NEW.status;
    END IF;
    IF NOT (
        (OLD.status = 'proposed' AND NEW.status IN ('queued', 'cancelled', 'failed')) OR
        (OLD.status = 'queued'   AND NEW.status IN ('running', 'cancelled', 'failed')) OR
        (OLD.status = 'running'  AND NEW.status IN ('succeeded', 'failed', 'blocked', 'cancelled')) OR
        (OLD.status = 'blocked'  AND NEW.status IN ('running', 'failed', 'cancelled'))
    ) THEN
        RAISE EXCEPTION 'assignments: illegal transition % -> %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assignments_transition_guard_trg
    BEFORE UPDATE OF status ON assignments
    FOR EACH ROW EXECUTE FUNCTION assignments_transition_guard();

-- Terminal assignments freeze: result/spent/blocked are write-once.
CREATE FUNCTION assignments_terminal_freeze() RETURNS trigger AS $$
BEGIN
    IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
        IF NEW.result IS DISTINCT FROM OLD.result
           OR NEW.spent_usd IS DISTINCT FROM OLD.spent_usd
           OR NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'assignments: terminal assignment % is frozen', OLD.id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assignments_terminal_freeze_trg
    BEFORE UPDATE ON assignments
    FOR EACH ROW EXECUTE FUNCTION assignments_terminal_freeze();

ALTER TABLE model_calls
    ADD COLUMN outcome_id    uuid REFERENCES outcomes(id),
    ADD COLUMN assignment_id uuid REFERENCES assignments(id);
