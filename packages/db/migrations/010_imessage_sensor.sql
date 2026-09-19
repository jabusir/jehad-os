-- 010_imessage_sensor.sql — iMessage gateway Phase A (Lane B): the shadow
-- sensor's control-plane state (docs/plans/imessage-gateway.md §7 row A;
-- docs/plans/ig-phase-a-contracts.md — migration sketch is binding shape).
--
-- PRIVACY RULE (shadow phase): third-party message CONTENT is never ingested.
-- imessage_transport_events stores metadata, lengths, hashes, and decoder
-- status ONLY — there is deliberately no content column anywhere here, and
-- the decoded-text hash is stored ONLY for is_from_me rows (loop
-- correlation; CHECK below + the ingest service both enforce it).
--
-- sent_message_fingerprints is the §5.2 loop-defense SECONDARY guard: the
-- deliverer records the rendered-text hash at delivery time (Lane C); the
-- sensor correlation backfills the Apple GUID when the same hash reappears
-- as an is_from_me observation inside the delivery→observation window. The
-- PRIMARY loop guard stays the sensor-side is_from_me filter — the
-- fingerprint is defense-in-depth, never the first gate.
--
-- imessage_sensor_state is the singleton cursor + five-dimension health
-- projection (process/database/decoder/cursor/shadow). Health dims stay
-- NULL until the first health report; the upserts are column-scoped so
-- cursor and health writes never clobber each other.
--
-- notifications: kind widens with 'reply' (the §4 conjunction subject) and
-- gains the four nullable reply-rule support columns. 'reply' is NEVER a
-- member of policy autoApproveKinds — that invariant is enforced in code
-- (notifications config drop-filters it; createNotification ignores the
-- kind list for replies) and guard-tested. Existing rows are unaffected:
-- every new column is nullable.

-- Reply vocabulary: kind=reply exists for the conjunction rule only.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom', 'calendar-change', 'reply'));

-- Reply conjunction support columns (§4): all nullable, legacy rows null.
ALTER TABLE notifications ADD COLUMN surface text;
ALTER TABLE notifications ADD COLUMN requesting_principal_id uuid REFERENCES principals(id);
ALTER TABLE notifications ADD COLUMN conversation_principal_id uuid REFERENCES principals(id);
ALTER TABLE notifications ADD COLUMN third_party_recipient boolean;

-- §5.2 fingerprints — one row per delivered send (written by the Lane C
-- delivered-report handler; correlated by the Lane B ingest service).
CREATE TABLE sent_message_fingerprints (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id      uuid NOT NULL REFERENCES notifications(id),
    recipient            text NOT NULL,
    rendered_text_sha256 text NOT NULL,
    delivered_at         timestamptz NOT NULL,
    imessage_guid        text                              -- backfilled by sensor correlation
);

-- Correlation scan: hash + delivery-time window.
CREATE INDEX sent_message_fingerprints_hash_delivered_idx
    ON sent_message_fingerprints (rendered_text_sha256, delivered_at);
CREATE INDEX sent_message_fingerprints_notification_idx
    ON sent_message_fingerprints (notification_id);

-- Transport observations (shadow): metadata/hashes/lengths ONLY. guid is
-- the idempotency key — the sensor is at-least-once, the control plane is
-- exactly-once (ON CONFLICT DO NOTHING at ingest).
CREATE TABLE imessage_transport_events (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    guid                   text NOT NULL UNIQUE,           -- Apple GUID = idempotency key
    rowid                  bigint NOT NULL,
    is_from_me             boolean NOT NULL,
    transport_handle       text NOT NULL,
    service                text,
    has_text               boolean,
    has_attributed_body    boolean,
    decoded_status         text NOT NULL
                           CHECK (decoded_status IN ('ok', 'skipped-malformed', 'skipped-unknown', 'not-attempted', 'own-ok')),
    text_length            integer,
    normalized_text_sha256 text,                           -- ONLY for is_from_me rows (privacy rule)
    fingerprint_id         uuid REFERENCES sent_message_fingerprints(id),  -- set when correlated
    observed_at            timestamptz NOT NULL,
    ingested_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (normalized_text_sha256 IS NULL OR is_from_me)
);

-- Cursor ordering + shadow observation scans.
CREATE INDEX imessage_transport_events_rowid_idx ON imessage_transport_events (rowid);
CREATE INDEX imessage_transport_events_observed_idx ON imessage_transport_events (observed_at);
CREATE INDEX imessage_transport_events_fingerprint_idx ON imessage_transport_events (fingerprint_id);

-- Singleton sensor state (singleton pinned to true). Health CHECKs pass
-- while NULL (SQL CHECK semantics) and constrain the vocabulary once set.
CREATE TABLE imessage_sensor_state (
    singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    cursor_rowid       bigint NOT NULL,
    db_generation      text,
    schema_fingerprint text,
    health_process     text CHECK (health_process IN ('healthy', 'degraded', 'failed')),
    health_database    text CHECK (health_database IN ('healthy', 'degraded', 'failed')),
    health_decoder     text CHECK (health_decoder IN ('healthy', 'degraded', 'failed')),
    health_cursor      text CHECK (health_cursor IN ('healthy', 'degraded', 'failed')),
    health_shadow      text CHECK (health_shadow IN ('healthy', 'degraded', 'failed')),
    updated_at         timestamptz NOT NULL
);
