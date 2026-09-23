// Grant-expiry reminder (owner directive 2026-09-21): owner-held TTL
// grants are renewed MANUALLY by design; the system's obligation is a
// deterministic iMessage reminder with a one-step renewal path, sent
// once per grant at T-48h, at a sane local hour (never quiet hours).

import { Pool } from "pg";
import { createNotification, workflowNotificationsConfig } from "@jehad/core";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";
import { isLocalHour } from "./brief-workflows.js";

export const GRANT_REMINDER_LOCAL_HOUR = 10;
export const GRANT_REMINDER_LEAD_HOURS = 48;

const REMINDER_GRANTS = [
  { capability: "imessage:ingest", resource: "imessage", renewal: "pnpm renew:ingest" },
] as const;

export type GrantReminderOutcome =
  | { status: "outside-window" }
  | { status: "reminded"; grantId: string; notificationId: string }
  | { status: "already-reminded"; grantId: string }
  | { status: "no-grant" };

export async function runGrantReminderTick(
  pool: Pool,
  opts: { now?: () => Date; actor?: string } = {},
): Promise<GrantReminderOutcome> {
  const now = opts.now?.() ?? new Date();
  const target = REMINDER_GRANTS[0]!;
  // EARLIEST-expiring live grant, not latest: the reminder must protect the
  // token the sensor actually holds. A minted-but-never-deployed newer
  // grant would otherwise park the reminder past the held token's death
  // (F5 finding, 2026-09-22: sensor held the Sep 25 grant while the
  // reminder aimed at a Sep 28 mint — two days late). renew:ingest now
  // revokes superseded grants, so drift self-heals; earliest is the
  // conservative target either way.
  const grant = await pool.query(
    `SELECT id, expires_at FROM capability_grants
      WHERE capability = $1 AND resource = $2 AND revoked_at IS NULL
      ORDER BY expires_at ASC LIMIT 1`,
    [target.capability, target.resource],
  );
  const row = grant.rows[0];
  if (row === undefined) return { status: "no-grant" };
  const grantId = String(row.id);
  const expiresAt = new Date(String(row.expires_at));
  const hoursLeft = (expiresAt.getTime() - now.getTime()) / (60 * 60 * 1000);
  if (hoursLeft > GRANT_REMINDER_LEAD_HOURS || hoursLeft <= 0) return { status: "outside-window" };

  const existing = await pool.query(
    `SELECT id FROM notifications WHERE kind = 'grant-reminder' AND source_id = $1 LIMIT 1`,
    [grantId],
  );
  if (existing.rows.length > 0) return { status: "already-reminded", grantId };

  const service = await pool.query(
    `WITH ins AS (
       INSERT INTO principals (type, name) VALUES ('service', 'service/grant-reminder')
       ON CONFLICT (name) DO NOTHING RETURNING id
     )
     SELECT id FROM ins UNION ALL SELECT id FROM principals WHERE name = 'service/grant-reminder' LIMIT 1`,
  );
  const domain = await pool.query("SELECT id FROM domains WHERE key = $1", ["personal"]);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const content =
    `${target.capability} expires ${fmt.format(expiresAt)} PT. ` +
    `Renew in one step:\ncd ~/Projects/jehad-os && ${target.renewal}`;
  const notification = await createNotification(
    pool,
    {
      kind: "grant-reminder",
      title: "Grant renewal needed",
      payload: { content, capability: target.capability },
      domainId: domain.rows[0] !== undefined ? String(domain.rows[0].id) : null,
      sourceType: "run",
      sourceId: grantId,
      createdBy: String(service.rows[0].id),
    },
    // Policy config explicit: the reminder must be born approved and
    // claimable (the F5 renewal-deadline path) — never the default fallback.
    {
      actor: opts.actor ?? "system:grant-reminder",
      now: () => now,
      config: await workflowNotificationsConfig(),
    },
  );
  return { status: "reminded", grantId, notificationId: notification.id };
}

export interface GrantReminderResult {
  readonly status: string;
}

async function reminderWithPool(): Promise<GrantReminderResult> {
  if (!isLocalHour(new Date(), GRANT_REMINDER_LOCAL_HOUR)) {
    return { status: "skipped-window" };
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    const outcome = await runGrantReminderTick(pool);
    console.log(JSON.stringify({ workflow: "grant-expiry-reminder", status: outcome.status }));
    return { status: outcome.status };
  } finally {
    await pool.end();
  }
}

export const grantReminderWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "grant-expiry-reminder",
  cron: "15 * * * *",
  fn: async (ctx): Promise<GrantReminderResult> =>
    ctx.step.run("grant-reminder-tick", () => reminderWithPool()),
});
