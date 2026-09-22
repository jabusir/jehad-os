// 002_action_transition_guard integration tests (R10): the DB itself rejects
// outcome transitions the service state machine forbids — raw SQL can no
// longer rewrite attempt history (terminal → anything) or shortcut
// reconciliation (unknown → succeeded/failed/executing). Needs PostgreSQL 16;
// skipped unless TEST_DATABASE_URL is set. Isolated per-file database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "../src/migrate";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "./test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("002 action_attempts outcome guard (integration)", () => {
  let db: IsolatedDb;
  let intentId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "atmguard");
    await migrateUp(db.pool);
    const domain = await db.pool.query(
      `INSERT INTO domains (key, name, sensitivity, retention_class)
       VALUES ('personal', 'Personal', 'normal', 'default') RETURNING id`,
    );
    const principal = await db.pool.query(
      `INSERT INTO principals (type, name, credential_hash)
       VALUES ('user', 'guard-test', NULL) RETURNING id`,
    );
    const run = await db.pool.query(
      `INSERT INTO runs (kind, status, domain_id, principal_id)
       VALUES ('workflow', 'running', $1, $2) RETURNING id`,
      [String(domain.rows[0]!.id), String(principal.rows[0]!.id)],
    );
    const intent = await db.pool.query(
      `INSERT INTO action_intents (run_id, capability, resource, domain_id, status)
       VALUES ($1, 'act:fake', 'fake:send', $2, 'prepared') RETURNING id`,
      [String(run.rows[0]!.id), String(domain.rows[0]!.id)],
    );
    intentId = String(intent.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function insertAttempt(outcome: string): Promise<string> {
    const result = await db.pool.query(
      `INSERT INTO action_attempts (intent_id, provider, idempotency_key, started_at, outcome)
       VALUES ($1, 'fake', gen_random_uuid()::text, clock_timestamp(), $2) RETURNING id`,
      [intentId, outcome],
    );
    return String(result.rows[0]!.id);
  }

  async function setOutcome(id: string, outcome: string) {
    return db.pool.query(
      "UPDATE action_attempts SET outcome = $2, updated_at = now() WHERE id = $1",
      [id, outcome],
    );
  }

  it("allows the service transitions: executing → succeeded | failed | unknown", async () => {
    for (const outcome of ["succeeded", "failed", "unknown"]) {
      const id = await insertAttempt("executing");
      await expect(setOutcome(id, outcome)).resolves.toBeDefined();
    }
  });

  it("allows reconciliation: unknown → reconciled", async () => {
    const id = await insertAttempt("unknown");
    await expect(setOutcome(id, "reconciled")).resolves.toBeDefined();
  });

  it("blocks unknown → succeeded | failed | executing (reconcile is the only exit)", async () => {
    for (const outcome of ["succeeded", "failed", "executing"]) {
      const id = await insertAttempt("unknown");
      await expect(setOutcome(id, outcome)).rejects.toThrow(/transition unknown -> \w+ is forbidden/);
    }
  });

  it("blocks executing → reconciled (not a service transition)", async () => {
    const id = await insertAttempt("executing");
    await expect(setOutcome(id, "reconciled")).rejects.toThrow(/transition executing -> reconciled/);
  });

  it("R10 regression: terminal outcomes are immutable — raw SQL cannot rewrite history", async () => {
    for (const terminal of ["succeeded", "failed", "reconciled"]) {
      const id = await insertAttempt(terminal);
      for (const next of ["succeeded", "failed", "reconciled", "unknown", "executing"]) {
        if (next === terminal) continue;
        await expect(setOutcome(id, next)).rejects.toThrow(
          new RegExp(`transition ${terminal} -> ${next} is forbidden`),
        );
      }
    }
  });

  it("non-outcome updates on a terminal attempt still pass (bookkeeping is not frozen)", async () => {
    const id = await insertAttempt("succeeded");
    const result = await db.pool.query(
      "UPDATE action_attempts SET error = 'late diagnostic', provider_ref = 'ref-1' WHERE id = $1 RETURNING error",
      [id],
    );
    expect(result.rows[0]!.error).toBe("late diagnostic");
  });

  it("down path removes the guard (and re-up restores it)", async () => {
    const id = await insertAttempt("succeeded");

    const rolled = await migrateDown(db.pool, { to: "001_schema_core" });
    expect(rolled).toEqual([
      "022_lesson_vocabulary", "021_reminders", "020_system_feedback", "019_grant_reminder_kind", "018_interaction_profiles", "017_calendar_occurrence", "016_calibration", "015_gmail_sensor", "014_confirm_token_unique", "013_review_refs",
      "012_interaction_threads",
      "011_imessage_pairing",
      "010_imessage_sensor",
      "009_notification_calendar_change",
      "008_feedback",
      "007_calendar",
      "006_notifications",
      "005_commitments_temporal",
      "004_commitments_domain",
      "003_evidence_links",
      "002_action_transition_guard",
    ]);

    // Without the trigger, the regressed write goes through — proving the
    // guard (not something else) was doing the blocking.
    await expect(setOutcome(id, "failed")).resolves.toBeDefined();

    await migrateUp(db.pool);
    await expect(setOutcome(id, "succeeded")).rejects.toThrow(/terminal outcomes are immutable/);
  });
});
