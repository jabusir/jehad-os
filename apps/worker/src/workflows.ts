/**
 * Worker-registered workflows: infrastructure smoke (M3) + the scheduled
 * brief workflows (M6B: morning brief 07:00 UTC, evening close 21:00 UTC),
 * calendar sync (E3, every 15 min), gmail sync (Phase GMAIL, every 5 min),
 * and thread retention (Phase D, hourly).
 */

import {
  defineWorkflow,
  briefWorkflows,
  calendarSyncWorkflow,
  gmailSyncWorkflow,
  threadRetentionWorkflow,
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
  gmailSyncWorkflow,
  threadRetentionWorkflow,
];
