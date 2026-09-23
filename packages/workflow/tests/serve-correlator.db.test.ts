// Serve-seam correlation against real PostgreSQL (delegate-watch roadmap
// NOW item: cron firings write canonical runs rows): drive the compiled
// functions exactly as serve.ts does with the real SQL correlator and
// assert the runs rows. Skipped unless TEST_DATABASE_URL is set (same
// gating as packages/db suites); per-file isolated database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { Inngest } from "inngest";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "./isolated-db";
import {
  compileWorkflow,
  defineScheduledWorkflow,
  defineWorkflow,
} from "../src/definition.js";
import { createSqlRunCorrelator, type RunCorrelator } from "../src/correlator.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const client = new Inngest({ id: "serve-correlator-db-test" });

/** Fake memoizing step tools: run bodies execute directly (no executor). */
function fakeStep() {
  return {
    run: async <T>(_id: string, fn: () => Promise<T> | T): Promise<T> => await fn(),
    sleep: async () => undefined,
    waitForEvent: async () => null,
  };
}

type RawContext = {
  event: { id?: string; data?: unknown };
  step: ReturnType<typeof fakeStep>;
  runId: string;
};

function rawFn(compiled: ReturnType<typeof compileWorkflow>) {
  return (compiled as unknown as { fn: (ctx: RawContext) => Promise<unknown> }).fn;
}

describe.skipIf(!TEST_DATABASE_URL)("served workflow firings write runs rows (integration)", () => {
  let db: IsolatedDb;
  let pool: Pool;
  let correlator: RunCorrelator;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "wf_serve_corr");
    pool = db.pool;
    await migrateUp(pool);
    const domain = await pool.query<{ id: string }>(
      `INSERT INTO domains (key, name, sensitivity, retention_class)
       VALUES ('work', 'Work', 'standard', 'standard') RETURNING id`,
    );
    const principal = await pool.query<{ id: string }>(
      `INSERT INTO principals (type, name) VALUES ('user', 'serve-correlator-test') RETURNING id`,
    );
    correlator = createSqlRunCorrelator(pool, {
      principalId: principal.rows[0]!.id,
      domainId: domain.rows[0]!.id,
    });
  }, 60_000);

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  interface RunRow {
    kind: string;
    status: string;
    workflow_id: string | null;
    intent: string | null;
    ended_at: string | null;
  }

  async function runRow(runId: string): Promise<RunRow | undefined> {
    const result = await pool.query<RunRow>(
      `SELECT kind, status, workflow_id, intent, ended_at FROM runs WHERE workflow_id = $1`,
      [runId],
    );
    return result.rows[0];
  }

  it("a completed workflow run writes one runs row (kind, workflow name, terminal status)", async () => {
    const def = defineWorkflow({
      name: "db-correlated-ok",
      fn: async (ctx) => ctx.step.run("echo", () => ctx.input),
    });
    await rawFn(compileWorkflow(client, def, correlator))({
      event: { id: "evt-db-ok", data: { input: { n: 1 } } },
      step: fakeStep(),
      runId: "exec-run-ok",
    });

    const row = await runRow("evt-db-ok");
    expect(row).toMatchObject({
      kind: "workflow",
      status: "completed",
      workflow_id: "evt-db-ok",
      intent: "db-correlated-ok",
    });
    expect(row?.ended_at).not.toBeNull();
  });

  it("a crashing cron firing records status='failed' with the cron intent", async () => {
    const def = defineScheduledWorkflow({
      name: "db-correlated-crash",
      cron: "* * * * *",
      fn: async () => {
        throw new Error("tick blew up");
      },
    });
    await expect(
      rawFn(compileWorkflow(client, def, correlator))({
        event: {},
        step: fakeStep(),
        runId: "exec-run-crash",
      }),
    ).rejects.toThrow("tick blew up");

    const row = await runRow("exec-run-crash");
    expect(row).toMatchObject({
      kind: "workflow",
      status: "failed",
      workflow_id: "exec-run-crash",
      intent: "cron:db-correlated-crash",
    });
    expect(row?.ended_at).not.toBeNull();
  });
});
