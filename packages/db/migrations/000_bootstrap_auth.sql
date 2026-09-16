-- 000_bootstrap_auth.sql — M0 bootstrap auth (ADR-0009, plan §9, data-model §3)
-- principals only; the API must never exist unauthenticated (cleanup §2).
-- PostgreSQL 16: gen_random_uuid() is native — no pgcrypto needed.
BEGIN;

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('user', 'harness', 'service', 'workflow')),
  name text NOT NULL UNIQUE,
  credential_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX principals_credential_hash_idx ON principals (credential_hash);

COMMIT;
