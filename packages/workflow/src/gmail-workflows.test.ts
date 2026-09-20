// Gmail sync workflow tests (Phase GMAIL lane G3, plan §3/§9.4): definition
// shape, no-token clean skip, tick logging (JSON, error name+status only,
// never the token), the per-tick gmail:ingest grant mint/verify/revoke seam
// (ADR-0007), and an integration pass over the real capability_grants table.
//
// Hermetic suites run anywhere: syncGmail and the gmail adapter are faked at
// the lane contract seam (vi.mock over the parallel-lane modules; see
// gmail-contract.d.ts), and the grant service runs against an in-memory
// executor that mirrors the capability_grants SQL. The integration suite
// needs PostgreSQL 16 and is skipped unless TEST_DATABASE_URL is set
// (per-file isolated db, like packages/db).

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../tests/isolated-db.js";

const mocks = vi.hoisted(() => ({
  syncGmail: vi.fn(),
  gmailTokenProvider: vi.fn(),
  createGmailAdapter: vi.fn(() => fakeAdapter()),
  issueGrant: vi.fn(),
  verifyGrant: vi.fn(),
  revokeGrant: vi.fn(),
}));

function fakeAdapter() {
  return {
    id: "adapter:gmail",
    historyList: vi.fn(),
    bootstrapList: vi.fn(),
    getMessage: vi.fn(),
    profileHistoryId: vi.fn(),
  };
}

vi.mock("@jehad/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jehad/core")>();
  // Real grant service underneath recording wrappers (call counts + args
  // for the seam assertions; the token never leaves test memory).
  mocks.issueGrant.mockImplementation(actual.issueGrant);
  mocks.verifyGrant.mockImplementation(actual.verifyGrant);
  mocks.revokeGrant.mockImplementation(actual.revokeGrant);
  return {
    ...actual,
    syncGmail: mocks.syncGmail,
    issueGrant: mocks.issueGrant,
    verifyGrant: mocks.verifyGrant,
    revokeGrant: mocks.revokeGrant,
  };
});

vi.mock("@jehad/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jehad/adapters")>();
  return {
    ...actual,
    gmailTokenProvider: mocks.gmailTokenProvider,
    createGmailAdapter: mocks.createGmailAdapter,
  };
});

import {
  GMAIL_INGEST_CAPABILITY,
  GMAIL_INGEST_RESOURCE,
  GMAIL_SYNC_ACTOR,
  GMAIL_SYNC_GRANT_TTL_MS,
  gmailSyncWorkflow,
  runGmailSyncTick,
} from "./gmail-workflows.js";
import { createWorkflowWorkerServer } from "./index.js";
import { assertWorkflowToken } from "./names.js";

const FIVE_FIELD_CRON_RE = /^(\S+ ){4}\S+$/;

/** Executor-neutral context that records step ids and RUNS the step body. */
function fakeContext(onStep?: (id: string) => void) {
  return {
    input: undefined,
    runId: "test-run",
    workflow: "gmail-sync",
    step: {
      run: async (id: string, fn: () => Promise<unknown> | unknown) => {
        onStep?.(id);
        return fn();
      },
      sleep: async () => undefined,
    },
    waitForSignal: async () => null,
    pauseForApproval: async () => ({ approved: false }),
  } as const;
}

function captureLogs(): string[] {
  const logs: string[] = [];
  logSpies.push(
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    }),
  );
  return logs;
}

const logSpies: ReturnType<typeof vi.spyOn>[] = [];

/** In-memory capability_grants executor: mirrors insert/select/revoke SQL. */
function fakeGrantDb() {
  const grants = new Map<string, Record<string, unknown>>();
  let seq = 0;
  return {
    grants,
    async query(text: string, values?: readonly unknown[]) {
      if (text.includes("FROM principals")) return { rows: [{ id: "principal-1" }] };
      if (text.includes("FROM domains")) return { rows: [{ id: "domain-1" }] };
      if (text.startsWith("INSERT INTO capability_grants")) {
        seq += 1;
        const row = {
          id: `grant-${seq}`,
          principal_id: values?.[0],
          run_id: values?.[1] ?? null,
          capability: values?.[2],
          resource: values?.[3],
          domain_id: values?.[4],
          expires_at: values?.[5],
          revoked_at: null,
          token_hash: values?.[6],
        };
        grants.set(String(row.token_hash), row);
        return { rows: [row] };
      }
      if (text.includes("FROM capability_grants WHERE token_hash")) {
        const row = grants.get(String(values?.[0]));
        return { rows: row === undefined ? [] : [row] };
      }
      if (text.startsWith("UPDATE capability_grants")) {
        const row = [...grants.values()].find((candidate) => candidate.id === values?.[0]);
        if (row !== undefined) row.revoked_at = new Date();
        return { rows: row === undefined ? [] : [row] };
      }
      throw new Error(`fakeGrantDb: unexpected query: ${text.slice(0, 80)}`);
    },
  };
}

