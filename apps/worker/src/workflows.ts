/**
 * Worker-registered workflows: infrastructure smoke (M3) + the scheduled
 * brief workflows (M6B: morning brief 07:00 UTC, evening close 21:00 UTC),
 * calendar sync (E3, every 15 min), calendar occurrence sweep (W5b,
 * hourly), gmail sync (Phase GMAIL, every 5 min), thread retention
 * (Phase D, hourly), calibration (lane C2: daily prompt 20:30 local +
 * weekly Sunday 20:00 local rollup), and the SV3 nightly lesson harvest
 * (03:30 local guarded tick).
 */

import {
  defineWorkflow,
  briefWorkflows,
  calibrationWorkflows,
  calendarOccurrenceSweepWorkflow,
  grantReminderWorkflow,
  calendarSyncWorkflow,
  gmailSyncWorkflow,
  threadRetentionWorkflow,
  reminderSweepWorkflow,
  lessonHarvestWorkflow,
} from "@jehad/workflow";

export const smokeWorkflow = defineWorkflow({
  name: "smoke",
  fn: async (ctx) => {
    const result = await ctx.step.run("echo", async () => ({ received: ctx.input }));
    return result;
  },
});

export const workflows = [
  smokeWorkflow,
  ...briefWorkflows,
  calendarSyncWorkflow,
  calendarOccurrenceSweepWorkflow,
  grantReminderWorkflow,
  reminderSweepWorkflow,
  gmailSyncWorkflow,
  threadRetentionWorkflow,
  ...calibrationWorkflows,
  lessonHarvestWorkflow,
];
