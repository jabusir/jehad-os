// Migration tests. The fs-based suite runs anywhere; the database suites need
// a PostgreSQL 16 instance and are skipped unless TEST_DATABASE_URL is set.
// Integration suites use per-file isolated databases (vitest parallelism).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { listMigrations, migrateUp, migrateDown, defaultMigrationsDir } from "../src/migrate";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "./test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// The 20 tables owned by 001 (principals lands separately via 000_bootstrap_auth.sql).
const TABLES_001 = [
  "domains", "events", "outbox", "entities", "commitments", "decisions",
  "assumptions", "relationships", "evidence", "memory_candidates", "procedures",
  "runs", "human_waits", "artifacts", "action_intents", "action_attempts",
  "capability_grants", "audit_log", "escalations", "model_calls",
] as const;

const ALL_MIGRATIONS = [
  "000_bootstrap_auth", "001_schema_core", "002_action_transition_guard", "003_evidence_links",
  "004_commitments_domain", "005_commitments_temporal", "006_notifications",
  "007_calendar", "008_feedback", "009_notification_calendar_change", "010_imessage_sensor",
] as const;

async function tableNames(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  return new Set(result.rows.map((row) => row.table_name));
}

describe("migration files (fs only)", () => {
  it("lists all migrations and applies in lexical order", async () => {
    const migrations = await listMigrations();
    expect(migrations.map((m) => m.name)).toEqual([...ALL_MIGRATIONS]);
  });

  it("every migration ships a tested down path (AGENTS.md)", async () => {
    const migrations = await listMigrations();
    for (const migration of migrations) {
      expect(migration.downSql.trim().length).toBeGreaterThan(0);
    }
  });

  it("down migration drops every table the up migration creates", async () => {
    const migrations = await listMigrations();
    const schema = migrations.find((m) => m.name === "001_schema_core");
    expect(schema).toBeDefined();
    for (const table of TABLES_001) {
      expect(schema!.sql).toMatch(new RegExp(`CREATE TABLE ${table}\\b`));
      expect(schema!.downSql).toMatch(new RegExp(`DROP TABLE IF EXISTS ${table}\\b`));
    }
    const bootstrap = migrations.find((m) => m.name === "000_bootstrap_auth");
    expect(bootstrap).toBeDefined();
    expect(bootstrap!.sql).toMatch(/CREATE TABLE principals\b/);
    expect(bootstrap!.downSql).toMatch(/DROP TABLE IF EXISTS principals\b/);
  });

  it("004 adds commitments.domain_id with backfill, NOT NULL, and an index; down drops them", async () => {
    const migrations = await listMigrations();
    const domain = migrations.find((m) => m.name === "004_commitments_domain");
    expect(domain).toBeDefined();
    expect(domain!.sql).toMatch(/ALTER TABLE commitments ADD COLUMN domain_id uuid REFERENCES domains\(id\)/);
    expect(domain!.sql).toMatch(/SET domain_id = e\.domain_id\s+FROM events e/);
    expect(domain!.sql).toMatch(/ALTER COLUMN domain_id SET NOT NULL/);
    expect(domain!.sql).toMatch(/CREATE INDEX commitments_domain_status_idx ON commitments \(domain_id, status\)/);
    expect(domain!.downSql).toMatch(/DROP INDEX IF EXISTS commitments_domain_status_idx/);
    expect(domain!.downSql).toMatch(/ALTER TABLE commitments DROP COLUMN IF EXISTS domain_id/);
  });

  it("005 adds nullable commitments.temporal jsonb; down drops it", async () => {
    const migrations = await listMigrations();
    const temporal = migrations.find((m) => m.name === "005_commitments_temporal");
    expect(temporal).toBeDefined();
    expect(temporal!.sql).toMatch(/ALTER TABLE commitments ADD COLUMN temporal jsonb NULL/);
    expect(temporal!.downSql).toMatch(/ALTER TABLE commitments DROP COLUMN IF EXISTS temporal/);
  });

  it("006 creates the notifications queue with the claim lease and a down path", async () => {
    const migrations = await listMigrations();
    const notifications = migrations.find((m) => m.name === "006_notifications");
    expect(notifications).toBeDefined();
    expect(notifications!.sql).toMatch(/CREATE TABLE notifications\b/);
    for (const column of [
      "kind", "title", "payload", "domain_id", "status", "source_type", "source_id",
      "created_by", "approved_by", "approved_at", "claimed_at", "claimed_by",
      "delivered_by", "delivered_at", "expires_at",
    ]) {
      expect(notifications!.sql).toMatch(new RegExp(`\\b${column}\\s+`));
    }
    expect(notifications!.sql).toMatch(/CHECK \(status IN \('pending', 'approved', 'rejected', 'delivered', 'expired'\)\)/);
    expect(notifications!.downSql).toMatch(/DROP TABLE IF EXISTS notifications\b/);
  });

  it("007 creates the calendar sensor projection + sync cursor with a down path", async () => {
    const migrations = await listMigrations();
    const calendar = migrations.find((m) => m.name === "007_calendar");
    expect(calendar).toBeDefined();
    expect(calendar!.sql).toMatch(/CREATE TABLE calendar_events\b/);
    expect(calendar!.sql).toMatch(/CREATE TABLE calendar_sync_state\b/);
    expect(calendar!.sql).toMatch(/UNIQUE \(google_calendar_id, google_event_id\)/);
    expect(calendar!.sql).toMatch(/CHECK \(status IN \('confirmed', 'tentative', 'cancelled'\)\)/);
    expect(calendar!.sql).toMatch(/source_event_id\s+uuid NOT NULL REFERENCES events\(id\)/);
    expect(calendar!.sql).toMatch(/CHECK \(id = 1\)/);
    expect(calendar!.downSql).toMatch(/DROP TABLE IF EXISTS calendar_sync_state\b/);
    expect(calendar!.downSql).toMatch(/DROP TABLE IF EXISTS calendar_events\b/);
  });

  it("008 creates the append-only feedback table with verdict/item_type CHECKs and a down path", async () => {
    const migrations = await listMigrations();
    const feedback = migrations.find((m) => m.name === "008_feedback");
    expect(feedback).toBeDefined();
    expect(feedback!.sql).toMatch(/CREATE TABLE feedback\b/);
    for (const column of ["item_type", "item_id", "verdict", "note", "created_by", "created_at"]) {
      expect(feedback!.sql).toMatch(new RegExp(`\\b${column}\\s+`));
    }
    expect(feedback!.sql).toMatch(
      /CHECK \(item_type IN \('notification', 'attention_item', 'review_item', 'brief_section', 'event'\)\)/,
    );
    expect(feedback!.sql).toMatch(
      /CHECK \(verdict IN \('useful', 'noise', 'missed', 'incorrect', 'interruptive'\)\)/,
    );
    // append-only: no updated_at column, no mutable surface
    expect(feedback!.sql).not.toMatch(/updated_at/);
    expect(feedback!.downSql).toMatch(/DROP TABLE IF EXISTS feedback\b/);
  });

  it("010 creates the iMessage shadow-sensor tables per the binding sketch; down reverses in dep order", async () => {
    const migrations = await listMigrations();
    const imessage = migrations.find((m) => m.name === "010_imessage_sensor");
    expect(imessage).toBeDefined();
    // Binding sketch shape: three tables.
    expect(imessage!.sql).toMatch(/CREATE TABLE imessage_transport_events\b/);
    expect(imessage!.sql).toMatch(/CREATE TABLE sent_message_fingerprints\b/);
    expect(imessage!.sql).toMatch(/CREATE TABLE imessage_sensor_state\b/);
    // guid UNIQUE = the idempotency key; hash only for is_from_me rows.
    expect(imessage!.sql).toMatch(/guid\s+text NOT NULL UNIQUE/);
    expect(imessage!.sql).toMatch(/CHECK \(normalized_text_sha256 IS NULL OR is_from_me\)/);
    // Privacy rule: no content column anywhere in the sensor tables.
    expect(imessage!.sql).not.toMatch(/content\s+text/);
    // Singleton pinned to true; health vocabulary constrained.
    expect(imessage!.sql).toMatch(/singleton\s+boolean PRIMARY KEY DEFAULT true CHECK \(singleton\)/);
    expect(imessage!.sql).toMatch(/health_process\s+text CHECK \(health_process IN \('healthy', 'degraded', 'failed'\)\)/);
    // Reply rule: kind widens with 'reply' + the four nullable support columns.
    expect(imessage!.sql).toMatch(
      /CHECK \(kind IN \('brief', 'escalation', 'custom', 'calendar-change', 'reply'\)\)/,
    );
    for (const column of [
      "surface", "requesting_principal_id", "conversation_principal_id", "third_party_recipient",
    ]) {
      expect(imessage!.sql).toMatch(new RegExp(`ADD COLUMN ${column}\\b`));
    }
    // Down: reverse dependency order + restore the 009 vocabulary.
    const drops = [...imessage!.downSql.matchAll(/DROP TABLE IF EXISTS (\w+)/g)].map((m) => m[1]);
    expect(drops).toEqual(["imessage_sensor_state", "imessage_transport_events", "sent_message_fingerprints"]);
    for (const column of [
      "third_party_recipient", "conversation_principal_id", "requesting_principal_id", "surface",
    ]) {
      expect(imessage!.downSql).toMatch(new RegExp(`DROP COLUMN IF EXISTS ${column}\\b`));
    }
    expect(imessage!.downSql).toMatch(/DELETE FROM notifications WHERE kind = 'reply'/);
    expect(imessage!.downSql).toMatch(
      /CHECK \(kind IN \('brief', 'escalation', 'custom', 'calendar-change'\)\)/,
    );
  });

  it("002 ships the action_attempts outcome-guard trigger with a down path", async () => {
    const migrations = await listMigrations();
    const guard = migrations.find((m) => m.name === "002_action_transition_guard");
    expect(guard).toBeDefined();
    expect(guard!.sql).toMatch(/CREATE TRIGGER action_attempts_outcome_guard_trigger/);
    expect(guard!.downSql).toMatch(/DROP TRIGGER IF EXISTS action_attempts_outcome_guard_trigger/);
    expect(guard!.downSql).toMatch(/DROP FUNCTION IF EXISTS action_attempts_outcome_guard/);
  });

  it("009 widens the notifications kind/source_type CHECKs; down restores the 006 vocabulary", async () => {
    const migrations = await listMigrations();
    const widen = migrations.find((m) => m.name === "009_notification_calendar_change");
    expect(widen).toBeDefined();
    expect(widen!.sql).toMatch(
      /CHECK \(kind IN \('brief', 'escalation', 'custom', 'calendar-change'\)\)/,
    );
    expect(widen!.sql).toMatch(
      /CHECK \(source_type IN \('escalation', 'brief', 'run', 'calendar'\)\)/,
    );
    // Down purges widened-vocabulary rows BEFORE narrowing (dev-only path).
    expect(widen!.downSql).toMatch(
      /DELETE FROM notifications WHERE kind = 'calendar-change' OR source_type = 'calendar'/,
    );
    expect(widen!.downSql).toMatch(
      /CHECK \(kind IN \('brief', 'escalation', 'custom'\)\)/,
    );
    expect(widen!.downSql).toMatch(
      /CHECK \(source_type IN \('escalation', 'brief', 'run'\)\)/,
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)("migrate up/down (integration)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "migrate");
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("applies all migrations on a fresh database, records them, then fully reverses", async () => {
    const pool: Pool = db.pool;
    const applied = await migrateUp(pool, defaultMigrationsDir());
    expect(applied).toEqual([...ALL_MIGRATIONS]);

    const afterUp = await tableNames(pool);
    for (const table of TABLES_001) expect(afterUp.has(table)).toBe(true);
    expect(afterUp.has("principals")).toBe(true);
    expect(afterUp.has("notifications")).toBe(true);
    expect(afterUp.has("feedback")).toBe(true);
    expect(afterUp.has("schema_migrations")).toBe(true);
    expect(afterUp.has("notifications")).toBe(true);
    expect(afterUp.has("calendar_events")).toBe(true);
    expect(afterUp.has("calendar_sync_state")).toBe(true);
    expect(afterUp.has("imessage_transport_events")).toBe(true);
    expect(afterUp.has("sent_message_fingerprints")).toBe(true);
    expect(afterUp.has("imessage_sensor_state")).toBe(true);

    const records = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
    expect(records.rows.map((r) => r.name)).toEqual([...ALL_MIGRATIONS]);

    const rolled = await migrateDown(pool, {}, defaultMigrationsDir());
    expect(rolled).toEqual([...[...ALL_MIGRATIONS].reverse()]);

    const afterDown = await tableNames(pool);
    for (const table of [
      ...TABLES_001, "principals",
      "imessage_transport_events", "sent_message_fingerprints", "imessage_sensor_state",
    ]) {
      expect(afterDown.has(table)).toBe(false);
    }
    expect(afterDown.has("schema_migrations")).toBe(true);
  });

  it("is idempotent: re-up applies nothing; re-down rolls back nothing", async () => {
    const pool: Pool = db.pool;
    expect(await migrateUp(pool, defaultMigrationsDir())).toEqual([...ALL_MIGRATIONS]);
    expect(await migrateUp(pool, defaultMigrationsDir())).toEqual([]);
    expect(await migrateDown(pool, {}, defaultMigrationsDir())).toEqual(
      [...[...ALL_MIGRATIONS].reverse()],
    );
    expect(await migrateDown(pool, {}, defaultMigrationsDir())).toEqual([]);
  });
});