beforeEach(() => {
  mocks.syncGmail.mockReset();
  mocks.gmailTokenProvider.mockReset();
  mocks.createGmailAdapter.mockReset().mockImplementation(() => fakeAdapter());
  // mockClear (not reset): keeps the real-service delegation set in the
  // vi.mock factory, clears cross-test call counts.
  mocks.issueGrant.mockClear();
  mocks.verifyGrant.mockClear();
  mocks.revokeGrant.mockClear();
});

afterEach(() => {
  // Restore ONLY the console spies — a blanket vi.restoreAllMocks() would
  // wipe the real-service delegations the vi.mock factory installed.
  for (const spy of logSpies.splice(0)) spy.mockRestore();
});

// --------------------------------------------------------------- hermetic

describe("gmail-sync workflow definition", () => {
  it("exports a valid cron definition pinned to the 5-minute cadence", () => {
    expect(gmailSyncWorkflow.kind).toBe("cron");
    expect(gmailSyncWorkflow.name).toBe("gmail-sync");
    expect(gmailSyncWorkflow.cron).toBe("*/5 * * * *");
    expect(gmailSyncWorkflow.cron).toMatch(FIVE_FIELD_CRON_RE);
    expect(() => assertWorkflowToken("workflow name", gmailSyncWorkflow.name)).not.toThrow();
    expect(typeof gmailSyncWorkflow.fn).toBe("function");
  });

  it("serves through the worker server (compiles to executor functions)", () => {
    const server = createWorkflowWorkerServer({ workflows: [gmailSyncWorkflow] });
    expect(typeof server.listen).toBe("function");
    server.close();
  });
});

describe("gmail-sync no-token clean skip (plan §3.7)", () => {
  it("skips with exit-0 outcome and a clean tick log, no grant, no sync", async () => {
    mocks.gmailTokenProvider.mockRejectedValue(new Error("gmail: no access token"));
    const logs = captureLogs();

    const steps: string[] = [];
    const result = await gmailSyncWorkflow.fn(fakeContext((id) => steps.push(id)));

    expect(steps).toEqual(["sync-gmail"]);
    expect(result).toEqual({ skipped: "no-token" });
    expect(logs).toEqual([JSON.stringify({ workflow: "gmail-sync", skipped: "no-token" })]);
    expect(mocks.issueGrant).not.toHaveBeenCalled();
    expect(mocks.syncGmail).not.toHaveBeenCalled();
  });
});

