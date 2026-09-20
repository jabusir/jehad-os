-- 013_review_refs.sql — Phase G review/control refs over iMessage
-- (docs/plans/ig-phase-g-contracts.md §2; gateway §4.1 CONTROL mode).
--
-- Refs are authority-bearing tokens over an authenticated channel: a 3-char
-- Crockford-base32 code (0-9 A-Z minus I L O U — no 0/O, 1/I confusables;
-- 32³ = 32 768 live space) naming one queue item for one principal. The
-- table carries REFS ONLY — no content, no candidate payload echoes; the
-- statement it names lives where it already lives (memory_candidates /
-- escalations), joined by id at read time.
--
-- Mint-once per live item (first surfacing; kept until resolution — an old
-- brief's ref stays copyable): the partial unique index on
-- (item_type, item_id) WHERE resolved_at IS NULL makes one unresolved ref
-- per queue item structural. The (principal_id, ref) partial unique index
-- is the collision law: a principal's live codes never repeat, but a
-- resolved/expired code may be re-minted for a new item — resolution ends
-- authority.
--
-- item_id is deliberately loose (uuid, no FK): like feedback's item refs,
-- it names rows across two tables (memory_candidates, escalations) and
-- survives their independent lifecycles; correlation is by join-on-id.
--
-- TTL: expires_at defaults to 168h (ref_ttl_hours, contract §7); an
-- unresolved ref past TTL expires honest and is re-minted at the item's
-- next surfacing (the service resolves it lazily as resolved_by='expiry').
-- snoozed_until/snooze_count implement `snooze [REF]` — the item leaves
-- digests until snoozed_until passes; the ref itself never resolves.
-- resolved_by names the prior verdict so replay replies are honest
-- ("already handled — [7K4] was approved").

CREATE TABLE review_refs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ref           text NOT NULL
                  CHECK (ref ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{3}$'),  -- Crockford base32, no I L O U
    principal_id  uuid NOT NULL REFERENCES principals(id),
    item_type     text NOT NULL CHECK (item_type IN ('candidate', 'escalation')),
    item_id       uuid NOT NULL,                    -- memory_candidates.id | escalations.id (no FK, by design)
    minted_at     timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz,                      -- first verdict or expiry; the ref dies here
    resolved_by   text CHECK (resolved_by IN ('approve', 'reject', 'expiry', 'superseded')),
    expires_at    timestamptz NOT NULL DEFAULT (now() + interval '168 hours'),  -- ref_ttl_hours (§7)
    snoozed_until timestamptz,
    snooze_count  int NOT NULL DEFAULT 0 CHECK (snooze_count >= 0)
);

-- Mint-once: exactly one unresolved ref per queue item (any principal —
-- the review queue is single-tenant today; resolution is per-ref).
CREATE UNIQUE INDEX review_refs_item_live_unique
    ON review_refs (item_type, item_id)
    WHERE resolved_at IS NULL;

-- Collision law: a principal's live codes are unique; a resolved or
-- expired code may be re-minted for a new item.
CREATE UNIQUE INDEX review_refs_principal_ref_live_unique
    ON review_refs (principal_id, ref)
    WHERE resolved_at IS NULL;

-- Digest scans: the owner's live refs, oldest first (§4.2 brief section).
CREATE INDEX review_refs_open_idx
    ON review_refs (principal_id, minted_at)
    WHERE resolved_at IS NULL;
