-- 005 down: drop the temporal provenance block. due_at is untouched — it may
-- carry dates landed before the column existed; only provenance is lost.

ALTER TABLE commitments DROP COLUMN IF EXISTS temporal;