describe("gmail-sync tick (hermetic: contract seam + in-memory grants)", () => {
  it("mints, verifies, and revokes the gmail:ingest grant around every tick", async () => {
    mocks.syncGmail.mockResolvedValue({ status: "ok", mode: "incremental", messages: [], emitted: 2, deduped: 0, nonInboxSkipped: 0, failed: 0, deferred: 0, capped: false, fullResync: false, cursorHistoryId: 1, health: {} });
    const db = fakeGrantDb();
    captureLogs();

    const result = await runGmailSyncTick(db, "tok-secret");

    expect(result).toEqual({ status: "ok", newEvents: 2 });
    expect(mocks.issueGrant).toHaveBeenCalledTimes(1);
    const mintInput = mocks.issueGrant.mock.calls[0]![1] as Record<string, unknown>;
    expect(mintInput).toMatchObject({
      principalId: "principal-1",
      runId: null,
      capability: GMAIL_INGEST_CAPABILITY,
      resource: GMAIL_INGEST_RESOURCE,
      domainId: "domain-1",
      ttlMs: GMAIL_SYNC_GRANT_TTL_MS,
    });
    expect(mocks.verifyGrant).toHaveBeenCalledTimes(1);
    expect(mocks.revokeGrant).toHaveBeenCalledTimes(1);
    // The minted grant is revoked at run end — no standing grant remains.
    const rows = [...db.grants.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it("calls syncGmail with the constructed adapter and the pinned actor", async () => {
    mocks.syncGmail.mockResolvedValue({ status: "ok", mode: "incremental", messages: [], emitted: 0, deduped: 0, nonInboxSkipped: 0, failed: 0, deferred: 0, capped: false, fullResync: false, cursorHistoryId: 1, health: {} });
    captureLogs();

    await runGmailSyncTick(fakeGrantDb(), "tok");

    expect(mocks.createGmailAdapter).toHaveBeenCalledTimes(1);
    const constructed = mocks.createGmailAdapter.mock.calls[0]![0] as { tokenProvider: () => string };
    expect(constructed.tokenProvider()).toBe("tok");
    expect(mocks.syncGmail).toHaveBeenCalledTimes(1);
    const [syncDb, syncAdapter, syncOpts] = mocks.syncGmail.mock.calls[0]! as [
      { query: unknown },
      unknown,
      { actor: string; now(): Date },
    ];
    expect((syncAdapter as { id: string }).id).toBe("adapter:gmail");
    expect(typeof syncDb.query).toBe("function");
    expect(syncOpts.actor).toBe(GMAIL_SYNC_ACTOR);
    expect(syncOpts.now()).toBeInstanceOf(Date);
  });

  it("logs a content-free JSON tick line (never the token)", async () => {
    mocks.syncGmail.mockResolvedValue({ status: "ok", mode: "incremental", messages: [], emitted: 3, deduped: 0, nonInboxSkipped: 0, failed: 0, deferred: 0, capped: false, fullResync: false, cursorHistoryId: 1, health: {} });
    const logs = captureLogs();

    await runGmailSyncTick(fakeGrantDb(), "tok-secret");

    expect(logs).toEqual([JSON.stringify({ workflow: "gmail-sync", status: "ok", newEvents: 3 })]);
    expect(logs.join("")).not.toContain("tok-secret");
  });

  it("an API error throws the tick, logs name+status only, still revokes the grant", async () => {
    const apiError = Object.assign(new Error("gmail 401"), { name: "GmailApiError", status: 401 });
    mocks.syncGmail.mockRejectedValue(apiError);
    const db = fakeGrantDb();
    const logs = captureLogs();

    await expect(runGmailSyncTick(db, "tok-secret")).rejects.toThrow("gmail 401");

    expect(logs).toEqual([
      JSON.stringify({ workflow: "gmail-sync", error: "GmailApiError", status: 401 }),
    ]);
    expect(logs.join("")).not.toContain("tok-secret");
    // Run-end revocation holds even on failure — never a standing grant.
    expect([...db.grants.values()][0]!.revoked_at).not.toBeNull();
    expect(mocks.revokeGrant).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------- integration

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("gmail-sync tick (integration: real grant tables)", () => {
  let db: IsolatedDb;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "workflowgmail");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("runs the full workflow fn against a real database: mint → verify → sync → revoke", async () => {
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevToken = process.env.GMAIL_ACCESS_TOKEN;
    process.env.DATABASE_URL = db.dsn;
    process.env.GMAIL_ACCESS_TOKEN = "tok-integration";
    mocks.syncGmail.mockResolvedValue({ status: "ok", mode: "bootstrap", messages: [], emitted: 5, deduped: 0, nonInboxSkipped: 0, failed: 0, deferred: 0, capped: false, fullResync: false, cursorHistoryId: 9, health: {} });
    const logs = captureLogs();

    try {
      const steps: string[] = [];
      const result = await gmailSyncWorkflow.fn(fakeContext((id) => steps.push(id)));

      expect(steps).toEqual(["sync-gmail"]);
      expect(result).toEqual({ status: "ok", newEvents: 5 });
      expect(logs).toEqual([JSON.stringify({ workflow: "gmail-sync", status: "ok", newEvents: 5 })]);
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
      if (prevToken === undefined) delete process.env.GMAIL_ACCESS_TOKEN;
      else process.env.GMAIL_ACCESS_TOKEN = prevToken;
    }

    const principal = await db.pool.query(
      "SELECT id FROM principals WHERE name = $1 AND type = 'workflow'",
      [GMAIL_SYNC_ACTOR],
    );
    expect(principal.rows).toHaveLength(1);

    const grants = await db.pool.query(
      "SELECT capability, resource, revoked_at, token_hash, principal_id FROM capability_grants",
    );
    expect(grants.rows).toHaveLength(1);
    const row = grants.rows[0]!;
    expect(row.capability).toBe(GMAIL_INGEST_CAPABILITY);
    expect(row.resource).toBe(GMAIL_INGEST_RESOURCE);
    expect(row.revoked_at).not.toBeNull();
    expect(String(row.principal_id)).toBe(String(principal.rows[0]!.id));
    expect(String(row.token_hash)).not.toContain("tok-integration");

    const live = await db.pool.query("SELECT id FROM capability_grants WHERE revoked_at IS NULL");
    expect(live.rows).toHaveLength(0);
  });
});
