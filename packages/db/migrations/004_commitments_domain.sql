-- 004_commitments_domain.sql — Wave 5 (M6A flag resolution): commitments.domain_id.
--
-- 001 deliberately omitted domain_id from commitments (plan §7 derives it via
-- source_event_id → events.domain_id) and flagged exactly this for M6 review:
-- every domain-scoped commitment query pays the events join, and domain
-- isolation rests on a join rather than a column. The owner approved adding
-- it now. Backfill from the source event is total — source_event_id is NOT
-- NULL with an FK to events, and events.domain_id is NOT NULL — so the column
-- tightens to NOT NULL in the same migration.

ALTER TABLE commitments ADD COLUMN domain_id uuid REFERENCES domains(id);

UPDATE commitments c
SET domain_id = e.domain_id
FROM events e
WHERE c.source_event_id = e.id;

ALTER TABLE commitments ALTER COLUMN domain_id SET NOT NULL;

CREATE INDEX commitments_domain_status_idx ON commitments (domain_id, status);
