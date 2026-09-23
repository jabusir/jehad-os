-- 023_gmail_content.sql — Gmail message-content ingestion (ADR-0016;
-- roadmap docs/plans/delegate-watch-roadmap.md §19 GC0).
--
-- Extends the Gmail sensor's authorized observation depth from metadata-only
-- to bounded message-content: a `gmail_messages` SOURCE record (evidence,
-- never canonical truth; source_trust_class='untrusted_external'). Bodies
-- NEVER enter events / audit_log / model_calls / metrics / logs — those
-- carry ids and references only (scan-tested).
--
-- Retention is the primary control (data minimization, ADR-0016 §5): rows
-- are deleted by the retention sweeper once older than the policy window
-- (sensors.gmail content_retention_days, owner default 14) unless pinned
-- (pinned=true) by a durable consumer (outcome/verifier artifact pinning
-- lands with the outcome wave — until then nothing pins). The source record
-- is distinguishable from facts/commitments/outcomes/memory by construction:
-- promotion gates, not this table, create semantic rows (ADR-0004).
--
-- Migration 015's health CHECK pins `gmail_sync_state.health` keys to
-- exactly five dimension names (subset-containment `<@`; '{}' passes). The
-- content pipeline adds a SIXTH dim, `content` (fetch/parse health for the
-- body lane), so the constraint is replaced here with the extended key
-- vocabulary. Values keep the healthy|degraded|failed vocabulary.

-- 1. Health dims: admit the `content` dimension (T17/GC0).
-- 015 declared the two dim CHECKs inline, so Postgres auto-named them
-- `gmail_sync_state_health_check` (key dims) and `gmail_sync_state_health_check1`
-- (value states). Both are replaced with one named constraint covering both.
ALTER TABLE gmail_sync_state DROP CONSTRAINT gmail_sync_state_health_check;
ALTER TABLE gmail_sync_state DROP CONSTRAINT gmail_sync_state_health_check1;
ALTER TABLE gmail_sync_state ADD CONSTRAINT gmail_sync_state_health_dims_check CHECK (
    jsonb_path_query_array(health, '$.keyvalue().key')
      <@ '["process", "credential", "cursor", "decode", "quota", "content"]'
    AND
    jsonb_path_query_array(health, '$.keyvalue().value')
      <@ '["healthy", "degraded", "failed"]'
);

-- 2. The bounded content source record.
CREATE TABLE gmail_messages (
    id                uuid PRIMARY KEY,
    -- Gmail identity + observation provenance (ids only — the body lives
    -- in body_text below, nowhere else).
    gmail_message_id  text NOT NULL UNIQUE,
    thread_id         text NOT NULL,
    observed_history_id bigint,
    -- Ownership + boundary (ADR-0016 §5; directive §15 principal isolation).
    -- The sensor is the owner's inbox; scoping is enforced at every read.
    principal_id      text NOT NULL DEFAULT 'josctl',
    domain_id         text NOT NULL DEFAULT 'personal',
    -- Envelope headers (normalized; attachment METADATA only — never
    -- downloaded).
    from_addr         text,
    to_addrs          jsonb NOT NULL DEFAULT '[]'::jsonb,
    subject           text,
    snippet           text,
    -- The normalized, sanitized body (HTML → safe text at the adapter;
    -- truncation at max_body_bytes is the ingest policy's job).
    body_text         text,
    body_bytes        integer NOT NULL DEFAULT 0,
    body_truncated    boolean NOT NULL DEFAULT false,
    content_sha256    text,
    attachments       jsonb NOT NULL DEFAULT '[]'::jsonb,
    internal_date     timestamptz,
    -- Trust + lifecycle.
    source_trust_class text NOT NULL DEFAULT 'untrusted_external'
                       CHECK (source_trust_class = 'untrusted_external'),
    pinned            boolean NOT NULL DEFAULT false,
    ingested_at       timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX gmail_messages_principal_thread_idx ON gmail_messages (principal_id, thread_id);
CREATE INDEX gmail_messages_principal_from_idx   ON gmail_messages (principal_id, from_addr);
CREATE INDEX gmail_messages_internal_date_idx    ON gmail_messages (internal_date DESC);
CREATE INDEX gmail_messages_ingested_at_idx      ON gmail_messages (ingested_at);

-- Body-text CHECK: bodies may be absent (fetch/parse failure → metadata
-- remains, honest coverage), but when present they are bounded non-empty
-- text. Guard against jsonb smuggling — body_text is text by type; this
-- CHECK documents the intent and keeps empty-string payloads out.
ALTER TABLE gmail_messages ADD CONSTRAINT gmail_messages_body_text_check
    CHECK (body_text IS NULL OR length(body_text) > 0);
