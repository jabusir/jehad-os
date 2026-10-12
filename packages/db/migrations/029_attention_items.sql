-- 029_attention_items.sql — the AttentionItem primitive (product-reset plan
-- §5; ADR-0018). The durable, principal-scoped record of things waiting on
-- the owner; delivery (iMessage/Today) is a best-effort projection that
-- never mutates or resolves the row (ADR-0018 §1.1).
--
-- Identity is UNIQUE (principal_id, source_type, source_object_id,
-- fingerprint); the service's three-branch write (no-row → insert / open →
-- bump / closed → reopen, ADR-0018 §1.3) collapses duplicate producer
-- occurrences into one row. `state` is explicit: seen ≠ resolved, snooze is
-- a state (snoozed_until), never a hidden timer. There is NO 'silent' level
-- — an item exists only when it requires attention (ADR-0018 §1.2).
-- change_fingerprint is producer-supplied occurrence identity (gmail
-- messageId; home entity_id+last_changed; outcome id+status — §1.4): never
-- rendered text, never an event row id. Terminal rows (resolved/dismissed)
-- are retained 30 days for metrics, then purged by the liveness sweep;
-- open rows are never age-deleted.

CREATE TABLE attention_items (
    id                     uuid PRIMARY KEY,
    principal_id           uuid NOT NULL REFERENCES principals(id),
    source_type            text NOT NULL CHECK (source_type IN ('watch','outcome','system')),
    source_object_id       text NOT NULL,
    fingerprint            text NOT NULL,
    kind                   text NOT NULL CHECK (kind IN
                             ('outcome.ready','outcome.blocked','outcome.failed',
                              'watch.match','system.missed_evidence','system.scan_gap')),
    state                  text NOT NULL DEFAULT 'open'
                           CHECK (state IN ('open','seen','snoozed','resolved','dismissed')),
    level                  text NOT NULL DEFAULT 'inbox' CHECK (level IN ('inbox','digest','interrupt')),
    safety_class           text NOT NULL DEFAULT 'none' CHECK (safety_class IN ('none','security','water','safety')),
    title                  text NOT NULL,
    summary                text NOT NULL,
    why_it_matters         text,
    evidence_refs          jsonb NOT NULL DEFAULT '[]'::jsonb,
    actions                jsonb NOT NULL DEFAULT '[]'::jsonb,
    occurrences            integer NOT NULL DEFAULT 1,
    change_fingerprint     text,
    first_raised_at        timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    seen_at                timestamptz,
    snoozed_until          timestamptz,
    snooze_count           integer NOT NULL DEFAULT 0,
    resolved_at            timestamptz,
    resolved_by            text CHECK (resolved_by IS NULL OR resolved_by IN ('owner','producer','liveness','system')),
    resolution_reason      text,
    last_delivered_at      timestamptz,
    delivery_attempts      integer NOT NULL DEFAULT 0,
    last_delivery_attempt_at timestamptz,
    UNIQUE (principal_id, source_type, source_object_id, fingerprint)
);
CREATE INDEX attention_open_idx ON attention_items (principal_id, state, updated_at DESC);
