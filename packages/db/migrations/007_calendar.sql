-- 007_calendar.sql — E3 Lane 1: Google Calendar read-only sensor.
-- `calendar_events` is the world-model PROJECTION of the calendar (current
-- believed state per Google event); `calendar_sync_state` is the sync cursor
-- (incremental syncToken). Google Calendar stays authoritative for the event
-- itself — Jehad OS never writes back (read-only sensor).
--
-- Provenance: every projection row carries source_event_id → the observation
-- event (calendar.event.created|updated|cancelled) that last changed it, so
-- the event log can reconstruct WHY the world model believes each row. Source
-- references (google_calendar_id, google_event_id, iCalUID in metadata) are
-- retained — this is not a blob store.
--
-- Time semantics: start_time/end_time are calendar-native structured time
-- (date-trust policy: resolutionMethod calendar-native is trusted outright).
-- All-day events (date only, no dateTime) land as UTC midnight of that date.
-- Nullable: minimal cancelled payloads (recurring exceptions) may omit them;
-- classification then falls back to the prior row's values.

CREATE TABLE calendar_events (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    google_event_id    text NOT NULL,
    google_calendar_id text NOT NULL,             -- source ref (e.g. "primary" or the calendar email)
    status             text NOT NULL
                       CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
    summary            text NOT NULL DEFAULT '',  -- untitled events store ''
    start_time         timestamptz,
    end_time           timestamptz,
    timezone           text,                      -- calendar-native zone (e.g. America/New_York)
    attendees          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- emails+names ONLY (never response metadata)
    location           text,
    metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- sparse: recurring flag, hangout link, iCalUID
    source_event_id    uuid NOT NULL REFERENCES events(id), -- provenance: observation that last updated this row
    content_hash       text NOT NULL,             -- sha256 of canonical projected content; change detection
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (google_calendar_id, google_event_id)
);

-- Today's-schedule scan for the morning brief (start within a given day).
CREATE INDEX calendar_events_start_idx ON calendar_events (start_time);
-- Status filter companions (cancelled rows stay for history, never schedule).
CREATE INDEX calendar_events_status_idx ON calendar_events (status);

-- Singleton cursor row (id pinned to 1): one calendar in v1 (personal domain).
CREATE TABLE calendar_sync_state (
    id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    calendar_id     text NOT NULL,
    sync_token      text,                          -- null → next sync is a full sync
    last_synced_at  timestamptz,
    last_page_count integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
