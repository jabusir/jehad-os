// Lesson harvest workflow tests (SV3 lane, sv-lessons; plan
// feedback-and-self-verification.md §SV3/SV4): definition shape (hourly
// cron guarded to 03:30 local), worker-server serving, and integration
// ticks over a real migrated database (reminder-sweep test pattern)
// pinning the deterministic aggregation contract: exactly one proposed
// lesson per qualifying claim_type, SV4 dead-letter and rate-limit
// signals, subject-dedupe idempotency on re-run, and the empty-day
// no-op. Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../tests/isolated-db.js";
import { createWorkflowWorkerServer } from "./index.js";
import { assertWorkflowToken } from "./names.js";
import {
  CLAIM_MISMATCH_THRESHOLD,
  EXPIRED_RATIFIED_SUBJECT,
  lessonHarvestWorkflow,
  LESSON_HARVEST_CRON,
  LESSON_HARVEST_LOCAL_HOUR,
  RATE_LIMIT_THRESHOLD,
  runLessonHarvestTick,
} from "./lesson-harvest-workflows.js";
const FIVE_FIELD_CRON_RE = /^(\S+ ){4}\S+$/;

describe("lesson-harvest workflow definition", () => {
  it("exports a valid cron definition pinned to the guarded hourly cadence", () => {
    expect(lessonHarvestWorkflow.kind).toBe("cron");
    expect(lessonHarvestWorkflow.name).toBe("lesson-harvest");
    expect(lessonHarvestWorkflow.cron).toBe(LESSON_HARVEST_CRON);
    expect(lessonHarvestWorkflow.cron).toMatch(FIVE_FIELD_CRON_RE);
    expect(LESSON_HARVEST_LOCAL_HOUR).toBe(3); // 03:30 local
    expect(() => assertWorkflowToken("workflow name", lessonHarvestWorkflow.name)).not.toThrow();
    expect(typeof lessonHarvestWorkflow.fn).toBe("function");
  });

  it("serves through the worker server (compiles to executor functions)", () => {
    const server = createWorkflowWorkerServer({ workflows: [lessonHarvestWorkflow] });
    expect(typeof server.listen).toBe("function");
    server.close();
  });
});

// ----------------------------------------------------------- integration

