-- 011_imessage_pairing.sql — iMessage gateway multi-principal onboarding
-- (Lane P; docs/plans/ig-multiprincipal-contracts.md — DDL is binding shape).
--
-- transport_identities: a handle is PROOF of pairing, never configuration —
-- rows exist only via attemptPairing consuming a single-use 6-digit code
-- (§5.1). One handle maps to one principal, ever (UNIQUE (transport,
-- handle)); a principal may hold several handles (phone + Apple ID, each
-- consumed its own code). Handles are canonical (+E.164 or lowercase email)
-- and carry NO content — there is deliberately no content column anywhere
-- in this migration.
--
-- imessage_pairing_sessions: one active challenge per principal, 5-minute
-- TTL, single-use (consumed_at/consumed_handle set on first success — the
-- code dies with it). Two-layer guess throttle (§5.1): per-handle lockout
-- (handle_lockouts jsonb, wrong_count < 3) PLUS a session-wide total-guess
-- cap (guesses_used < max_total_guesses, default 5) so distributed spray
-- from many burner handles cannot bypass the per-handle throttle.
-- code_hash is sha256 of the 6-digit code — the plaintext code is shown
-- exactly once by the CLI and never persisted.
--
-- Deviation from the contracts sketch (noted, mechanical): Postgres DEFAULT
-- expressions cannot reference other columns, so `expires_at DEFAULT
-- (created_at + 5 min)` is enforced by the pairing service at INSERT time
-- (created_at + interval '5 minutes'), which is identical in effect.
--
-- notifications.recipient: the reply conjunction's recipient leg moves from
-- the env EDGE_IMESSAGE_TARGET to paired transport identities; the actual
-- target rides the row (kind=reply only — service-enforced) with
-- payload.recipient as fallback. model_calls gains principal_id + surface
-- so per-principal × per-surface budget windows (§5.4) can police the
-- gateway's spend. imessage_transport_events gains pairing_attempt_hash —
-- the EXACT-match pre-auth pairing probe (§5.1.1); still no content column.

CREATE TABLE transport_identities (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id       uuid NOT NULL REFERENCES principals(id),
    transport          text NOT NULL CHECK (transport = 'imessage'),
    handle             text NOT NULL,            -- canonical: +E.164 or lowercase email
    verified_at        timestamptz NOT NULL,
    last_seen_at       timestamptz NOT NULL,
    paired_via_session uuid NOT NULL,
    UNIQUE (transport, handle)                   -- one handle → one principal, ever
);

CREATE INDEX transport_identities_principal_idx ON transport_identities (principal_id);

CREATE TABLE imessage_pairing_sessions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id       uuid NOT NULL REFERENCES principals(id),
    purpose            text NOT NULL CHECK (purpose IN ('pair', 'add-handle')),
    code_hash          text NOT NULL,            -- sha256 of the 6-digit code; plaintext never stored
    created_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,     -- service-set: created_at + 5 minutes
    max_total_guesses  int NOT NULL DEFAULT 5,
    guesses_used       int NOT NULL DEFAULT 0,
    handle_lockouts    jsonb NOT NULL DEFAULT '{}',  -- {handle: wrong_count}
    consumed_at        timestamptz,
    consumed_handle    text
);

CREATE INDEX imessage_pairing_sessions_principal_idx
    ON imessage_pairing_sessions (principal_id, created_at DESC);

-- Reply addressing (kind=reply only; the service rejects recipient on
-- other kinds) + per-principal × surface model-call accounting.
ALTER TABLE notifications ADD COLUMN recipient text;
ALTER TABLE model_calls ADD COLUMN principal_id uuid REFERENCES principals(id),
                        ADD COLUMN surface text;
ALTER TABLE imessage_transport_events ADD COLUMN pairing_attempt_hash text;

CREATE INDEX model_calls_principal_surface_created_idx
    ON model_calls (principal_id, surface, created_at);
