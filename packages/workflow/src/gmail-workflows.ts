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
import {
  gmailSensorPolicyOf,
  issueGrant,
  parsePolicyV1,
  revokeGrant,
  syncGmail,
  verifyGrant,
  type GmailSyncPort,
  type SqlExecutor,
} from "@jehad/core";
import {
  createGmailAdapter,
  gmailEnvOrKeychainTokenProvider,
  isHistoryExpired as adapterHistoryExpired,
  isRateLimited,
  type GmailAdapter,
} from "@jehad/adapters";
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

    const source = gmailWorkflowPort(createGmailAdapter({ tokenProvider: () => token }));
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
      const policy = await loadGmailSensorPolicy();
      const report = await syncGmail(db, source, { now: () => new Date(), policy, actor: GMAIL_SYNC_ACTOR });
      const outcome: GmailSyncResult = { status: report.status, newEvents: report.emitted };
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
    // Quota: fail SOFT — the next cron tick (5min) is the retry. A thrown
    // error would make inngest retry with backoff and re-burn the quota
    // (retry-storm) before the minute-window even resets.
    if (isRateLimited(err)) {
      return { status: "quota-wait" as const };
    }
    throw err;
  }
}

/** Map the G1 adapter onto the G2 sync port, translating the adapter's
 *  404-historyId-expiry error into the core-recognized error name. */
export function gmailWorkflowPort(adapter: GmailAdapter): GmailSyncPort {
  let callCount = 0;
  // Quota pacing (Gmail: 250 units/min/user): every 2nd API call takes a
  // 1.5s breath — a full tick (paged list + ≤40 gets) spans well past a
  // minute of budget, so no burst can blow the window.
  const paced = async <T>(fn: () => Promise<T>): Promise<T> => {
    callCount += 1;
    if (callCount % 2 === 0) await new Promise((r) => setTimeout(r, 1500));
    return await fn();
  };
  return {
    id: adapter.id,
    hasToken: async () => true,
    listBootstrapMessages: async (opts) => {
      const page = await paced(() => adapter.bootstrapList(opts.newerThanDays, opts));
      // messages.list carries NO top-level historyId (only profile/threads
      // do) — resolve the bootstrap cursor from the mailbox profile.
      let historyId = page.newestHistoryId;
      if (historyId === null) {
        historyId = (await paced(() => adapter.profileHistoryId())).historyId;
      }
      if (historyId === null || historyId <= 0) {
        // A zero cursor would 404-loop into endless re-bootstrap — fail
        // the tick loudly instead (verifier D3).
        throw new Error("gmail bootstrap: no resolvable historyId");
      }
      return {
        messages: page.messageIds,
        nextPageToken: page.nextPageToken,
        historyId,
      };
    },
    listHistory: async (opts) => {
      let page;
      try {
        page = await paced(() => adapter.historyList(opts.startHistoryId, opts));
      } catch (err) {
        if (adapterHistoryExpired(err)) {
          throw Object.assign(new Error("gmail history cursor expired"), {
            name: "GmailHistoryExpiredError",
          });
        }
        throw err;
      }
      return {
        records: page.records.map((r) => ({ id: r.historyId, messagesAdded: r.messages })),
        nextPageToken: page.nextPageToken,
        historyId: page.nextHistoryId ?? opts.startHistoryId,
      };
    },
    getMessage: async (opts) => {
      const m = await paced(() => adapter.getMessage(opts.id));
      return {
        id: m.id,
        threadId: m.threadId ?? "",
        labelIds: m.labelIds,
        internalDate: m.internalDate === null ? "" : String(m.internalDate),
        sizeEstimate: m.sizeEstimate ?? null,
        from: m.from,
        to: [],
        subject: m.subject,
        textPlain: m.textPlain,
      };
    },
  };
}

async function loadGmailSensorPolicy() {
  try {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // Module-relative like every other policy loader (cwd-independent —
    // the LaunchAgent worker runs from /).
    const moduleDefault = resolve(
      fileURLToPath(new URL("../../../policy.yaml", import.meta.url)),
    );
    const file = process.env.POLICY_YAML_PATH ?? moduleDefault;
    const policy = parsePolicyV1(await readFile(file, "utf8"));
    return gmailSensorPolicyOf(policy);
  } catch {
    return undefined;
  }
}

async function syncWithPool(): Promise<GmailSyncResult> {
  // gmailTokenProvider: GMAIL_ACCESS_TOKEN first, else the hourly refresher's
  // `jehad-gmail` Keychain item (the LaunchAgent sets no env). The provider
  // THROWS when no token exists (env unset + keychain item missing) — map to
  // the documented clean skip, not a thrown tick.
  let token: string;
  try {
    token = await gmailEnvOrKeychainTokenProvider();
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
