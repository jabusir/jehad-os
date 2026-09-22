-- 021_reminders.sql — W6-phase-2 reminder lifecycle (w6-phase-2-reminders.md,
-- lane R1): the `reminders` table is the canonical store for the proactive
-- promise lifecycle — remind → probe → resolve/escalate/renegotiate/park.
-- A reminder is NOT a record of something said; it is a promise the SYSTEM
-- initiates contact on: armed rows carry a next_touch_at the 15-minute sweep
-- fires against, and replies move the row through completed (user_reply or
-- manual), renegotiated (escalations FORGIVEN to 0, renegotiations bumped,
-- still armed), parked (nudge cap reached — resurfaces only in the evening
-- brief), or cancelled ("stop reminding me").
--
-- Column vocabulary:
--   principal    — text principal id (same convention as feedback.created_by);
--                  isolation is enforced at the query layer (list/count are
--                  per-principal; the sweep feed is cross-principal).
--   title        — sanitized by the caller, stored as-is.
--   commitment_id— nullable link to the captured commitment; a commitment
--                  deletion never deletes the reminder (SET NULL).
--   due_date     — the obligation date, principal-local PT civil date.
--   due_time     — explicit clock time if the user gave one (timestamptz);
--                  the data layer pins it to America/Los_Angeles wall time
--                  on due_date (DST handled by Postgres' tz database).
--   next_touch_* — the scheduled touch (morning | probe | nudge); nulled on
--                  every terminal/pausing transition.
--   escalations  — count of firmer nudges since the last forgiveness.
--   renegotiations — count of abide moves ("gonna do it tomorrow").
--   thread_id    — interaction thread the touches/probe ride on.
--   resolved_*/parked_at/cancelled_* — transition provenance.
--
-- Indexes: the sweep scans armed rows by due touch; briefs/day-state scan a
-- principal's rows by status. Named per the 017/018 convention; plain CREATE
-- INDEX (the runner owns idempotency via schema_migrations).

CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal text NOT NULL,
  title text NOT NULL,
  commitment_id uuid REFERENCES commitments(id) ON DELETE SET NULL,
  due_date date NOT NULL,
  due_time timestamptz,
  status text NOT NULL DEFAULT 'armed'
    CHECK (status IN ('armed', 'completed', 'parked', 'cancelled')),
  next_touch_at timestamptz,
  next_touch_kind text CHECK (next_touch_kind IN ('morning', 'probe', 'nudge')),
  escalations integer NOT NULL DEFAULT 0,
  renegotiations integer NOT NULL DEFAULT 0,
  last_touch_at timestamptz,
  thread_id uuid,
  resolved_at timestamptz,
  resolved_via text,
  parked_at timestamptz,
  cancelled_at timestamptz,
  cancelled_via text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Sweep support: armed rows with a due touch, ordered by next_touch_at.
-- Partial (not just column order) — completed/parked/cancelled rows never
-- re-enter the touch path.
CREATE INDEX reminders_armed_touch_idx
  ON reminders (status, next_touch_at)
  WHERE status = 'armed';

-- Principal-scoped reads (briefs, day.state armed count, owner listings).
CREATE INDEX reminders_principal_status_idx
  ON reminders (principal, status);