// September 2026: PT = UTC-7. Owner-local civil dates of the audit anchors:
const SEP21 = new Date("2026-09-21T20:00:00Z"); // 13:00 PDT on 2026-09-21
const SEP22 = new Date("2026-09-22T18:00:00Z"); // 11:00 PDT on 2026-09-22
const NOW = new Date("2026-09-22T19:00:00Z"); // inside the 24h window of both

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("lesson-harvest tick (integration)", () => {
  let db: IsolatedDb;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  let principalId = "";

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "svharvest");
    await migrateUp(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'sv-harvest-p') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    logSpy.mockRestore();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  afterEach(async () => {
    await db.pool.query(`DELETE FROM feedback WHERE item_type = 'lesson'`);
    await db.pool.query(`DELETE FROM audit_log WHERE actor = 'system:test'`);
    await db.pool.query(`DELETE FROM notifications WHERE title = 'harvest-test'`);
    await db.pool.query(`DELETE FROM action_attempts WHERE provider = 'test-provider'`);
    await db.pool.query(`DELETE FROM action_intents WHERE capability = 'act:test'`);
    await db.pool.query(`DELETE FROM runs WHERE kind = 'workflow'`);
  });

  async function seedAudit(action: string, ref: unknown, occurredAt: Date): Promise<string> {
    const row = await db.pool.query(
      `INSERT INTO audit_log (actor, action, outputs_ref, reversible, occurred_at)
       VALUES ('system:test', $1, $2, false, $3::timestamptz) RETURNING id`,
      [action, JSON.stringify(ref), occurredAt.toISOString()],
    );
    return String(row.rows[0]!.id);
  }

  async function seedExpiredNotification(kind: string): Promise<string> {
    const row = await db.pool.query(
      `INSERT INTO notifications (kind, title, payload, status, source_type, created_by, expires_at)
       VALUES ($1, 'harvest-test', '{}'::jsonb, 'expired', 'run', $2::uuid, now() - interval '1 hour')
       RETURNING id`,
      [kind, principalId],
    );
    return String(row.rows[0]!.id);
  }

  async function lessonRows(): Promise<Record<string, unknown>[]> {
    const rows = await db.pool.query(
      `SELECT item_id, verdict, note, source_refs FROM feedback WHERE item_type = 'lesson' ORDER BY item_id`,
    );
    return rows.rows;
  }

  it("claim ledger: exactly one proposed lesson per qualifying claim_type; passes and malformed rows never count", async () => {
    expect(CLAIM_MISMATCH_THRESHOLD).toBe(2);
    // persistence: exactly CLAIM_MISMATCH_THRESHOLD mismatches (the ≥2 boundary).
    const persistenceA = await seedAudit(
      "converse.claim_audit",
      { claim_type: "persistence", remediation: "deterministic_replace", revision_passed: null },
      SEP21,
    );
    const persistenceB = await seedAudit(
      "converse.claim_audit",
      { claim_type: "persistence", remediation: "model_revision", revision_attempted: true, revision_passed: true },
      SEP22,
    );
    // counts: a single safe fallback qualifies on its own.
    const countsSafe = await seedAudit(
      "converse.claim_audit",
      { claim_type: "counts", remediation: "safe_fallback", revision_passed: false },
      SEP22,
    );
    // delivery_state: an unverified PASS (no remediation) is never a lesson.
    await seedAudit("converse.claim_audit", { claim_type: "delivery_state", verification_basis: "unverified" }, SEP22);
    // Malformed provenance is counted, never crash-worthy.
    await db.pool.query(
      `INSERT INTO audit_log (actor, action, outputs_ref, reversible, occurred_at)
       VALUES ('system:test', 'converse.claim_audit', 'not-json', false, $1::timestamptz)`,
      [SEP22.toISOString()],
    );

    const result = await runLessonHarvestTick(db.pool, { principalIds: [principalId], now: NOW });
    expect(result.proposed).toBe(2);
    expect(result.refreshed).toBe(0);
    expect(result.claimAuditRows).toBe(5);
    expect(result.expiredRatified).toBe(0);
    expect(result.rateLimited).toBe(0);

    const rows = await lessonRows();
    expect(rows).toEqual([
      {
        item_id: "answers drift on counts",
        verdict: "proposed",
        note: `1 counts-claim mismatch on 2026-09-22; 1 safe fallback`,
        source_refs: [countsSafe],
      },
      {
        item_id: "answers drift on persistence",
        verdict: "proposed",
        note: `2 persistence-claim mismatches on 2026-09-21, 2026-09-22`,
        source_refs: [persistenceA, persistenceB],
      },
    ]);
  });

  it("re-running the tick is idempotent: notes refresh, rows never duplicate", async () => {
    await seedAudit("converse.claim_audit", { claim_type: "persistence", remediation: "deterministic_replace" }, SEP21);
    await seedAudit("converse.claim_audit", { claim_type: "persistence", remediation: "deterministic_replace" }, SEP22);
    await runLessonHarvestTick(db.pool, { principalIds: [principalId], now: NOW });
    const second = await runLessonHarvestTick(db.pool, { principalIds: [principalId], now: NOW });
    expect(second.proposed).toBe(0);
    expect(second.refreshed).toBe(1);
    const rows = await lessonRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("proposed");
  });

  it("SV4 signals: expired ratified notifications (≥1) and rate-limit denials (≥3) become lessons", async () => {
    expect(RATE_LIMIT_THRESHOLD).toBe(3);
    // A dead letter in the F3 scope...
    const deadId = await seedExpiredNotification("calibration");
    const deadAudit = await seedAudit("notification.expired", { notificationId: deadId }, SEP22);
    // ...and an expired brief — auto-approved but NOT in the sentinel scope.
    const briefId = await seedExpiredNotification("brief");
    await seedAudit("notification.expired", { notificationId: briefId }, SEP22);
    // Rate-limit denials: exactly RATE_LIMIT_THRESHOLD for this principal.
    const rateIds: string[] = [];
    for (let i = 0; i < RATE_LIMIT_THRESHOLD; i += 1) {
      rateIds.push(
        await seedAudit(
          "imessage.converse.rate-limited",
          { principalId, kind: "requests" },
          SEP22,
        ),
      );
    }
    // Two denials for another principal stay under the threshold.
    for (let i = 0; i < RATE_LIMIT_THRESHOLD - 1; i += 1) {
      await seedAudit("imessage.converse.rate-limited", { principalId: randomUUID(), kind: "requests" }, SEP22);
    }

    const result = await runLessonHarvestTick(db.pool, { principalIds: [principalId], now: NOW });
    expect(result.expiredRatified).toBe(1);
    expect(result.rateLimited).toBe(5); // counted, but only the in-scope principal's 3 qualify

    const rows = await lessonRows();
    expect(rows.map((r) => r.item_id)).toEqual([
      EXPIRED_RATIFIED_SUBJECT,
      "reply budget denials repeat",
    ]);
    expect(rows[0]!.note).toBe("1 ratified-kind notification expired undelivered on 2026-09-22 (calibration)");
    expect(rows[0]!.source_refs).toEqual([deadAudit]);
    expect(rows[1]!.note).toBe("3 reply-budget denials on 2026-09-22");
    // Provenance keeps the audit scan order (occurred_at, id) — same set of
    // ids as the seeded rows, order not pinned to insertion.
    expect([...(rows[1]!.source_refs as string[])].sort()).toEqual([...rateIds].sort());
  });

  it("reconcile-unknown sentinel: attempts stuck unknown beyond 24h earn one lesson; fresh unknowns and reconciled rows never count", async () => {
    // Parent intent (FK target) + domain (this suite seeds no domains).
    await db.pool.query(
      `INSERT INTO domains (key, name, sensitivity, retention_class, storage_mode)
       VALUES ('personal', 'Personal', 'normal', 'standard', 'local') ON CONFLICT (key) DO NOTHING`,
    );
    const domainRow = await db.pool.query("SELECT id FROM domains WHERE key = 'personal'");
    const runRow = await db.pool.query(
      `INSERT INTO runs (kind, status, principal_id, domain_id)
       SELECT 'workflow', 'running', p.id, d.id FROM principals p, domains d
       WHERE p.id = $1::uuid AND d.key = 'personal' RETURNING id`,
      [principalId],
    );
    const intent = await db.pool.query(
      `INSERT INTO action_intents (run_id, capability, resource, domain_id, status)
       VALUES ($1::uuid, 'act:test', 'test', $2::uuid, 'approved') RETURNING id`,
      [String(runRow.rows[0]!.id), String(domainRow.rows[0]!.id)],
    );
    const intentId = String(intent.rows[0]!.id);

    async function seedAttempt(outcome: string, startedAt: Date): Promise<string> {
      const row = await db.pool.query(
        `INSERT INTO action_attempts (intent_id, provider, outcome, started_at)
         VALUES ($1::uuid, 'test-provider', $2, $3::timestamptz) RETURNING id`,
        [intentId, outcome, startedAt.toISOString()],
      );
      return String(row.rows[0]!.id);
    }

    // NOW is 2026-09-22T12:00Z. No scan window for this signal: an unknown
    // attempt owes reconciliation regardless of age. Aging unknown: 2 days ✓.
    const agingUnknown = await seedAttempt("unknown", new Date(NOW.getTime() - 48 * 3_600_000));
    // Fresh unknown: 2h old — honest unknown, not yet owed reconciliation.
    await seedAttempt("unknown", new Date(NOW.getTime() - 2 * 3_600_000));
    // Ancient unknown (3 days): STILL owed — age never excuses it.
    const ancientUnknown = await seedAttempt("unknown", new Date(NOW.getTime() - 72 * 3_600_000));
    // Reconciled: never counts (distinct started_at — (intent, started_at) is unique).
    await seedAttempt("reconciled", new Date(NOW.getTime() - 47 * 3_600_000));

    const result = await runLessonHarvestTick(db.pool, { principalIds: [principalId], now: NOW });
    expect(result.unknownAttempts).toBe(2);

    const rows = await lessonRows();
    const mine = rows.find((r) => r.item_id === "action outcomes stuck unknown");
    expect(mine).toBeDefined();
    expect(mine!.verdict).toBe("proposed");
    expect(mine!.note).toBe(
      "2 action attempts still unknown beyond 24h on Sep 19, Sep 20 — reconciliation owed (ADR-0011)",
    );
    expect(mine!.source_refs).toEqual([ancientUnknown, agingUnknown]);

    // Idempotent: a second tick refreshes, never duplicates.
    const again = await runLessonHarvestTick(db.pool, { principalIds: [principalId], now: NOW });
    expect(again.unknownAttempts).toBe(2);
    const count = await db.pool.query(
      `SELECT count(*)::int AS n FROM feedback WHERE item_type = 'lesson' AND item_id = 'action outcomes stuck unknown'`,
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("an empty day proposes nothing and never crashes", async () => {
    const result = await runLessonHarvestTick(db.pool, { principalIds: [principalId], now: NOW });
    expect(result).toEqual({
      proposed: 0,
      refreshed: 0,
      claimAuditRows: 0,
      expiredRatified: 0,
      rateLimited: 0,
      unknownAttempts: 0,
      scope: [principalId],
    });
    expect(await lessonRows()).toEqual([]);
  });

  it("an empty scope is a clean no-op tick", async () => {
    const result = await runLessonHarvestTick(db.pool, { principalIds: [], now: NOW });
    expect(result.proposed).toBe(0);
    expect(result.scope).toEqual([]);
    expect(await lessonRows()).toEqual([]);
  });

  it("tick logs carry the workflow tag and never lesson notes", async () => {
    logSpy.mockClear();
    await seedAudit("converse.claim_audit", { claim_type: "persistence", remediation: "deterministic_replace" }, SEP21);
    await seedAudit("converse.claim_audit", { claim_type: "persistence", remediation: "deterministic_replace" }, SEP22);
    await runLessonHarvestTick(db.pool, { principalIds: [principalId], now: NOW });
    const lines = logSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("lesson-harvest"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const summary = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((l) => "proposed" in l);
    expect(summary).toMatchObject({ workflow: "lesson-harvest", proposed: 1 });
  });
});
