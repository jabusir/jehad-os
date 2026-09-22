// Reminder sweep workflow tests (W6 phase 2, R3 lane): definition shape
// (15-minute cron, valid name), worker-server serving, and integration
// ticks over a real migrated database (occurrence-workflows test pattern)
// pinning the outbound touch loop end-to-end: delivery on the briefs'
// notification queue with exact touchMessage content, next-touch advance,
// pendingProbe thread metadata (exact shape), escalation to the nudge cap,
// parking, the quiet-hours send guard, and same-clock idempotency.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../tests/isolated-db.js";
import { reminderSweepWorkflow, runReminderSweepTick } from "./reminder-workflows.js";
import { createWorkflowWorkerServer } from "./index.js";
import { assertWorkflowToken } from "./names.js";
import { createReminder, getReminder } from "../../core/src/reminders/queries.js";

const FIVE_FIELD_CRON_RE = /^(\S+ ){4}\S+$/;

describe("reminder-sweep workflow definition", () => {
  it("exports a valid cron definition pinned to the 15-minute cadence", () => {
    expect(reminderSweepWorkflow.kind).toBe("cron");
    expect(reminderSweepWorkflow.name).toBe("reminder-sweep");
    expect(reminderSweepWorkflow.cron).toBe("*/15 * * * *");
    expect(reminderSweepWorkflow.cron).toMatch(FIVE_FIELD_CRON_RE);
    expect(() => assertWorkflowToken("workflow name", reminderSweepWorkflow.name)).not.toThrow();
    expect(typeof reminderSweepWorkflow.fn).toBe("function");
  });

  it("serves through the worker server (compiles to executor functions)", () => {
    const server = createWorkflowWorkerServer({ workflows: [reminderSweepWorkflow] });
    expect(typeof server.listen).toBe("function");
    server.close();
  });
});

// ----------------------------------------------------------- integration

