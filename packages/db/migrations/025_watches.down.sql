-- 025_watches.sql (down) — remove the Watch primitive (product-reset plan §4).
-- Watch rows are owner-recoverable via `josctl watch export` before running
-- this (W2 adds the CLI; at W1 the table is empty by construction — no
-- watch evaluation code exists yet).

DROP TABLE IF EXISTS watches;
