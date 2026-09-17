/**
 * Worker-registered workflows (M3): infrastructure validation only.
 * Domain workflows arrive with the core services that own them; until
 * then this exercises the full serve/dispatch path end to end.
 */

import { defineWorkflow } from "@jehad/workflow";

export const smokeWorkflow = defineWorkflow({
  name: "smoke",
  fn: async (ctx) => {
    const result = await ctx.step.run("echo", async () => ({ received: ctx.input }));
    return result;
  },
});

export const workflows = [smokeWorkflow];
