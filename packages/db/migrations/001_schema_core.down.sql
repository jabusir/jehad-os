-- 001_schema_core.down.sql — full reverse of 001_schema_core.sql
-- Drops in reverse dependency order (AGENTS.md: every migration has a tested
-- down path during development). principals (000) and schema_migrations
-- (owned by the runner) are untouched.

DROP TABLE IF EXISTS model_calls;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS action_attempts;
DROP TABLE IF EXISTS action_intents;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS human_waits;
DROP TABLE IF EXISTS escalations;
DROP TABLE IF EXISTS capability_grants;
DROP TABLE IF EXISTS procedures;
DROP TABLE IF EXISTS memory_candidates;
DROP TABLE IF EXISTS evidence;
DROP TABLE IF EXISTS relationships;
DROP TABLE IF EXISTS assumptions;
DROP TABLE IF EXISTS decisions;
DROP TABLE IF EXISTS commitments;
DROP TABLE IF EXISTS entities;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS domains;
