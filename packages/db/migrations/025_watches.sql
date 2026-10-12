-- 025_watches.sql — the Watch primitive (product-reset plan §4;
-- ADR-0018). The reserved 025 number (delegate-watch-roadmap §19-W0) is
-- honored: this table lands AFTER 026-028 were written (they never
-- depended on it), so on an existing database it applies as a new pending
-- migration; on a fresh database it applies in lexical position between
-- 024 and 026. Both paths are proven empirically before this file is
-- committed (plan §16, W0).
--
-- A Watch is a durable, principal-scoped, typed-predicate condition over
-- trusted sources (gmail / outcome / home_assistant). Creation authority
-- is the owner (UI/API/CLI) — never chat, never model output, never email
-- content. The predicate is a closed, versioned, non-executable
-- vocabulary validated by packages/core/src/watches/predicates.ts (same
-- discipline as outcome_waits, ADR-0017 §1.2): unknown fields are
-- rejected, never coerced. W1 does not build watch evaluation code; this
-- migration lands with W1 only so that the W0-proven SQL is byte-for-byte
-- what production applies (proven-draft sha256 binding, ADR-0018).
--
-- Match records are events, not rows: each match emits watch.triggered
-- with externalId watch:<watchId>:<sourceEventRowId>, riding acceptEvent's
-- idempotency dedupe (plan §6). watermark is the per-source evaluation
-- cursor; eval_state carries duration/absence semantics state.

CREATE TABLE watches (
    id                 uuid PRIMARY KEY,
    principal_id       uuid NOT NULL REFERENCES principals(id),
    ref                text NOT NULL,                -- 4-char Crockford base32, mint-once with
                       -- collision retry; principal-scoped uniqueness (human-typed refs
                       -- must not collide across principals)
    title              text NOT NULL,
    status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN (
                         'draft', 'active', 'paused',
                         'satisfied', 'expired', 'failed', 'cancelled')),
    source_type        text NOT NULL
                       CHECK (source_type IN ('gmail', 'outcome', 'home_assistant')),
    predicate          jsonb NOT NULL,               -- typed, versioned, non-executable (plan §4)
    evaluation_mode    text NOT NULL DEFAULT 'event'
                       CHECK (evaluation_mode IN ('event', 'scheduled', 'hybrid')),
    attention_policy   jsonb NOT NULL DEFAULT '{}'::jsonb,
                       -- {level: silent|inbox|digest|interrupt, cooldownMinutes?, safetyClass?}
                       -- level 'silent' records events/match state only and opens NO
                       -- attention item (plan §5); items exist only at inbox/digest/interrupt
    completion_policy  jsonb NOT NULL DEFAULT '{}'::jsonb,
                       -- {completeOnMatch?: bool, expiresAt?: timestamptz}
    watermark          jsonb NOT NULL DEFAULT '{}'::jsonb,
                       -- per-source eval cursor {eventType, occurredAt, eventId}
    eval_state         jsonb,                        -- carried state for duration/absence semantics
    source_refs        jsonb,                        -- bound objects {threadRef?, outcomeRef?, entityRef?}
    pause_reason       text
                       CHECK (pause_reason IS NULL OR pause_reason IN (
                         'source_gone', 'eval_error_budget', 'owner_dormant',
                         'owner_paused', 'content_lane_disabled')),
    last_evaluated_at  timestamptz,
    last_match_at      timestamptz,
    next_evaluation_at timestamptz,
    failure_reason     text,
    created_by         text NOT NULL DEFAULT 'owner-ui',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz,                  -- default 30d: nothing watches forever silently
    satisfied_at       timestamptz,
    UNIQUE (principal_id, ref)
);

CREATE INDEX watches_active_idx ON watches (principal_id, source_type, status);
