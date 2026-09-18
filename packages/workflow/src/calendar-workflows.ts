/**
 * Scheduled calendar sync workflow (E3): pulls Google Calendar changes every
 * 15 minutes via the read-only sensor (packages/core/src/calendar) and lands
 * observation events + projection updates. Read-only toward Google — the
 * sensor never writes back (owner directive, E3).
 *
 * Token: `security find-generic-password -s jehad-gcalendar -w` (or
 * GCALENDAR_ACCESS_TOKEN). When neither is present the sync SKIPS cleanly
 * (dogfooding starts once the owner provisions a token —
 * infra/calendar/README.md).
 *
 * Manual sync: see infra/calendar/README.md (syncCalendar via tsx).
 */

import { Pool } from "pg";
import { syncCalendar } from "@jehad/core";
import { createGoogleCalendarSource } from "@jehad/adapters";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";

export interface CalendarSyncResult {
  readonly skipped?: string;
  readonly changes?: number;
  readonly fullResync?: boolean;
}

async function syncWithPool(): Promise<CalendarSyncResult> {
  const token = process.env.GCALENDAR_ACCESS_TOKEN ?? null;
  const calendarId = process.env.GCALENDAR_ID ?? "primary";
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    if (token === null || token.length === 0) {
      return { skipped: "no-token" };
    }
    const source = createGoogleCalendarSource({ tokenProvider: async () => token, calendarId });
    const report = await syncCalendar(pool, source);
    return { changes: report.changes.length, fullResync: report.fullResync };
  } finally {
    await pool.end();
  }
}

export const calendarSyncWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "calendar-sync",
  cron: "*/15 * * * *",
  fn: async (ctx): Promise<CalendarSyncResult> =>
    ctx.step.run("sync-google-calendar", () => syncWithPool()),
});
