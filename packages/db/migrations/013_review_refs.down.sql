-- 013_review_refs.down.sql — reverse 013 in full: the indexes die with the
-- table (no other object references review_refs; audit_log rows are text
-- projections and need no cascade).

DROP TABLE IF EXISTS review_refs;
