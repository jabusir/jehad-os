-- 017_calendar_occurrence.sql — W5(b) (plan §7 W5(b), §5 invariant 7):
-- calendar occurrence state. Occurrence is a SEPARATE fact from calendar
-- status: Google's `status` stays Google's belief about the event;
-- `occurrence` records what Jehad OS can honestly claim about whether the
-- event actually happened. Time passing is NEVER evidence: the hourly
-- sweep only ever labels past null-occurrence rows
-- `scheduled_past_unverified` (the floor). ONLY an explicit principal
-- declaration graduates to observed_occurred / observed_missed
-- (kind = 'user_declared'); cross-source signals (e.g., a gmail
-- confirmation) PROPOSE only (kind = 'cross_source_proposed') and never
-- graduate. The CHECKs below pin that law at the database: an observed_*
-- occurrence can only exist alongside user_declared provenance, so no
-- code path — sweep, sensor, or bug — can silently fabricate an
-- observation.
--
-- occurrence_confirmed_by shape: {kind, source, at} — kind vocabulary
-- pinned here; `source` names the declaring principal (user_declared) or
-- the proposing signal source (cross_source_proposed); `at` is an ISO
-- instant.

ALTER TABLE calendar_events
  ADD COLUMN occurrence text
    CHECK (occurrence IN ('scheduled_past_unverified', 'observed_occurred', 'observed_missed')),
  ADD COLUMN occurrence_confirmed_by jsonb
    CHECK (
      occurrence_confirmed_by IS NULL OR (
        jsonb_typeof(occurrence_confirmed_by) = 'object' AND
        occurrence_confirmed_by->>'kind' IN ('user_declared', 'cross_source_proposed')
      )
    ),
  ADD CONSTRAINT calendar_events_occurrence_graduation_check
    CHECK (
      occurrence IS NULL OR occurrence = 'scheduled_past_unverified' OR
      (occurrence_confirmed_by IS NOT NULL AND occurrence_confirmed_by->>'kind' = 'user_declared')
    );

-- Sweep support: ungraduated rows with a known end time, ordered by
-- end_time. "End time in the past" is applied at query time — a partial
-- index predicate must be immutable, and `end_time < now()` is not.
CREATE INDEX calendar_events_occurrence_sweep_idx
  ON calendar_events (end_time)
  WHERE (occurrence IS NULL OR occurrence = 'scheduled_past_unverified')
    AND end_time IS NOT NULL;
