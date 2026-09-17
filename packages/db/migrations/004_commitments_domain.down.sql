-- Down path for 004 (tested during development; forward-only in production).
-- Drops the column (and its index/constraint with it); the value is
-- re-derivable via source_event_id → events.domain_id, so no data is lost.

DROP INDEX IF EXISTS commitments_domain_status_idx;
ALTER TABLE commitments DROP COLUMN IF EXISTS domain_id;
