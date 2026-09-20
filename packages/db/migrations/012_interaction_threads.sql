-- 0012: Phase D — bounded conversational working memory (ADR-0014).
-- interaction_threads + interaction_messages are the SINGLE canonical
-- storage path for raw conversational content: 72h active-context TTL,
-- 7-day rolling raw retention enforced by the retention workflow.
-- No content ever appears in events/audit/model_calls/log payloads.

CREATE TABLE interaction_threads (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  surface text NOT NULL,
  -- active | closed (turnover closes; one active per principal×surface)
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed')),
  created_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  -- Idle horizon: context builder stops considering messages after this.
  active_context_expires_at timestamptz NOT NULL,
  -- Retention horizon: raw content deleted at/after this (7d rolling).
  raw_retention_expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);

-- Exactly one active thread per (principal, surface): structural.
CREATE UNIQUE INDEX interaction_threads_active_unique
  ON interaction_threads (principal_id, surface)
  WHERE status = 'active';

CREATE INDEX interaction_threads_retention_idx
  ON interaction_threads (raw_retention_expires_at)
  WHERE status = 'closed';

CREATE TABLE interaction_messages (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES interaction_threads(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principals(id),
  surface text NOT NULL,
  -- inbound (from the user) | outbound (gateway reply)
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  trust_class text NOT NULL CHECK (trust_class IN (
    'authenticated_user_intent',
    'assistant_output',
    'tool_output',
    'retrieved_external_data',
    'system_generated'
  )),
  -- Raw bounded content — the ONE canonical path (ADR-0014).
  content text NOT NULL,
  -- Deterministic estimate (ceil(chars/4)) — never a provider token count.
  token_estimate integer NOT NULL CHECK (token_estimate >= 0),
  received_at timestamptz NOT NULL,
  -- received_at + 7d; the retention workflow deletes at this horizon.
  expires_at timestamptz NOT NULL,
  -- chat.db ROWID (inbound) / notification id (outbound); no content.
  source_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX interaction_messages_thread_time_idx
  ON interaction_messages (thread_id, received_at DESC);
CREATE INDEX interaction_messages_retention_idx
  ON interaction_messages (expires_at);
CREATE INDEX interaction_messages_principal_idx
  ON interaction_messages (principal_id, received_at DESC);

-- Thread ownership is immutable at the storage layer: a message can never
-- be attached to another principal's thread.
CREATE FUNCTION interaction_message_owner_match() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.principal_id <> (SELECT principal_id FROM interaction_threads WHERE id = NEW.thread_id) THEN
    RAISE EXCEPTION 'interaction_messages.principal_id must match the thread owner'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER interaction_message_owner_match_trigger
  BEFORE INSERT ON interaction_messages
  FOR EACH ROW EXECUTE FUNCTION interaction_message_owner_match();
