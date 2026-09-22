// Reminder sweep (W6 phase 2, R3 lane): every 15 minutes, drain the armed
// reminders whose touch is due (core dueTouches) and deliver each one
// through the SAME notification queue the briefs use
// (enqueueBriefNotification → kind=brief rows the edge drains and texts
// the principal). Schedule math, templates, and quiet-hours policy stay in
// core lifecycle.ts; this module owns delivery, state advance
// (recordTouch / parkReminder), probe-state attachment on the principal's
// active interaction thread, and the reminder.touch audit row.
//
// Idempotency: recordTouch's armed-guarded UPDATE moves next_touch_at
// forward, so a second sweep at the same clock sees nothing due (the
// calendar-occurrence-sweep serialization precedent). Defense in depth on
// top: a per-reminder fresh re-read before sending — if the row left
// 'armed' or its next touch moved since the sweep SELECT (a concurrent
// writer claimed/resolved it), the reminder is skipped, never double-sent.
// The whole pass is one memoized step, so crash+replay cannot re-run a
// completed pass.
//
// Quiet hours (22:00–07:00 America/Los_Angeles, lifecycle REMINDER_POLICY):
// schedule math should never land a touch there; the sweep still refuses to
// SEND inside the window — skip + log, row untouched, fires on a later pass.

import { Pool } from "pg";
import {
  enqueueBriefNotification,
  recordAudit,
  resolveActiveThread,
  UUID_RE,
} from "@jehad/core";
// TODO(core): the barrel does not carry the reminders module yet — these
// deep imports collapse to "@jehad/core" once packages/core/src/index.ts
// exports ./reminders/queries.js + ./reminders/lifecycle.js.
import {
  ReminderNotFoundError,
  ReminderNotArmedError,
  dueTouches,
  getReminder,
  parkReminder,
  recordTouch,
} from "../../core/src/reminders/queries.js";
import {
  REMINDER_POLICY,
  dueWordFor,
  scheduleAfterTouch,
  touchMessage,
} from "../../core/src/reminders/lifecycle.js";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";

export const REMINDER_SWEEP_CRON = "*/15 * * * *";
/** The conversation surface the probe state rides on (conversation.ts's
 *  CONVERSATION_SURFACE, which is module-private there). */
export const REMINDER_SURFACE = "imessage";
export const REMINDER_SWEEP_ACTOR = "system:reminder-sweep";
export const REMINDER_TOUCH_AUDIT_ACTION = "reminder.touch";
/** Delivery title on the shared notification queue (the edge's render). */
export const REMINDER_NOTIFICATION_TITLE = "Reminder";

export interface ReminderSweepResult {
  readonly sent: number;
  readonly skippedQuiet: number;
  readonly parked: number;
}

/** Probe state the inbound lane consumes off the thread metadata (EXACT shape). */
export interface PendingProbe {
  readonly reminderId: string;
  readonly kind: "probe" | "nudge";
  readonly sentAt: string;
}

/** Wall-clock hour of `now` in the policy timezone (DST-correct, Intl). */
function localHourOf(instant: Date, timeZone: string): number {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(instant),
  );
  return hour % 24; // hourCycle quirk: 24 for midnight in some engines
}

/** Quiet window is [quietStart, next-day quietEnd) — same as lifecycle. */
function isQuietNow(now: Date): boolean {
  const hour = localHourOf(now, REMINDER_POLICY.timeZone);
  return hour >= REMINDER_POLICY.quietStartHour || hour < REMINDER_POLICY.quietEndHour;
}

/**
 * reminders.principal is a text id (feedback.created_by convention); the
 * interaction_threads owner is a principals uuid. Resolve by exact uuid
 * pass-through, else by unique principal name.
 */
async function resolvePrincipalUuid(db: Pool, principal: string): Promise<string | null> {
  if (UUID_RE.test(principal)) return principal;
  const row = await db.query(`SELECT id FROM principals WHERE name = $1 LIMIT 1`, [principal]);
  return row.rows[0] === undefined ? null : String(row.rows[0].id);
}

/**
 * Attach pendingProbe to the principal's ACTIVE thread — the thread the
 * inbound lane reads. Threads.ts's metadata writer (setThreadPendingProposal)
 * is strictly fail-closed (parseThreadMetadata nulls unknown keys), so until
 * a pendingProbe-aware writer exists in core this mirrors its exact
 * protocol — FOR UPDATE, owner check, sibling keys preserved — as a raw
 * jsonb merge that keeps every sibling key byte-for-byte (including
 * pendingProposal). The capture-time thread wins while still active;
 * otherwise the thread is ensured the same way outbound conversation does
 * (resolveActiveThread creates on absence/turnover).
 */
