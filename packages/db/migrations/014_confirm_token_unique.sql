-- Adversary A1 (b68a230 wave): two LIVE proposals must never share a
-- confirm-token hash — without this, a 32^5 birthday collision can
-- confirm the wrong intent (lookup is unordered). Consumed/cancelled/
-- expired intents may share hashes with later live ones.
CREATE UNIQUE INDEX action_intents_confirm_token_live_uidx
  ON action_intents ((payload->'confirm'->>'tokenHash'))
  WHERE status = 'proposed';

-- Deterministic resolution on the (now impossible) live-vs-consumed
-- hash share: newest row wins.
CREATE INDEX action_intents_confirm_token_idx
  ON action_intents ((payload->'confirm'->>'tokenHash'), created_at DESC);
