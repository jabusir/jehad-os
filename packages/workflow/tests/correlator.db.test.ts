// Correlator integration against real PostgreSQL: runs/human_waits rows
// open and close exactly once. Skipped unless TEST_DATABASE_URL is set
// (same gating as packages/db suites); per-file isolated database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "./isolated-db";
import { createSqlRunCorrelator, type RunCorrelator } from "../src/correlator.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("sql run correlator (integration)", () => {
  let db: IsolatedDb;
  let pool: Pool;
  let principalId: string;
  let domainId: string;
  let correlator: RunCorrelator;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "workflow_correlator");
    pool = db.pool;
    await migrateUp(pool);
    const domain = await pool.query<{ id: string }>(
      `INSERT INTO domains (key, name, sensitivity, retention_class)
       VALUES ('work', 'Work', 'standard', 'standard') RETURNING id`,
    );
    domainId = domain.rows[0]!.id;
    const principal = await pool.query<{ id: string }>(
      `INSERT INTO principals (type, name) VALUES ('user', 'correlator-test') RETURNING id`,
    );
    principalId = principal.rows[0]!.id;
    correlator = createSqlRunCorrelator(pool, { principalId, domainId });
  }, 60_000);

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  interface RunRow {
    status: string;
    workflow_id: string | null;
    intent: string | null;
    ended_at: string | null;
  }

  async function runRow(runId: string): Promise<RunRow | undefined> {
    const result = await pool.query<RunRow>(
      "SELECT status, workflow_id, intent, ended_at FROM runs WHERE workflow_id = $1",
      [runId],
    );
    return result.rows[0];
  }

  async function openWaits(runId: string): Promise<number> {
    const result = await pool.query(
      `SELECT count(*)::int AS n FROM human_waits hw
       JOIN runs r ON hw.run_id = r.id
       WHERE r.workflow_id = $1 AND hw.resolved_at IS NULL`,
      [runId],
    );
    return result.rows[0]!.n;
  }

  it("runStarted is idempotent: one runs row, correlated via workflow_id", async () => {
    await correlator.runStarted({ runId: "run-a", workflow: "ingest" });
    await correlator.runStarted({ runId: "run-a", workflow: "ingest" });
    const row = await runRow("run-a");
    expect(row?.status).toBe("running");
    expect(row?.workflow_id).toBe("run-a");
    expect(row?.intent).toBe("ingest");
    expect(row?.ended_at).toBeNull();
    const count = await pool.query("SELECT count(*)::int AS n FROM runs");
    expect(count.rows[0]!.n).toBe(1);
  });

  it("terminal runStatus stamps ended_at; re-updates stay idempotent", async () => {
    await correlator.runStatus({ runId: "run-a", status: "waiting_approval" });
    expect((await runRow("run-a"))?.status).toBe("waiting_approval");
    expect((await runRow("run-a"))?.ended_at).toBeNull();

    await correlator.runStatus({ runId: "run-a", status: "completed" });
    const done = await runRow("run-a");
    expect(done?.status).toBe("completed");
    expect(done?.ended_at).not.toBeNull();
  });

  it("approval waits open once per approval id and close on resume", async () => {
    await correlator.runStarted({ runId: "run-b", workflow: "approve-me" });

    await correlator.approvalOpened({ runId: "run-b", approvalId: "release" });
    await correlator.approvalOpened({ runId: "run-b", approvalId: "release" });
    expect(await openWaits("run-b")).toBe(1);

    await correlator.approvalResolved({ runId: "run-b", approvalId: "release" });
    expect(await openWaits("run-b")).toBe(0);

    // A second approval wait on the same run stays distinct.
    await correlator.approvalOpened({ runId: "run-b", approvalId: "escalate" });
    await correlator.approvalOpened({ runId: "run-b", approvalId: "release" });
    expect(await openWaits("run-b")).toBe(2);

    await correlator.openWaitsResolved({ runId: "run-b" });
    expect(await openWaits("run-b")).toBe(0);
  });

  it("records the raw human wait interval (started_at .. resolved_at)", async () => {
    await correlator.runStarted({ runId: "run-c", workflow: "timed" });
    await correlator.approvalOpened({ runId: "run-c", approvalId: "wait" });
    await correlator.approvalResolved({ runId: "run-c", approvalId: "wait" });
    const row = await pool.query<{ started_at: string; resolved_at: string }>(
      `SELECT hw.started_at, hw.resolved_at FROM human_waits hw
       JOIN runs r ON hw.run_id = r.id WHERE r.workflow_id = 'run-c'`,
    );
    expect(row.rows[0]?.resolved_at).not.toBeNull();
  });
});
