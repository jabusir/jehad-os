-- 0018: W4 — versioned interaction profiles (jarvis-v1.md §7 W4 rev2 R2;
-- §5 invariant 2). interaction_profiles is the canonical store for
-- PRESENTATION-ONLY per-principal conversation configuration (register,
-- brevity caps, explanation style, address terms). It is NOT an
-- authorization surface: nothing here can alter reads, tools, budgets,
-- egress, or capability resolution, and no prompt text lives in policy.yaml
-- (the `personas:` section there is flag + principal allowlist only).
--
-- Versioning is append-only: a version is a row, never an UPDATE. The
-- active version of a (principal_id, surface) is max(version), exposed as
-- the interaction_profiles_active view.
--
-- NB: 017 is reserved for the W5 occurrence-state lane (calendar_events.
-- occurrence); lexical order is unaffected by the gap.

CREATE TABLE interaction_profiles (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  surface text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  -- owner_seed = lead-authored, owner-ratified seed (§18-2);
  -- self = principal's own confirmed self-configuration (propose→confirm).
  created_via text NOT NULL CHECK (created_via IN ('owner_seed', 'self')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, surface, version)
);

-- Active-version lookups ride the UNIQUE key in version-DESC order.
CREATE INDEX interaction_profiles_active_idx
  ON interaction_profiles (principal_id, surface, version DESC);

-- Active-version convention: exactly one row per (principal_id, surface),
-- the highest version.
CREATE VIEW interaction_profiles_active AS
SELECT DISTINCT ON (principal_id, surface)
  id, principal_id, surface, version, definition, created_via, created_at
FROM interaction_profiles
ORDER BY principal_id, surface, version DESC;

-- Storage-layer write guard (mirrors interaction_threads' owner-match
-- trigger from 012): append-only — UPDATE and DELETE are rejected, so a
-- version can never be rewritten in place and a row can never be
-- re-attributed to another principal. Rewriting history = writing a new
-- version row. Cleanup rides the down path (DROP) or ops TRUNCATE;
-- neither fires row-level triggers.
CREATE FUNCTION interaction_profiles_write_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'interaction_profiles is append-only: UPDATE is not permitted (write a new version row)'
      USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'interaction_profiles is append-only: DELETE is not permitted (versions are immutable history)'
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER interaction_profiles_write_guard_trigger
  BEFORE UPDATE OR DELETE ON interaction_profiles
  FOR EACH ROW EXECUTE FUNCTION interaction_profiles_write_guard();
