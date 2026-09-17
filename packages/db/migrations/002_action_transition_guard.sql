-- 002_action_transition_guard.sql — DB-level guard on action_attempts
-- outcome transitions (plan §15 M4 hardening; review finding: transitions
-- were guarded only in ActionService code, so raw SQL could rewrite attempt
-- history — a terminal 'failed' flipped back to 'succeeded' would make the
-- audit log lie).
--
-- Mirrors ADR-0011 / cleanup §5 semantics exactly:
--   executing → succeeded | failed | unknown     (ActionService.recordOutcome)
--   unknown    → reconciled                       (ActionService.reconcileAttempt)
-- Terminal outcomes (succeeded / failed / reconciled) are immutable: ANY
-- outcome change from them is rejected. No-op updates (outcome unchanged,
-- other columns touched) always pass — the guard polices the state machine,
-- not bookkeeping columns like updated_at or error text.

CREATE OR REPLACE FUNCTION action_attempts_outcome_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.outcome = OLD.outcome THEN
        RETURN NEW;
    END IF;
    IF OLD.outcome IN ('succeeded', 'failed', 'reconciled') THEN
        RAISE EXCEPTION
            'action_attempts outcome transition % -> % is forbidden: terminal outcomes are immutable',
            OLD.outcome, NEW.outcome
            USING ERRCODE = 'raise_exception';
    END IF;
    IF OLD.outcome = 'executing' AND NEW.outcome IN ('succeeded', 'failed', 'unknown') THEN
        RETURN NEW;
    END IF;
    IF OLD.outcome = 'unknown' AND NEW.outcome = 'reconciled' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION
        'action_attempts outcome transition % -> % is forbidden',
        OLD.outcome, NEW.outcome
        USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER action_attempts_outcome_guard_trigger
    BEFORE UPDATE OF outcome ON action_attempts
    FOR EACH ROW
    EXECUTE FUNCTION action_attempts_outcome_guard();
