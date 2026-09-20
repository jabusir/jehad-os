/**
 * Phase D retention workflow (ADR-0014 §13): deletes raw conversational
 * content past the 7-day horizon and expired empty threads, hourly.
 * Deterministic + idempotent; reports counts (never content) to the log
 * and audit. Deletion failures THROW (inngest retries + surfaces) —
 * expired content must never silently accumulate.
 */

import { Pool } from "pg";
import { enforceRetention, recordAudit } from "@jehad/core";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";

export interface ThreadRetentionResult {
  readonly messagesDeleted: number;
  readonly threadsDeleted: number;
  readonly replyPayloadsRedacted: number;
}

async function retentionWithPool(): Promise<ThreadRetentionResult> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    const result = await enforceRetention(pool, { now: new Date() });
    await recordAudit(pool, {
      actor: "system:thread-retention",
      action: "interaction.retention",
      reversible: false,
      outputsRef: JSON.stringify(result),
    });
    console.log(JSON.stringify({ workflow: "thread-retention", ...result }));
    return result;
  } finally {
    await pool.end();
  }
}

export const threadRetentionWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "thread-retention",
  cron: "0 * * * *",
  fn: async (ctx): Promise<ThreadRetentionResult> =>
    ctx.step.run("enforce-interaction-retention", () => retentionWithPool()),
});
