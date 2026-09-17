-- 003_evidence_links.sql — M5D: evidence links via relationships edges.
--
-- 001 made relationships.source_event_id NOT NULL because plan §7 lists it as
-- a key column; but evidence links (decision/assumption/memory_candidate →
-- supported_by/derived_from/contradicts → evidence, review §20; data-model.md
-- §5.8) have no source event of their own — their provenance IS the evidence
-- row they point at. Forcing an event would mean minting synthetic events
-- that never occurred, corrupting the event log (plan §8: events are real
-- occurrences). The column becomes nullable; every other relationships writer
-- keeps supplying it.
--
-- The plan's column list (plan §7) does not state nullability; data-model.md
-- §9.3 leaves such type details to migrations. This is a nullability fix, not
-- a schema drift.

ALTER TABLE relationships ALTER COLUMN source_event_id DROP NOT NULL;
