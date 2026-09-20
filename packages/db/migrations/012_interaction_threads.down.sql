-- Down path for 0012 (tested during development, per AGENTS.md).
DROP TRIGGER IF EXISTS interaction_message_owner_match_trigger ON interaction_messages;
DROP FUNCTION IF EXISTS interaction_message_owner_match();
DROP TABLE IF EXISTS interaction_messages;
DROP TABLE IF EXISTS interaction_threads;
