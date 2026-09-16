-- 001_schema_core.sql — M1: remaining schema-v1 tables
-- Spec: docs/data-model.md §4–§5 (21-table set; principals lands at M0 via
-- 000_bootstrap_auth.sql and is NOT repeated here). Plan §7 canonical; ADR-0005.
--
-- Type policy (data-model.md §9.3): boring, explicit Postgres types for the
-- untyped plan names — uuid PKs, text, timestamptz for *_at, numeric for money
-- and confidences, integer for counts, jsonb where the plan says jsonb.
-- Enum-like columns use CHECK constraints (cheap additive evolution) unless the
-- vocabulary is not enumerated in the spec (then unconstrained text + comment —
-- never a silently invented enum).
--
-- Convention (data-model.md §2): every table carries id/created_at/updated_at
-- unless its row states otherwise. Exception: `events` stores the envelope
-- verbatim — occurred_at/recorded_at are its timestamps; no created_at/updated_at.
--
-- domain_id/sensitivity appear ONLY on the provenance carriers listed in
-- plan §7 (events, entities, decisions, relationships, evidence, artifacts,
-- action_intents, capability_grants, runs, domains) — plus memory_candidates
-- (D2 flag, see below). Not blanket (plan §7).

-- ---------------------------------------------------------------- domains
CREATE TABLE domains (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key            text NOT NULL UNIQUE,
    name           text NOT NULL,
    -- sensitivity/retention_class vocabularies are policy-defined (plan §9/§10),
    -- not enumerated in plan §7 — unconstrained in v1.
    sensitivity    text NOT NULL,
    retention_class text NOT NULL,
    detachable     boolean NOT NULL DEFAULT false,
    storage_mode   text NOT NULL DEFAULT 'local'
                   CHECK (storage_mode IN ('local', 'remote', 'federated', 'opaque')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- runs
-- NOTE: no human_blocked_ms column — derived from human_waits (review §14;
-- data-model.md §6.3).
CREATE TABLE runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         text NOT NULL CHECK (kind IN ('workflow', 'harness')),
    workflow_id  text,
    principal_id uuid NOT NULL REFERENCES principals(id),
    -- status vocabulary owned by the workflow runtime (plan §12); not
    -- enumerated in plan §7 — unconstrained in v1.
    status       text NOT NULL,
    intent       text,
    domain_id    uuid NOT NULL REFERENCES domains(id),
    budget       numeric,           -- per-run model-spend cap (A13), USD
    started_at   timestamptz NOT NULL DEFAULT now(),
    ended_at     timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_status_idx ON runs (status);

-- ---------------------------------------------------------------- events
-- Envelope stored verbatim; columns are the relational projection
-- (docs/event-model.md §2; camelCase→snake_case mapping is M2's to define
-- once, in one place — data-model.md §9.4).
CREATE TABLE events (
    id              uuid PRIMARY KEY,  -- envelope id; UUIDv7 minted by writer (PG16 has no uuidv7())
    type            text NOT NULL,     -- catalog v1 (docs/event-model.md §4); names immutable once released — no CHECK
    source          text NOT NULL,     -- cli.capture | openclaw.channel | adapter:<id> | internal
    occurred_at     timestamptz NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    idempotency_key text NOT NULL,     -- sha256(source + external id); duplicate delivery is a 200-noop
    domain_id       uuid NOT NULL REFERENCES domains(id),
    payload         jsonb NOT NULL,
    sensitivity     text NOT NULL,     -- vocabulary policy-defined (§5); not enumerated in v1
    run_id          uuid REFERENCES runs(id) ON DELETE SET NULL,
    schema_version  integer NOT NULL,  -- payload schema version (review §18)
    UNIQUE (idempotency_key)
);
CREATE INDEX events_domain_occurred_idx ON events (domain_id, occurred_at);

-- ---------------------------------------------------------------- outbox
CREATE TABLE outbox (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      uuid NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'dispatched', 'failed')),
    attempts      integer NOT NULL DEFAULT 0,
    last_error    text,
    dispatched_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_status_idx ON outbox (status);

-- ---------------------------------------------------------------- entities
CREATE TABLE entities (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    discriminator text NOT NULL,       -- person/org/project/account/…
    domain_id     uuid NOT NULL REFERENCES domains(id),
    name          text NOT NULL,
    external_refs jsonb NOT NULL DEFAULT '{}'::jsonb,  -- logical refs only; never contact-routing PII (review §12)
    sensitivity   text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- commitments
-- NOTE: no domain_id column — plan §7 omits it (derivable via source_event_id
-- → events.domain_id). Flagged for M6 review: domain-scoped commitment queries
-- then require that join; adding a column later is a cheap migration.
-- NOTE: blocking is expressed via relationships (relation='blocked_by'),
-- NOT a blocked_by[] array (review §9; data-model.md §6.2).
CREATE TABLE commitments (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    direction              text NOT NULL CHECK (direction IN ('owes_me', 'i_owe')),
    counterparty_text      text NOT NULL,          -- always present (T9)
    counterparty_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL,
    link_confidence        numeric CHECK (link_confidence >= 0 AND link_confidence <= 1),
    description            text NOT NULL,
    due_at                 timestamptz,
    confidence             numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    status                 text NOT NULL
                           CHECK (status IN ('open', 'met', 'missed', 'renegotiated', 'void')),
    source_event_id        uuid NOT NULL REFERENCES events(id),
    may_follow_up          boolean NOT NULL DEFAULT false,  -- deny-by-default follow-up gating (§7)
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commitments_status_due_idx ON commitments (status, due_at);

-- ---------------------------------------------------------------- decisions
-- NOTE: no assumptions jsonb — the assumptions table is the single source of
-- truth (review §10; data-model.md §6.1).
CREATE TABLE decisions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id           uuid NOT NULL REFERENCES domains(id),
    question            text NOT NULL,
    chosen              text NOT NULL,
    alternatives        jsonb,
    reasons             text,
    revisit_conditions  jsonb,
    decided_at          timestamptz NOT NULL,
    source_event_id     uuid NOT NULL REFERENCES events(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- assumptions
CREATE TABLE assumptions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    decision_id     uuid NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    statement       text NOT NULL,
    status          text NOT NULL DEFAULT 'held'
                    CHECK (status IN ('held', 'violated', 'unknown')),
    last_checked_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- relationships
-- First-class polymorphic edges in Postgres; no graph DB (review §9).
-- from_id/to_id are polymorphic (no FK) — integrity is the writer's contract.
CREATE TABLE relationships (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id       uuid NOT NULL REFERENCES domains(id),
    from_type       text NOT NULL,
    from_id         uuid NOT NULL,
    relation        text NOT NULL,   -- blocked_by/concerns/affects/owns/supported_by/produced_by/… (extensible)
    to_type         text NOT NULL,
    to_id           uuid NOT NULL,
    source_event_id uuid NOT NULL REFERENCES events(id),
    confidence      numeric CHECK (confidence >= 0 AND confidence <= 1),
    valid_from      timestamptz,
    valid_until     timestamptz,
    metadata        jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relationships_from_idx ON relationships (from_type, from_id);
CREATE INDEX relationships_to_idx ON relationships (to_type, to_id);
CREATE INDEX relationships_relation_idx ON relationships (relation);

-- ---------------------------------------------------------------- evidence
-- Minimal provenance primitive (review §20); links are relationships edges
-- (decision/assumption/candidate → supported_by/derived_from → evidence).
CREATE TABLE evidence (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id   uuid NOT NULL REFERENCES domains(id),
    source_type text NOT NULL,
    source_ref  text NOT NULL,
    claim       text NOT NULL,
    observed_at timestamptz NOT NULL,  -- temporal validity carried here (review §19)
    confidence  numeric CHECK (confidence >= 0 AND confidence <= 1),
    metadata    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- memory_candidates
-- D2 FLAG RESOLVED BY DECISION (data-model.md §9.2): plan §7 omits domain_id,
-- but promotion gate 2 (plan §6.2) performs a domain check on every candidate,
-- so the column is added here as NOT NULL — gate 2 reads a real column, never
-- digs through payload/provenance jsonb.
CREATE TABLE memory_candidates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id       uuid NOT NULL REFERENCES domains(id),
    proposed_class  text NOT NULL,    -- classifier vocabulary: discard|working|episodic|semantic|preference|commitment|decision|assumption|procedural|policy (plan §6.2); left unconstrained — eval may relabel (docs/memory-architecture.md §8.1)
    gated_class     text,             -- post-gate class; null until the gate runs
    assertion_kind  text NOT NULL
                    CHECK (assertion_kind IN ('observed', 'user_declared', 'externally_sourced', 'model_inferred', 'computed')),
    payload         jsonb NOT NULL,
    provenance      jsonb NOT NULL,   -- gate 1: source event/run, model, prompt version
    gate_result     jsonb,            -- null until the gate has run
    status          text NOT NULL DEFAULT 'proposed',  -- vocabulary not enumerated in plan §7 — unconstrained in v1
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_candidates_status_idx ON memory_candidates (status);

-- ---------------------------------------------------------------- procedures
-- Index rows only; canonical bodies are files in top-level procedures/ (A17).
CREATE TABLE procedures (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    version    integer NOT NULL,
    body_ref   text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (name, version)
);

-- ---------------------------------------------------------------- capability_grants
-- Deny by default; the row stores only token_hash — the opaque capability
-- token itself never touches the DB (review §5; ADR-0007 extended).
CREATE TABLE capability_grants (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id uuid NOT NULL REFERENCES principals(id),
    run_id       uuid REFERENCES runs(id),
    capability   text NOT NULL,
    resource     text NOT NULL,
    domain_id    uuid NOT NULL REFERENCES domains(id),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    token_hash   text NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- escalations
-- D2 FLAG KEPT AS-IS (data-model.md §9.1): plan §7 retains blocked_run_ids[]
-- even though review §9 removed arrays from commitments — the plan is canonical
-- here. Array elements cannot FK to runs(id); integrity is the writer's contract.
-- If escalation→run links ever need graph queries, they become relationships
-- edges in a later migration.
CREATE TABLE escalations (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                 uuid NOT NULL REFERENCES runs(id),
    reason                 text NOT NULL CHECK (reason IN (
                             'ambiguous_requirements', 'approval_required',
                             'missing_credentials', 'architecture_decision',
                             'missing_external_information', 'system_failure')),
    urgency                text,      -- vocabulary not enumerated in plan §7 — unconstrained in v1
    consequence_of_waiting text,
    blocked_run_ids        uuid[] NOT NULL DEFAULT '{}',
    est_human_minutes      integer,
    status                 text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'batched', 'resolved')),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escalations_status_idx ON escalations (status);

-- ---------------------------------------------------------------- human_waits
-- Raw intervals; human_blocked_ms is a projection/metric, never stored
-- (review §14; data-model.md §5.11).
CREATE TABLE human_waits (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        uuid NOT NULL REFERENCES runs(id),
    escalation_id uuid REFERENCES escalations(id),
    started_at    timestamptz NOT NULL,
    resolved_at   timestamptz,
    reason        text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX human_waits_run_idx ON human_waits (run_id);

-- ---------------------------------------------------------------- artifacts
-- Phase 1 = Option A: small textual artifacts in Postgres so pg_backup covers
-- them (review §11). file backend stores path + sha256 under data/artifacts/.
CREATE TABLE artifacts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          uuid NOT NULL REFERENCES runs(id),
    kind            text NOT NULL,    -- brief/extraction_output/eval_report/…
    storage_backend text NOT NULL DEFAULT 'postgres'
                    CHECK (storage_backend IN ('postgres', 'file', 'object')),
    content         text,
    file_path       text,
    sha256          text,
    domain_id       uuid NOT NULL REFERENCES domains(id),
    sensitivity     text NOT NULL,
    source_event_id uuid REFERENCES events(id),  -- nullable: artifact may be written before its event exists
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (storage_backend = 'postgres' AND content IS NOT NULL)
        OR (storage_backend = 'file' AND file_path IS NOT NULL AND sha256 IS NOT NULL)
        OR (storage_backend = 'object')
    )
);
CREATE INDEX artifacts_run_idx ON artifacts (run_id);

-- ---------------------------------------------------------------- action_intents
-- Intent-side states (cleanup §5): proposed → approved → prepared | cancelled.
-- grant_id is nullable: an intent can be proposed before a grant exists;
-- grant possession is enforced at attempt time (M4: grant-less action → 403).
CREATE TABLE action_intents (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id    uuid NOT NULL REFERENCES runs(id),
    grant_id  uuid REFERENCES capability_grants(id),
    capability text NOT NULL,
    resource  text NOT NULL,
    domain_id uuid NOT NULL REFERENCES domains(id),
    payload   jsonb,
    status    text NOT NULL DEFAULT 'proposed'
              CHECK (status IN ('proposed', 'approved', 'prepared', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- action_attempts
-- Execution-side states (cleanup §5); one intent → many attempts; retries and
-- reconciliation APPEND — an earlier ambiguous attempt is never overwritten
-- (review §6). idempotency_key is the provider's key where available; retries
-- reuse it, so it is deliberately NOT unique here.
CREATE TABLE action_attempts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id      uuid NOT NULL REFERENCES action_intents(id),
    provider       text NOT NULL,
    idempotency_key text,
    started_at     timestamptz NOT NULL,
    finished_at    timestamptz,
    outcome        text NOT NULL DEFAULT 'executing'
                   CHECK (outcome IN ('executing', 'succeeded', 'failed', 'unknown', 'reconciled')),
    provider_ref   text,
    error          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (intent_id, started_at)   -- append-only history, one attempt per intent per start
);

-- ---------------------------------------------------------------- audit_log
-- A pre-effect entry proves intent, never completion; after a lost response
-- the honest state is attempt outcome 'unknown' until reconciliation (review §25).
-- actor is polymorphic (principal/run/user/system) per plan §7 — a text actor
-- string in v1; structured actor columns are a later migration if needed.
CREATE TABLE audit_log (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor             text NOT NULL,
    action            text NOT NULL,
    inputs_ref        text,
    outputs_ref       text,
    grant_id          uuid REFERENCES capability_grants(id),
    action_intent_id  uuid REFERENCES action_intents(id),
    action_attempt_id uuid REFERENCES action_attempts(id),  -- nullable — pre-effect entries have none
    reversible        boolean NOT NULL,
    occurred_at       timestamptz NOT NULL DEFAULT now(),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at);

-- ---------------------------------------------------------------- model_calls
-- A row existing implies the model-egress check passed for that call —
-- denials raise + audit BEFORE dispatch and never reach this ledger
-- (plan §9; ADR-0012). result_status vocabulary not enumerated in plan §7 —
-- unconstrained in v1.
CREATE TABLE model_calls (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id         uuid NOT NULL REFERENCES runs(id),
    provider       text NOT NULL,
    model          text NOT NULL,
    prompt_version text,
    in_tokens      integer NOT NULL,
    out_tokens     integer NOT NULL,
    cost_usd       numeric NOT NULL,
    latency_ms     integer NOT NULL,
    result_status  text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_calls_run_idx ON model_calls (run_id);
