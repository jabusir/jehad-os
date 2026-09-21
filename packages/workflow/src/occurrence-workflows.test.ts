// Calendar occurrence sweep workflow tests (W5b): definition shape (hourly
// cron, valid name), worker-server serving, and an integration tick over a
// real migrated database (gmail-workflows test pattern) pinning the
// occurrence floor semantics end-to-end: past-null events get
// scheduled_past_unverified, observed_* rows are never touched, the tick
// is idempotent, and each pass lands a metadata-only audit row.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../tests/isolated-db.js";
import { calendarOccurrenceSweepWorkflow } from "./occurrence-workflows.js";
import { createWorkflowWorkerServer } from "./index.js";
import { assertWorkflowToken } from "./names.js";

const FIVE_FIELD_CRON_RE = /^(\S+ ){4}\S+$/;

/** Executor-neutral context that records step ids and RUNS the step body. */
function fakeContext(onStep?: (id: string) => void) {
  return {
    input: undefined,
    runId: "test-run",
    workflow: "calendar-occurrence-sweep",
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

describe("calendar-occurrence-sweep workflow definition", () => {
  it("exports a valid cron definition pinned to the hourly cadence", () => {
    expect(calendarOccurrenceSweepWorkflow.kind).toBe("cron");
    expect(calendarOccurrenceSweepWorkflow.name).toBe("calendar-occurrence-sweep");
    expect(calendarOccurrenceSweepWorkflow.cron).toBe("0 * * * *");
    expect(calendarOccurrenceSweepWorkflow.cron).toMatch(FIVE_FIELD_CRON_RE);
    expect(() =>
      assertWorkflowToken("workflow name", calendarOccurrenceSweepWorkflow.name),
    ).not.toThrow();
    expect(typeof calendarOccurrenceSweepWorkflow.fn).toBe("function");
  });

  it("serves through the worker server (compiles to executor functions)", () => {
    const server = createWorkflowWorkerServer({ workflows: [calendarOccurrenceSweepWorkflow] });
    expect(typeof server.listen).toBe("function");
    server.close();
  });
});

// ----------------------------------------------------------- integration

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("calendar-occurrence-sweep tick (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "wfoccswp");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    domainId = String(
      (await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`)).rows[0]!.id,
    );
  });

  afterAll(async () => {
    logSpy.mockRestore();
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function seedRow(
    googleEventId: string,
    endOffsetMs: number,
    occurrence?: string | null,
  ): Promise<string> {
    const sourceEventId = randomUUID();
    const end = new Date(Date.now() + endOffsetMs);
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id, payload, sensitivity, schema_version)
       VALUES ($1::uuid, 'calendar.event.created', 'adapter:google-calendar', $2::timestamptz, $3, $4::uuid, '{}', 'normal', 1)`,
      [sourceEventId, end.toISOString(), randomUUID(), domainId],
    );
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO calendar_events
         (id, google_event_id, google_calendar_id, status, summary, start_time, end_time,
          timezone, attendees, location, metadata, source_event_id, content_hash, occurrence,
          occurrence_confirmed_by)
       VALUES ($1::uuid, $2, 'primary', 'confirmed', $2, $3::timestamptz, $4::timestamptz, NULL,
               '[]', NULL, '{}', $5::uuid, 'x', $6,
               CASE WHEN $6 = 'observed_occurred' THEN $7::jsonb ELSE NULL END)`,
      [
        id,
        googleEventId,
        new Date(end.getTime() - 3_600_000).toISOString(),
        end.toISOString(),
        sourceEventId,
        occurrence ?? null,
        JSON.stringify({ kind: "user_declared", source: "principal:test", at: new Date().toISOString() }),
      ],
    );
    return id;
  }

  it("one tick: marks past-null events with the floor, never touches observed_*; audit lands", async () => {
    const past = await seedRow("w-past", -2 * 3_600_000);
    const future = await seedRow("w-future", +2 * 3_600_000);
    const observed = await seedRow("w-observed", -2 * 3_600_000, "observed_occurred");

    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.dsn;
    try {
      const steps: string[] = [];
      const result = (await calendarOccurrenceSweepWorkflow.fn(
        fakeContext((id) => steps.push(id)),
      )) as { marked: number };

      expect(steps).toEqual(["sweep-past-unverified"]);
      expect(result).toEqual({ marked: 1 });

      const rows = await db.pool.query<{
        id: string;
        occurrence: string | null;
      }>(
        `SELECT id, occurrence FROM calendar_events WHERE id = ANY($1::uuid[])`,
        [[past, future, observed]],
      );
      const byId = new Map(rows.rows.map((row) => [String(row.id), row.occurrence]));
      expect(byId.get(past)).toBe("scheduled_past_unverified");
      expect(byId.get(future)).toBeNull();
      expect(byId.get(observed)).toBe("observed_occurred");

      const audit = await db.pool.query(
        `SELECT outputs_ref FROM audit_log
          WHERE actor = 'system:calendar-occurrence' AND action = 'calendar.occurrence.swept'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(JSON.parse(String(audit.rows[0]!.outputs_ref))).toEqual({ marked: 1 });
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });

  it("second tick is a no-op (idempotent, audit counts zero)", async () => {
    const prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.dsn;
    try {
      const result = (await calendarOccurrenceSweepWorkflow.fn(fakeContext())) as { marked: number };
      expect(result).toEqual({ marked: 0 });
      const audit = await db.pool.query(
        `SELECT outputs_ref FROM audit_log
          WHERE actor = 'system:calendar-occurrence' AND action = 'calendar.occurrence.swept'`,
      );
      expect(audit.rows).toHaveLength(2);
      expect(JSON.parse(String(audit.rows[1]!.outputs_ref))).toEqual({ marked: 0 });
    } finally {
      if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDatabaseUrl;
    }
  });
});
