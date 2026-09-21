-- 016_calibration.sql — the calibration domain (Lane C1; owner's CALIBRATION
-- spec): the daily accuracy check.
--
-- One OPEN calibration item per (principal, owner-local civil day, surface)
-- carrying a source-aware COUNTS snapshot (jsonb summary — counts only,
-- never raw content), the owner's 1-5 accuracy rating, and free-text
-- "missed" verdicts through the EXISTING append-only feedback table
-- (extended additively — never duplicated).
--
-- feedback changes (all additive/nullable; verdict 'missed' already existed
-- since 008 — the CHECK extension below widens item_type with
-- 'calibration', the 009 notifications precedent):
--   item_type           + 'calibration'      (drop+recreate CHECK)
--   target_type          text NULL CHECK (whole_day | specific_item | source |
--                        inference | brief | attention_item)
--   target_ref           text NULL           (review ref / source key / item id)
--   source_attribution   text NULL           (miss category on missed rows —
--                        documented deviation: no connected source feeds a
--                        miss, so the column carries classifyMiss output)
--   calibration_item_id  uuid NULL REFERENCES calibration_items(id)
--
-- Missed feedback NEVER creates memory candidates (spec §20) — no candidate
-- write path exists anywhere in the calibration service.

CREATE TABLE calibration_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id   uuid NOT NULL REFERENCES principals(id),
    period_date    date NOT NULL,               -- owner-local civil day (BRIEF_TIMEZONE)
    surface        text NOT NULL DEFAULT 'imessage',
    status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'superseded')),
    summary        jsonb NOT NULL,              -- source-aware counts snapshot (no raw content)
    prompt_sent_at timestamptz NOT NULL,
    rated_at       timestamptz,
    rating         smallint CHECK (rating BETWEEN 1 AND 5),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One OPEN item per (principal, period, surface); superseding frees the slot.
CREATE UNIQUE INDEX calibration_items_open_unique
    ON calibration_items (principal_id, period_date, surface)
    WHERE status = 'open';

-- Eligibility scans + weekly rollups.
CREATE INDEX calibration_items_principal_period_idx
    ON calibration_items (principal_id, period_date);
CREATE INDEX calibration_items_principal_rating_idx
    ON calibration_items (principal_id, rating);

-- feedback: widen the item_type CHECK ('calibration' — 009 precedent).
ALTER TABLE feedback DROP CONSTRAINT feedback_item_type_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_item_type_check
    CHECK (item_type IN ('notification', 'attention_item', 'review_item', 'brief_section', 'event', 'calibration'));

-- feedback: additive nullable targeting columns.
ALTER TABLE feedback ADD COLUMN target_type text
    CHECK (target_type IN ('whole_day', 'specific_item', 'source', 'inference', 'brief', 'attention_item'));
ALTER TABLE feedback ADD COLUMN target_ref text;
ALTER TABLE feedback ADD COLUMN source_attribution text;
ALTER TABLE feedback ADD COLUMN calibration_item_id uuid REFERENCES calibration_items(id);

CREATE INDEX feedback_calibration_item_idx ON feedback (calibration_item_id);

-- Notification vocabulary: kind + source_type 'calibration' (009 precedent).
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('brief', 'escalation', 'custom', 'calendar-change', 'reply', 'calibration'));

ALTER TABLE notifications DROP CONSTRAINT notifications_source_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_source_type_check
    CHECK (source_type IN ('escalation', 'brief', 'run', 'calendar', 'calibration'));
