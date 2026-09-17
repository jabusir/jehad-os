-- Down path for 003 (tested during development; forward-only in production).
-- Fails if event-less evidence links exist — correct: those rows have no
-- provenance under the old constraint.

ALTER TABLE relationships ALTER COLUMN source_event_id SET NOT NULL;
