-- 005_commitments_temporal.sql — Wave 6 (extraction v3; owner temporal directive
-- 2026-09-17): commitments.temporal.
--
-- The LLM extracts the temporal EXPRESSION; a deterministic normalizer
-- resolves it. The full TemporalProvenance block (raw expression, anchor time
-- + timezone, normalized date, resolution status/method/confidence,
-- normalizer version) lands here so (a) due_at is auditable back to the exact
-- phrase, and (b) re-normalization can heal stored rows without re-extraction.
-- NULL for rows created before v3 or without a temporal block; due_at remains
-- the query-facing column (overdue logic reads due_at, never the model).

ALTER TABLE commitments ADD COLUMN temporal jsonb NULL;
