/**
 * Scheduled brief/close workflows (M6B; plan §13 "cron brief workflow →
 * queries → brief artifact (postgres)").
 *
 * TIME-WINDOW SEMANTICS (documented per task): the executor's cron
 * granularity is per-minute and evaluates in UTC. The morning brief runs on
 * an HOURLY cron (minute 0) whose body renders+persists only inside the
 * 07:00 UTC window (UTC hour === 7); every other hourly firing is a no-op.
 * The guard also covers executor retries drifting past the window. The
 * evening close pins its own 21:00 UTC cron with the same hour guard.
 * Manual/off-schedule rendering is `josctl brief [--close]`.
 *
 * Each firing builds its own pg pool from DATABASE_URL inside a memoized
 * step (short-lived, closed in finally) so the definition array is a
 * drop-in export for the worker. Wire-up (apps/worker/src/workflows.ts):
 *   export const workflows = [smokeWorkflow, ...briefWorkflows];
 */

import { Pool } from "pg";
import { BRIEF_TIMEZONE, renderEveningClose, renderMorningBrief, type BriefOutcome } from "@jehad/core";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";




export interface ScheduledRenderResult {
  /** True when the firing happened outside its local-hour window (no-op, no step). */
  readonly skippedWindow?: boolean;
  /** The render outcome when the window was active. */
  readonly outcome?: BriefOutcome;
}

/** Pure local-hour window check in the owner's timezone (DST-safe via
 *  Intl — no UTC-offset math). Exported for deterministic tests. */
export const BRIEF_LOCAL_TZ = BRIEF_TIMEZONE; // America/Los_Angeles (core: briefs/timezone)
export const MORNING_BRIEF_LOCAL_HOUR = 6; // 6 AM PT
export const EVENING_CLOSE_LOCAL_HOUR = 21; // 9 PM PT

export function isLocalHour(date: Date, hour: number, timeZone = BRIEF_LOCAL_TZ): boolean {
  const localHour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(date),
  );
  return localHour === hour;
}

async function renderWithPool(
  render: (db: Pool) => Promise<BriefOutcome>,
): Promise<BriefOutcome> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    return await render(pool);
  } finally {
    await pool.end();
  }
}

export const morningBriefWorkflow = defineScheduledWorkflow({
  name: "brief-morning",
  cron: "0 * * * *",
  fn: async (ctx): Promise<ScheduledRenderResult> => {
    if (!isLocalHour(new Date(), MORNING_BRIEF_LOCAL_HOUR)) return { skippedWindow: true };
    const outcome = await ctx.step.run("render-morning-brief", () =>
      renderWithPool((db) => renderMorningBrief(db, { notify: true })),
    );
    return { outcome };
  },
});

export const eveningCloseWorkflow = defineScheduledWorkflow({
  name: "brief-evening",
  cron: "0 * * * *",
  fn: async (ctx): Promise<ScheduledRenderResult> => {
    if (!isLocalHour(new Date(), EVENING_CLOSE_LOCAL_HOUR)) return { skippedWindow: true };
    const outcome = await ctx.step.run("render-evening-close", () =>
      renderWithPool((db) => renderEveningClose(db, { notify: true })),
    );
    return { outcome };
  },
});

/** Registration export for the worker (see file-header wire-up note). */
export const briefWorkflows: readonly ScheduledWorkflowDefinition[] = [
  morningBriefWorkflow,
  eveningCloseWorkflow,
];
