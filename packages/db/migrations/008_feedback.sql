-- 008_feedback.sql — E3-B dogfooding signal-quality measurement (Calendar
-- dogfooding directive: measure SIGNAL QUALITY, not parsing mechanics).
--
-- The owner's verdicts on what the system surfaced, one append-only row per
-- tap. Verdict vocabulary maps 1:1 to the owner's five measurement targets:
--   useful       — a surfaced change was useful
--   noise        — a false attention item
--   missed       — a meaningful change the system failed to surface
--   incorrect    — an incorrect commitment/state
--   interruptive — an unnecessary interruption
--
-- item_type/item_id are deliberately loose (text, no FK): verdicts may target
-- notifications, attention items, review items, brief sections, or events,
-- and some of those ids live outside this database's FK reach. Correlation is
-- done by join-on-id in the read path, not by referential constraint.
--
-- APPEND-ONLY: there is intentionally no mutability timestamp and no edit
-- path anywhere — a re-tap inside the dedupe window is swallowed by the
-- service, and corrections are new rows (possibly with a note).

CREATE TABLE feedback (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_type   text NOT NULL CHECK (item_type IN ('notification', 'attention_item', 'review_item', 'brief_section', 'event')),
    item_id     text NOT NULL,
    verdict     text NOT NULL CHECK (verdict IN ('useful', 'noise', 'missed', 'incorrect', 'interruptive')),
    note        text,
    created_by  text NOT NULL,                       -- principal id or 'josctl-manual'
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Dedupe window scan + per-item verdict history.
CREATE INDEX feedback_item_created_idx ON feedback (item_type, item_id, created_at);

-- Windowed metrics scans (signal-quality rollup).
CREATE INDEX feedback_created_idx ON feedback (created_at);
