-- TEST-ONLY fixture (Lane C, Phase A): the three iMessage-sensor tables from
-- the binding migration-010 sketch (docs/plans/ig-phase-a-contracts.md).
-- Lane B owns migration 010; until it lands in a worktree, the delivered-
-- fingerprint test setup creates these from this file. CREATE TABLE IF NOT
-- EXISTS makes the fixture a no-op once the real migration exists. This file
-- is NEVER a migration and must not be added to packages/db/migrations.

CREATE TABLE IF NOT EXISTS imessage_transport_events (
  id uuid PRIMARY KEY,
  guid text NOT NULL UNIQUE,
  rowid bigint NOT NULL,
  is_from_me boolean NOT NULL,
  transport_handle text NOT NULL,
  service text,
  has_text boolean,
  has_attributed_body boolean,
  decoded_status text NOT NULL,
  text_length integer,
  normalized_text_sha256 text,
  fingerprint_id uuid,
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sent_message_fingerprints (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL,
  recipient text NOT NULL,
  rendered_text_sha256 text NOT NULL,
  delivered_at timestamptz NOT NULL,
  imessage_guid text
);

CREATE TABLE IF NOT EXISTS imessage_sensor_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cursor_rowid bigint NOT NULL,
  db_generation text,
  schema_fingerprint text,
  health_process text,
  health_database text,
  health_decoder text,
  health_cursor text,
  health_shadow text,
  updated_at timestamptz NOT NULL
);
