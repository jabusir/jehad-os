-- 015_gmail_sensor.sql — Gmail read-only inbox sensor (Phase GMAIL Lane G2;
-- docs/plans/gmail-sensor-contracts.md §3/§10).
--
-- Minimal world model (§10.2 — RECOMMENDED, no `gmail_messages` projection):
-- events carry observation (`gmail.message.received`, content-free),
-- candidates carry meaning (deterministic extraction → review queue),
-- promotion carries commitments. Reads query events. A projection is added
-- the day a query needs an index events cannot serve.
--
-- `gmail_sync_state` is the singleton cursor + health row (§3.7):
--   cursor_history_id — the Gmail historyId cursor; null → the next tick
--                      bootstraps via messages.list over the policy window
--                      (§3.4). The cursor advances only past history records
--                      whose messages were fully processed (§3.6).
--   health            — jsonb snapshot of the five health dimensions
--                      (process, credential, cursor, decode, quota — §3.7);
--                      "0 new messages" is never by itself accepted as
--                      healthy, so the dims are written per tick, not
--                      derived from counts alone.
--   last_tick_at      — every completed tick stamps the wall clock (clean
--                      skips included, e.g. no-token).
--
-- NO body/snippet/subject/full-address column exists anywhere in this
-- migration (§7 hard rules): the event payload is content-free metadata;
-- subjects live ONLY as a bounded redacted field on extraction candidates
-- for allowlist senders (§4.4).

CREATE TABLE gmail_sync_state (
    id                text PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
    cursor_history_id bigint,                          -- null → next sync bootstraps (§3.4)
    health            jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_tick_at      timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    -- Health vocabulary (§3.7): every present key is one of the five dims
    -- and every value one of the three states. '{}' (never ticked) passes.
    CHECK (jsonb_path_query_array(health, '$.keyvalue().key') <@ '["process", "credential", "cursor", "decode", "quota"]'),
    CHECK (jsonb_path_query_array(health, '$.keyvalue().value') <@ '["healthy", "degraded", "failed"]')
);
