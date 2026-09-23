-- 024_outcomes.sql — the Outcome primitive (Delegate/Watch roadmap §5;
-- ADR-0017). D0 of the Delegate/Watch roadmap.
--
-- An Outcome is a desired result Jehad OS has ACCEPTED RESPONSIBILITY for
-- advancing over time: owner states it in natural language, the executive
-- proposes explicit success criteria, a deterministic confirm creates the
-- durable row (independent of any conversation thread), and a durable
-- process (workflow layer, via the WorkflowRuntime port) advances it:
-- plan → assignments (D1+) → waits → verification → completion.
--
-- Authority split (unchanged): Postgres owns ALL of this state; the
-- workflow runtime is an executor (ADR-0008). Waits live in
-- outcome_waits — canonical rows — so restart survival is structural and
-- the runtime stays swappable. The lost-wakeup handshake (executor
-- registers its runtime wait, then RE-READS the canonical wait row) is
-- implemented in the executor, not here; these rows are its source of
-- truth.
--
-- Completion is mechanically gated (ADR-0017 §1.1): `completed` requires
-- every outcome_criteria row to be verified or waived_by_owner. The
-- verifier-assignment evidence requirement lands with migration 026
-- (builder ≠ verifier, structural); until then deterministic executor
-- checks may verify criteria, and the trigger below enforces the criteria
-- half of the gate.

CREATE TABLE outcomes (
    id                uuid PRIMARY KEY,
    principal_id      uuid NOT NULL REFERENCES principals(id),
    ref               text NOT NULL UNIQUE,          -- mint-once conversation addressable code
    title             text NOT NULL,
    directive         text NOT NULL,                  -- owner's words, verbatim (provenance of the ask)
    status            text NOT NULL DEFAULT 'proposed'
                      CHECK (status IN (
                        'proposed', 'accepted', 'queued', 'running',
                        'waiting_external', 'waiting_user', 'blocked',
                        'verifying', 'completed', 'failed', 'cancelled')),
    constraints       jsonb NOT NULL DEFAULT '[]'::jsonb,
    plan              jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered assignment refs (D1+); not a DAG engine
    budget_usd        numeric,
    deadline_at       timestamptz,
    source_thread_id  uuid REFERENCES interaction_threads(id),  -- provenance of the ask
    created_by        text NOT NULL DEFAULT 'conversation'
                      CHECK (created_by IN ('conversation', 'josctl')),
    waiting_on        jsonb,
    failure_reason    text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outcomes_principal_status_idx ON outcomes (principal_id, status);
CREATE INDEX outcomes_status_idx ON outcomes (status) WHERE status NOT IN ('completed', 'failed', 'cancelled');

-- First-class success criteria (ADR-0017 §1.1): verification state is
-- lifecycle-bearing — rows, never opaque jsonb. Worker prose can NEVER
-- mutate these; only a verifier path (D3: verifier assignments) or an
-- explicit owner waiver flips status.
CREATE TABLE outcome_criteria (
    id                         uuid PRIMARY KEY,
    outcome_id                 uuid NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
    ordinal                    integer NOT NULL,
    criterion                  text NOT NULL,
    verification_method        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- typed check spec, validator-enforced
    status                     text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'verified', 'unverified', 'failed', 'waived_by_owner')),
    evidence_ref               uuid REFERENCES evidence(id),
    verified_by_assignment_id  uuid,               -- FK lands with migration 026 (assignments)
    verified_at                timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    UNIQUE (outcome_id, ordinal),
    -- A verified criterion carries its verification timestamp.
    CHECK (status <> 'verified' OR verified_at IS NOT NULL),
    -- A waiver is an owner act: it carries neither evidence nor verifier.
    CHECK (status <> 'waived_by_owner' OR (evidence_ref IS NULL AND verified_by_assignment_id IS NULL))
);

-- Durable external waits: the canonical half of the wait/resume handshake.
-- `predicate` is TYPED (roadmap §5.5 vocabulary; validator + matcher in
-- packages/core/src/outcomes/predicates.ts) — never free-form jsonb
-- execution, never model-supplied expressions.
CREATE TABLE outcome_waits (
    id            uuid PRIMARY KEY,
    outcome_id    uuid NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
    event_type    text NOT NULL,
    predicate     jsonb NOT NULL,
    status        text NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting', 'satisfied', 'expired', 'cancelled')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    satisfied_at  timestamptz,
    expires_at    timestamptz
);

CREATE INDEX outcome_waits_waiting_idx ON outcome_waits (event_type) WHERE status = 'waiting';
CREATE INDEX outcome_waits_outcome_idx ON outcome_waits (outcome_id);

-- State-machine guard (pattern: 002_action_transition_guard.sql).
CREATE OR REPLACE FUNCTION outcomes_transition_guard() RETURNS trigger AS $$
BEGIN
    IF OLD.status = NEW.status THEN RETURN NEW; END IF;
    IF OLD.status IN ('completed', 'failed', 'cancelled') THEN
        RAISE EXCEPTION 'outcomes: terminal status % cannot transition to %', OLD.status, NEW.status;
    END IF;
    IF NOT (
        (OLD.status = 'proposed'         AND NEW.status IN ('accepted', 'cancelled')) OR
        (OLD.status = 'accepted'         AND NEW.status IN ('queued', 'cancelled', 'failed')) OR
        (OLD.status = 'queued'           AND NEW.status IN ('running', 'cancelled', 'failed')) OR
        (OLD.status = 'running'          AND NEW.status IN ('waiting_external', 'waiting_user', 'blocked', 'verifying', 'failed', 'cancelled')) OR
        (OLD.status = 'waiting_external' AND NEW.status IN ('running', 'blocked', 'failed', 'cancelled')) OR
        (OLD.status = 'waiting_user'     AND NEW.status IN ('running', 'blocked', 'failed', 'cancelled')) OR
        (OLD.status = 'blocked'          AND NEW.status IN ('running', 'waiting_external', 'waiting_user', 'verifying', 'failed', 'cancelled')) OR
        (OLD.status = 'verifying'        AND NEW.status IN ('completed', 'running', 'blocked', 'failed', 'cancelled'))
    ) THEN
        RAISE EXCEPTION 'outcomes: illegal transition % -> %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcomes_transition_guard
    BEFORE UPDATE OF status ON outcomes
    FOR EACH ROW EXECUTE FUNCTION outcomes_transition_guard();

-- Completion gate (criteria half; verifier-assignment half lands in 026).
CREATE OR REPLACE FUNCTION outcomes_completion_gate() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'completed' THEN
        IF EXISTS (
            SELECT 1 FROM outcome_criteria
             WHERE outcome_id = NEW.id
               AND status NOT IN ('verified', 'waived_by_owner')
        ) THEN
            RAISE EXCEPTION 'outcomes: cannot complete — unmet criteria remain (ADR-0017 gate)';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcomes_completion_gate
    BEFORE UPDATE OF status ON outcomes
    FOR EACH ROW EXECUTE FUNCTION outcomes_completion_gate();
