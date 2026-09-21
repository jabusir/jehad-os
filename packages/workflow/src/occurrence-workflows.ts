/**
 * Scheduled calendar occurrence sweep (W5(b), plan §7 W5(b)): hourly
 * read-then-label pass — events whose end_time passed the 30-minute grace
 * AND are still occurrence-NULL graduate to the `scheduled_past_unverified`
 * FLOOR. Time passing is never evidence of occurring (§5 invariant 7): the
 * sweep never sets observed_*; graduation happens only through explicit
 * principal declaration (core confirmOccurrence). Deterministic +
 * idempotent; reports counts (never content) to the log and audit
 * (thread-retention pattern). No external calls, no tokens.
 */

import { Pool } from "pg";
import { recordAudit, sweepPastUnverified } from "@jehad/core";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";

export interface CalendarOccurrenceSweepResult {
  readonly marked: number;
}

async function sweepWithPool(): Promise<CalendarOccurrenceSweepResult> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    const { marked } = await sweepPastUnverified(pool, { now: new Date() });
    await recordAudit(pool, {
      actor: "system:calendar-occurrence",
      action: "calendar.occurrence.swept",
      reversible: true,
      outputsRef: JSON.stringify({ marked }),
    });
    console.log(JSON.stringify({ workflow: "calendar-occurrence-sweep", marked }));
    return { marked };
  } finally {
    await pool.end();
  }
}

export const calendarOccurrenceSweepWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "calendar-occurrence-sweep",
  cron: "0 * * * *",
  fn: async (ctx): Promise<CalendarOccurrenceSweepResult> =>
    ctx.step.run("sweep-past-unverified", () => sweepWithPool()),
});