async function attachPendingProbe(
  db: Pool,
  opts: {
    readonly principal: string;
    readonly threadId: string | null;
    readonly probe: PendingProbe;
    readonly now: Date;
  },
): Promise<void> {
  const principalId = await resolvePrincipalUuid(db, opts.principal);
  if (principalId === null) {
    console.log(
      JSON.stringify({
        workflow: "reminder-sweep",
        skipped: "unknown-principal",
        reminderId: opts.probe.reminderId,
      }),
    );
    return;
  }
  let threadId: string | null = null;
  if (opts.threadId !== null) {
    const known = await db.query(
      `SELECT principal_id, status FROM interaction_threads WHERE id = $1::uuid`,
      [opts.threadId],
    );
    const row = known.rows[0];
    if (
      row !== undefined &&
      String(row.principal_id) === principalId &&
      String(row.status) === "active"
    ) {
      threadId = opts.threadId;
    }
  }
  if (threadId === null) {
    threadId = (await resolveActiveThread(db, {
      principalId,
      surface: REMINDER_SURFACE,
      now: opts.now,
    })).id;
  }
  const locked = await db.query(
    `SELECT principal_id, metadata FROM interaction_threads WHERE id = $1::uuid FOR UPDATE`,
    [threadId],
  );
  const thread = locked.rows[0];
  if (thread === undefined || String(thread.principal_id) !== principalId) {
    console.log(
      JSON.stringify({
        workflow: "reminder-sweep",
        skipped: "thread-owner-mismatch",
        reminderId: opts.probe.reminderId,
      }),
    );
    return;
  }
  const current =
    thread.metadata === null || typeof thread.metadata !== "object" || Array.isArray(thread.metadata)
      ? {}
      : (thread.metadata as Record<string, unknown>);
  const merged = { ...current, pendingProbe: opts.probe };
  await db.query(`UPDATE interaction_threads SET metadata = $2::jsonb WHERE id = $1::uuid`, [
    threadId,
    JSON.stringify(merged),
  ]);
}

/**
 * One sweep pass over dueTouches(pool, now). Principal-scoped processing
 * per reminder; content travels only through the notification payload
 * (logs carry ids/kinds/counts, never titles).
 */
export async function runReminderSweepTick(
  pool: Pool,
  opts: { now?: Date } = {},
): Promise<ReminderSweepResult> {
  const now = opts.now ?? new Date();
  const due = await dueTouches(pool, now);
  const result: { sent: number; skippedQuiet: number; parked: number } = {
    sent: 0,
    skippedQuiet: 0,
    parked: 0,
  };
  for (const reminder of due) {
    // (b) Delivery guard — defense in depth: never SEND inside quiet hours.
    if (isQuietNow(now)) {
      result.skippedQuiet += 1;
      console.log(
        JSON.stringify({
          workflow: "reminder-sweep",
          skipped: "quiet-hours",
          reminderId: reminder.id,
          kind: reminder.nextTouchKind,
        }),
      );
      continue;
    }
    // Per-reminder overlap guard: another writer claimed/resolved the row
    // between the sweep SELECT and now → skip, never double-send.
    const fresh = await getReminder(pool, reminder.id);
    if (
      fresh === null ||
      fresh.status !== "armed" ||
      fresh.nextTouchAt !== reminder.nextTouchAt
    ) {
      continue;
    }
    const kind = reminder.nextTouchKind;
    if (kind === null) {
      // dueTouches keys on next_touch_at; a null kind here is a data bug.
      console.log(
        JSON.stringify({ workflow: "reminder-sweep", skipped: "null-kind", reminderId: reminder.id }),
      );
      continue;
    }

    // (c) Send on the briefs' queue (same drain, same edge render).
    const dueWord =
      kind === "morning" ? dueWordFor(reminder.dueDate, now) : "today";
    const content = touchMessage(kind, {
      title: reminder.title,
      escalations: reminder.escalations,
      dueWord,
    });
    await enqueueBriefNotification(pool, {
      title: REMINDER_NOTIFICATION_TITLE,
      content,
      artifactId: reminder.id,
      now,
    });

    // (d) Advance: pre-schedule the follow-up, or record-and-park at the
    // nudge cap. escalations is the PRE-touch count — recordTouch does the
    // nudge increment. A concurrent resolution lands ReminderNotArmedError:
    // the touch already went out, so log and move on (the row is terminal).
    let parked = false;
    try {
      const next = scheduleAfterTouch({ kind, at: now, escalations: reminder.escalations });
      if (next !== null) {
        await recordTouch(pool, reminder.id, {
          at: now,
          kind,
          nextTouchAt: next.at,
          nextTouchKind: next.kind,
        });
      } else {
        await recordTouch(pool, reminder.id, {
          at: now,
          kind,
          nextTouchAt: null,
          nextTouchKind: null,
        });
        await parkReminder(pool, reminder.id, now);
        parked = true;
      }
    } catch (err) {
      if (err instanceof ReminderNotArmedError || err instanceof ReminderNotFoundError) {
        console.log(
          JSON.stringify({
            workflow: "reminder-sweep",
            skipped: "not-armed",
            reminderId: reminder.id,
          }),
        );
        continue;
      }
      throw err;
    }
    if (parked) result.parked += 1;

    // (e) Probe state for the inbound lane (exact PendingProbe shape).
    if (kind === "probe" || kind === "nudge") {
      await attachPendingProbe(pool, {
        principal: reminder.principal,
        threadId: reminder.threadId,
        probe: { reminderId: reminder.id, kind, sentAt: now.toISOString() },
        now,
      });
    }

    // (f) Audit — ids only (thread-retention pattern).
    await recordAudit(pool, {
      actor: REMINDER_SWEEP_ACTOR,
      action: REMINDER_TOUCH_AUDIT_ACTION,
      reversible: true,
      outputsRef: JSON.stringify({ reminderId: reminder.id, principal: reminder.principal, kind }),
    });

    result.sent += 1;
    console.log(JSON.stringify({ workflow: "reminder-sweep", reminderId: reminder.id, kind }));
  }
  console.log(JSON.stringify({ workflow: "reminder-sweep", ...result }));
  return result;
}

async function sweepWithPool(): Promise<ReminderSweepResult> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    const result = await runReminderSweepTick(pool);
    return result;
  } finally {
    await pool.end();
  }
}

export const reminderSweepWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "reminder-sweep",
  cron: REMINDER_SWEEP_CRON,
  fn: async (ctx): Promise<ReminderSweepResult> =>
    ctx.step.run("reminder-sweep-tick", () => sweepWithPool()),
});
