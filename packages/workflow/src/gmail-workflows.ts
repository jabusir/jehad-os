/**
 * Scheduled Gmail sync workflow (Phase GMAIL, plan §3): pulls inbox changes
 * every 5 minutes via the read-only sensor (packages/core/src/gmail) and
 * lands content-free `gmail.message.received` events + extraction
 * candidates. Read-only toward Google — the sensor never sends, replies,
 * or composes email in v1.
 *
 * Token: the ADAPTER's gmailTokenProvider (GMAIL_ACCESS_TOKEN env first,
 * else the `jehad-gmail` Keychain item — infra/gmail/README.md). When
 * neither is present the sync SKIPS cleanly.
 *
 * Grant (ADR-0007, plan §9.4): each tick mints a short-lived `gmail:ingest`
 * grant on `gmail:owner-inbox` (personal domain), verifies it before any
 * work, and revokes it at run end — no standing grant exists to steal;
 * renewal is the next tick's fresh mint.
 */

import { Pool } from "pg";
import { issueGrant, revokeGrant, syncGmail, verifyGrant, type SqlExecutor } from "@jehad/core";
import { createGmailSource, gmailTokenProvider } from "@jehad/adapters";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";

export interface GmailSyncResult {
  readonly skipped?: string;
  readonly status?: string;
  readonly newEvents?: number;
}

/** The workflow's own identity — grantee of the per-run grant, audit actor. */
export const GMAIL_SYNC_ACTOR = "system:gmail-sync";

/** Plan §9.4 grant vocabulary: capability, resource, domain. */
export const GMAIL_INGEST_CAPABILITY = "gmail:ingest";
export const GMAIL_INGEST_RESOURCE = "gmail:owner-inbox";
export const GMAIL_SYNC_DOMAIN_KEY = "personal";

/** TTL = the run; one cron period is the safety net (revocation is explicit). */
export const GMAIL_SYNC_GRANT_TTL_MS = 5 * 60_000;

// Resolve-or-create the workflow principal (the notifications service
// pattern: idempotent upsert on the UNIQUE name).
const PRINCIPAL_UPSERT = `
  WITH ins AS (
    INSERT INTO principals (type, name) VALUES ('workflow', $1)
    ON CONFLICT (name) DO NOTHING
    RETURNING id
  )
  SELECT id FROM ins
  UNION ALL
  SELECT id FROM principals WHERE name = $1
  LIMIT 1
`;

/**
 * One sync tick against an injected executor: resolve principal + domain,
 * mint/verify the per-run grant, run the sensor, revoke at run end — also
 * the manual-run entry point (tsx; infra/gmail/README.md).
 */
export async function runGmailSyncTick(db: SqlExecutor, token: string): Promise<GmailSyncResult> {
  try {
    const principal = await db.query(PRINCIPAL_UPSERT, [GMAIL_SYNC_ACTOR]);
    const principalId = principal.rows[0]?.id;
    const domain = await db.query("SELECT id FROM domains WHERE key = $1 LIMIT 1", [
      GMAIL_SYNC_DOMAIN_KEY,
    ]);
    const domainId = domain.rows[0]?.id;
    if (principalId === undefined || domainId === undefined) {
      throw new Error("gmail-sync: workflow principal or personal domain missing (pnpm setup:db / migrate)");
    }

    const source = createGmailSource({ tokenProvider: () => token });
    const issued = await issueGrant(db, {
      principalId: String(principalId),
      runId: null,
      capability: GMAIL_INGEST_CAPABILITY,
      resource: GMAIL_INGEST_RESOURCE,
      domainId: String(domainId),
      ttlMs: GMAIL_SYNC_GRANT_TTL_MS,
    });
    try {
      const decision = await verifyGrant(db, issued.token, {
        principalId: String(principalId),
        capability: GMAIL_INGEST_CAPABILITY,
        resource: GMAIL_INGEST_RESOURCE,
        domainId: String(domainId),
      });
      if (!decision.allowed) {
        throw new Error(`gmail-sync: ${GMAIL_INGEST_CAPABILITY} grant denied (${decision.reason})`);
      }
      const report = await syncGmail(db, source, { now: () => new Date(), policy: undefined, actor: GMAIL_SYNC_ACTOR });
      const outcome: GmailSyncResult = { status: report.status, newEvents: report.newEvents };
      console.log(JSON.stringify({ workflow: "gmail-sync", ...outcome }));
      return outcome;
    } finally {
      await revokeGrant(db, issued.grant.id);
    }
  } catch (err) {
    // The token itself never enters logs — name/status only.
    console.log(
      JSON.stringify({
        workflow: "gmail-sync",
        error: err instanceof Error ? err.name : "unknown",
        status: typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : undefined,
      }),
    );
    throw err;
  }
}

async function syncWithPool(): Promise<GmailSyncResult> {
  // gmailTokenProvider: GMAIL_ACCESS_TOKEN first, else the hourly refresher's
  // `jehad-gmail` Keychain item (the LaunchAgent sets no env). The provider
  // THROWS when no token exists (env unset + keychain item missing) — map to
  // the documented clean skip, not a thrown tick.
  let token: string;
  try {
    token = await gmailTokenProvider();
  } catch {
    console.log(JSON.stringify({ workflow: "gmail-sync", skipped: "no-token" }));
    return { skipped: "no-token" };
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    return await runGmailSyncTick(pool, token);
  } finally {
    await pool.end();
  }
}

export const gmailSyncWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "gmail-sync",
  cron: "*/5 * * * *",
  fn: async (ctx): Promise<GmailSyncResult> =>
    ctx.step.run("sync-gmail", () => syncWithPool()),
});
