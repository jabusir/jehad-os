-- 000_bootstrap_auth.down.sql — tested down path for 000_bootstrap_auth
BEGIN;

DROP TABLE IF EXISTS principals;

COMMIT;