// September 2026: PT = UTC-7. Anchors — 10:00 PT = 17:00Z, probe 15:30 PT =
// 22:30Z, next workday start 09:00 PT = 16:00Z, 23:30 PT = 06:30Z (next UTC day).
const MON_10AM = new Date("2026-09-21T17:00:00Z");
const MON_335PM = new Date("2026-09-21T22:35:00Z");
const TUE_905AM = new Date("2026-09-22T16:05:00Z");
const WED_905AM = new Date("2026-09-23T16:05:00Z");
const THU_905AM = new Date("2026-09-24T16:05:00Z");
const SUN_1130PM = new Date("2026-09-21T06:30:00Z"); // 23:30 PT Sunday

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("reminder-sweep tick (integration)", () => {
  let db: IsolatedDb;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "wfremswp");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    logSpy.mockRestore();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function seedPrincipal(name: string): Promise<string> {
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
      [name],
    );
    return String(row.rows[0]!.id);
  }

  async function seedReminder(input: {
    principal: string;
    title: string;
    dueDate: string;
    nextTouchAt: Date;
    nextTouchKind: "morning" | "probe" | "nudge";
    threadId?: string | null;
    escalations?: number;
  }): Promise<string> {
    const reminder = await createReminder(db.pool, {
      principal: input.principal,
      title: input.title,
      dueDate: input.dueDate,
      dueTime: null,
      firstTouchAt: input.nextTouchAt,
      firstTouchKind: input.nextTouchKind,
      threadId: input.threadId ?? null,
    });
    if (input.escalations !== undefined) {
      await db.pool.query(`UPDATE reminders SET escalations = $2 WHERE id = $1::uuid`, [
        reminder.id,
        input.escalations,
      ]);
    }
    return reminder.id;
  }

  async function notificationsFor(reminderId: string): Promise<
    { title: string; content: string }[]
  > {
    const rows = await db.pool.query(
      `SELECT title, payload->>'content' AS content FROM notifications
        WHERE source_type = 'brief' AND source_id = $1
        ORDER BY created_at ASC, id ASC`,
      [reminderId],
    );
    return rows.rows.map((row) => ({ title: String(row.title), content: String(row.content) }));
  }

  async function metadataOf(threadId: string): Promise<Record<string, unknown>> {
    const row = await db.pool.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
      threadId,
    ]);
    const metadata = row.rows[0]!.metadata;
    return metadata === null ? {} : (JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>);
  }

  async function activeThreadIdFor(principalId: string): Promise<string> {
    const row = await db.pool.query(
      `SELECT id FROM interaction_threads
        WHERE principal_id = $1::uuid AND status = 'active' LIMIT 1`,
      [principalId],
    );
    return String(row.rows[0]!.id);
  }

  async function touchAudits(reminderId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.pool.query(
      `SELECT outputs_ref FROM audit_log
        WHERE actor = 'system:reminder-sweep' AND action = 'reminder.touch'
          AND outputs_ref::jsonb->>'reminderId' = $1
        ORDER BY created_at ASC, id ASC`,
      [reminderId],
    );
    return rows.rows.map((row) => JSON.parse(String(row.outputs_ref)) as Record<string, unknown>);
  }

  /** Tests share one db: cancel every armed leftover so the shared sweep
   *  feed starts empty and per-test result counters stay exact. */
  async function disarmAll(): Promise<void> {
    await db.pool.query(
      `UPDATE reminders SET status = 'cancelled', next_touch_at = NULL,
              next_touch_kind = NULL, cancelled_via = 'manual'
        WHERE status = 'armed'`,
    );
  }

  it("armed reminder due now → touch enqueued with exact content, next_touch advanced to probe time", async () => {
    await disarmAll();
    await seedPrincipal("jehad-morning");
    const reminderId = await seedReminder({
      principal: "jehad-morning",
      title: "File the tax docs",
      dueDate: "2026-09-21",
      nextTouchAt: new Date("2026-09-21T16:55:00Z"),
      nextTouchKind: "morning",
    });

    const result = await runReminderSweepTick(db.pool, { now: MON_10AM });
    expect(result).toEqual({ sent: 1, skippedQuiet: 0, parked: 0 });

    expect(await notificationsFor(reminderId)).toEqual([
      { title: "Reminder", content: "Reminder: File the tax docs — today." },
    ]);

    const row = await getReminder(db.pool, reminderId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("armed");
    expect(row!.escalations).toBe(0);
    expect(new Date(row!.lastTouchAt!).toISOString()).toBe(MON_10AM.toISOString());
    expect(new Date(row!.nextTouchAt!).toISOString()).toBe("2026-09-21T22:30:00.000Z"); // same-day 15:30 PT probe
    expect(row!.nextTouchKind).toBe("probe");

    expect(await touchAudits(reminderId)).toEqual([
      { reminderId, principal: "jehad-morning", kind: "morning" },
    ]);
  });

  it("probe sent → pendingProbe metadata present on the principal's thread with the exact shape", async () => {
    await disarmAll();
    await seedPrincipal("jehad-probe");
    const principalRow = await db.pool.query(`SELECT id FROM principals WHERE name = $1`, [
      "jehad-probe",
    ]);
    const principalId = String(principalRow.rows[0]!.id);
    const thread = await db.pool.query(
      `INSERT INTO interaction_threads
         (id, principal_id, surface, status, created_at, last_activity_at,
          active_context_expires_at, raw_retention_expires_at)
       VALUES ($1, $2::uuid, 'imessage', 'active', $3, $3, $4, $5)
       RETURNING id`,
      [
        randomUUID(),
        principalId,
        MON_10AM.toISOString(),
        new Date(MON_10AM.getTime() + 72 * 3_600_000).toISOString(),
        new Date(MON_10AM.getTime() + 7 * 24 * 3_600_000).toISOString(),
      ],
    );
    const threadId = String(thread.rows[0]!.id);
    const reminderId = await seedReminder({
      principal: "jehad-probe",
      title: "Renew the passport",
      dueDate: "2026-09-21",
      nextTouchAt: new Date("2026-09-21T22:25:00Z"),
      nextTouchKind: "probe",
      threadId,
    });

    const result = await runReminderSweepTick(db.pool, { now: MON_335PM });
    expect(result).toEqual({ sent: 1, skippedQuiet: 0, parked: 0 });

    expect(await notificationsFor(reminderId)).toEqual([
      { title: "Reminder", content: "Did you get to Renew the passport?" },
    ]);
    expect(await metadataOf(threadId)).toEqual({
      pendingProbe: { reminderId, kind: "probe", sentAt: MON_335PM.toISOString() },
    });
    const row = await getReminder(db.pool, reminderId);
    expect(new Date(row!.nextTouchAt!).toISOString()).toBe("2026-09-22T16:00:00.000Z"); // next-day 09:00 PT nudge
    expect(row!.nextTouchKind).toBe("nudge");
  });

  it("unanswered probe → next sweep fires the nudge (escalations=1) and updates pendingProbe to kind nudge", async () => {
    await disarmAll();
    await seedPrincipal("jehad-nudge");
    // threadId null → the sweep ensures the principal's active thread itself.
    const reminderId = await seedReminder({
      principal: "jehad-nudge",
      title: "Book the dentist",
      dueDate: "2026-09-21",
      nextTouchAt: new Date("2026-09-21T22:25:00Z"),
      nextTouchKind: "probe",
    });

    const probePass = await runReminderSweepTick(db.pool, { now: MON_335PM });
    expect(probePass).toEqual({ sent: 1, skippedQuiet: 0, parked: 0 });

    const nudgePass = await runReminderSweepTick(db.pool, { now: TUE_905AM });
    expect(nudgePass).toEqual({ sent: 1, skippedQuiet: 0, parked: 0 });

    expect(await notificationsFor(reminderId)).toEqual([
      { title: "Reminder", content: "Did you get to Book the dentist?" },
      { title: "Reminder", content: "Still open: Book the dentist. Want to lock a time for it?" },
    ]);

    const row = await getReminder(db.pool, reminderId);
    expect(row!.status).toBe("armed");
    expect(row!.escalations).toBe(1);
    expect(new Date(row!.nextTouchAt!).toISOString()).toBe("2026-09-23T16:00:00.000Z");
    expect(row!.nextTouchKind).toBe("nudge");

    const principalRow = await db.pool.query(`SELECT id FROM principals WHERE name = $1`, [
      "jehad-nudge",
    ]);
    const threadId = await activeThreadIdFor(String(principalRow.rows[0]!.id));
    expect(await metadataOf(threadId)).toEqual({
      pendingProbe: { reminderId, kind: "nudge", sentAt: TUE_905AM.toISOString() },
    });
  });

  it("nudge at cap → next sweep parks the reminder (status parked, next_touch null) and never sends again", async () => {
    await disarmAll();
    await seedPrincipal("jehad-cap");
    const reminderId = await seedReminder({
      principal: "jehad-cap",
      title: "Return the library books",
      dueDate: "2026-09-21",
      nextTouchAt: new Date("2026-09-21T22:25:00Z"),
      nextTouchKind: "probe",
    });

    expect(await runReminderSweepTick(db.pool, { now: MON_335PM })).toEqual({
      sent: 1,
      skippedQuiet: 0,
      parked: 0,
    }); // probe
    expect(await runReminderSweepTick(db.pool, { now: TUE_905AM })).toEqual({
      sent: 1,
      skippedQuiet: 0,
      parked: 0,
    }); // nudge 1 (escalations 0 → 1)
    expect(await runReminderSweepTick(db.pool, { now: WED_905AM })).toEqual({
      sent: 1,
      skippedQuiet: 0,
      parked: 1,
    }); // nudge 2 at cap → park

    expect(await notificationsFor(reminderId)).toEqual([
      { title: "Reminder", content: "Did you get to Return the library books?" },
      {
        title: "Reminder",
        content: "Still open: Return the library books. Want to lock a time for it?",
      },
      {
        title: "Reminder",
        content: `Second nudge — Return the library books is still open. Say "stop" and I'll park it.`,
      },
    ]);

    const row = await getReminder(db.pool, reminderId);
    expect(row!.status).toBe("parked");
    expect(row!.nextTouchAt).toBeNull();
    expect(row!.nextTouchKind).toBeNull();
    expect(row!.escalations).toBe(2);
    expect(new Date(row!.parkedAt!).toISOString()).toBe(WED_905AM.toISOString());

    const afterPark = await runReminderSweepTick(db.pool, { now: THU_905AM });
    expect(afterPark).toEqual({ sent: 0, skippedQuiet: 0, parked: 0 });
    expect(await notificationsFor(reminderId)).toHaveLength(3);
  });

  it("quiet-hours guard: a reminder due inside 22:00–07:00 PT is NOT sent and stays armed untouched", async () => {
    await disarmAll();
    await seedPrincipal("jehad-quiet");
    const reminderId = await seedReminder({
      principal: "jehad-quiet",
      title: "Water the plants",
      dueDate: "2026-09-21",
      nextTouchAt: new Date("2026-09-21T06:00:00Z"), // 23:00 PT — inside quiet hours
      nextTouchKind: "morning",
    });

    const result = await runReminderSweepTick(db.pool, { now: SUN_1130PM }); // 23:30 PT
    expect(result).toEqual({ sent: 0, skippedQuiet: 1, parked: 0 });

    expect(await notificationsFor(reminderId)).toEqual([]);
    const row = await getReminder(db.pool, reminderId);
    expect(row!.status).toBe("armed");
    expect(new Date(row!.nextTouchAt!).toISOString()).toBe("2026-09-21T06:00:00.000Z");
    expect(row!.lastTouchAt).toBeNull();
  });

  it("idempotency: two sweeps at the same clock time send once", async () => {
    await disarmAll();
    await seedPrincipal("jehad-idem");
    const reminderId = await seedReminder({
      principal: "jehad-idem",
      title: "Pay the parking ticket",
      dueDate: "2026-09-21",
      nextTouchAt: new Date("2026-09-21T16:50:00Z"),
      nextTouchKind: "morning",
    });

    const first = await runReminderSweepTick(db.pool, { now: MON_10AM });
    expect(first).toEqual({ sent: 1, skippedQuiet: 0, parked: 0 });
    const second = await runReminderSweepTick(db.pool, { now: MON_10AM });
    expect(second).toEqual({ sent: 0, skippedQuiet: 0, parked: 0 });

    expect(await notificationsFor(reminderId)).toHaveLength(1);
  });
});
