-- 006_notifications.sql — E4 OpenClaw attach: the notification queue.
-- Delivery to the edge (OpenClaw) is Jehad OS QUEUING + RECORDING ONLY: rows
-- are created behind review/policy (status pending unless the kind is on the
-- policy auto-approve list), surfaced to a harness principal exclusively via
-- the grant-gated /harness surface, and their delivery is recorded — never
-- performed — by the core (the edge owns its own transport; no OAuth, no
-- iMessage in this repo).
--
-- Status vocabulary: pending (awaiting user review) → approved (claimable by
-- a granted harness) → delivered (the edge reported delivery) | rejected
-- (user refused delivery) | expired (delivery window passed). Claiming keeps
-- status 'approved' and stamps claimed_at/claimed_by — the claim is a lease,
-- not a transition; the delivery window is enforced through expires_at.

CREATE TABLE notifications (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         text NOT NULL CHECK (kind IN ('brief', 'escalation', 'custom')),
    title        text NOT NULL,
    payload      jsonb NOT NULL,
    domain_id    uuid REFERENCES domains(id),          -- nullable: not every notification is domain-bound
    status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'delivered', 'expired')),
    source_type  text NOT NULL CHECK (source_type IN ('escalation', 'brief', 'run')),
    source_id    text,                                 -- polymorphic provenance (escalation/artifact/run id)
    created_by   uuid NOT NULL REFERENCES principals(id),
    approved_by  uuid REFERENCES principals(id),       -- null while pending; null + approved_at set = policy auto-approve
    approved_at  timestamptz,
    claimed_at   timestamptz,                          -- claim lease (status stays approved until delivered)
    claimed_by   uuid REFERENCES principals(id),
    delivered_by uuid REFERENCES principals(id),       -- the harness principal that reported delivery
    delivered_at timestamptz,
    expires_at   timestamptz NOT NULL,                 -- delivery window: past this, never claimable/deliverable
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- FIFO claim scan + user-side status filters.
CREATE INDEX notifications_status_created_idx ON notifications (status, created_at);
