// josctl brief unit tests — hermetic parse + error paths (no Postgres, no
// Keychain, no network), plus an output/exit integration path against an
// isolated seeded database when TEST_DATABASE_URL is set (same split as the
// metrics tests; the happy-path rendering itself is golden-pinned in
// @jehad/core briefs tests).

import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import {
  BRIEF_USAGE,
  parseBriefArgs,
  runBriefCommand,
  type BriefDbFactory,
} from "../src/commands/brief.js";

function captureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

describe("parseBriefArgs", () => {
  it("accepts bare brief and --close", () => {
    expect(parseBriefArgs(["node", "josctl", "brief"])).toEqual({});
    expect(parseBriefArgs(["node", "josctl", "brief", "--close"])).toEqual({ close: true });
  });

  it("rejects other commands, unknown flags, and extra args", () => {
    expect(parseBriefArgs(["node", "josctl", "capture", "x"])).toBeNull();
    expect(parseBriefArgs(["node", "josctl", "brief", "--since", "x"])).toBeNull();
    expect(parseBriefArgs(["node", "josctl", "brief", "extra"])).toBeNull();
    expect(parseBriefArgs(["node", "josctl", "brief", "--close", "extra"])).toBeNull();
  });
});

describe("runBriefCommand (hermetic error paths)", () => {
  it("exits 2 with usage on bad args, without touching the DB", async () => {
    const calls: string[] = [];
    const factory: BriefDbFactory = (url) => {
      calls.push(url);
      throw new Error("must not connect");
    };
    const out = captureStream();
    const errOut = captureStream();
    const code = await runBriefCommand(["node", "josctl", "brief", "--bogus"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: out.stream,
      errOutput: errOut.stream,
      connect: factory,
    });
    expect(code).toBe(2);
    expect(errOut.text()).toBe(BRIEF_USAGE);
    expect(out.text()).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("exits 1 and still closes the pool when the DB is unreachable", async () => {
    let endCalls = 0;
    const factory: BriefDbFactory = () => ({
      query: async () => {
        throw new Error("ECONNREFUSED");
      },
      end: async () => {
        endCalls += 1;
      },
    });
    const out = captureStream();
    const errOut = captureStream();
    const code = await runBriefCommand(["node", "josctl", "brief"], {
      databaseUrl: "postgres://localhost:5432/jehad",
      output: out.stream,
      errOutput: errOut.stream,
      connect: factory,
    });
    expect(code).toBe(1);
    expect(errOut.text()).toContain("brief query failed");
    expect(errOut.text()).toContain("ECONNREFUSED");
    expect(out.text()).toBe("");
    expect(endCalls).toBe(1);
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("runBriefCommand (integration)", () => {
  let dbName: string;
  let baseUrl: string;
  let cleanup: (() => Promise<void>) | null = null;

  afterAll(async () => {
    await cleanup?.();
  });

  beforeAll(async () => {
    // Isolated DB via the db package's test helper (relative import — test-only).
    const { createIsolatedTestDb, dropIsolatedTestDb } = await import(
      "../../../packages/db/tests/test-db.js"
    );
    const db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m6clibrief");
    dbName = db.dbName;
    baseUrl = TEST_DATABASE_URL!;
    cleanup = async () => {
      await dropIsolatedTestDb(TEST_DATABASE_URL!, { pool: db.pool, dbName: db.dbName });
    };
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    // Minimal world: one overdue i_owe commitment (makes the morning brief
    // meaningful) sourced from a capture event.
    const domainId = (
      await db.pool.query(`SELECT id FROM domains WHERE key = 'personal'`)
    ).rows[0].id;
    const at = new Date("2026-09-17T10:00:00.000Z").toISOString();
    const eventId = randomUUID();
    await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                           domain_id, payload, sensitivity, schema_version)
       VALUES ($1, 'capture.recorded', 'cli.capture', $2::timestamptz, $2::timestamptz,
               $3, $4::uuid, '{"text":"rent"}'::jsonb, 'normal', 1)`,
      [eventId, at, `sha256:${randomUUID()}`, domainId],
    );
    await db.pool.query(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at, confidence,
                                status, source_event_id, created_at, updated_at)
       VALUES ($1::uuid, 'i_owe', 'Landlord', 'Pay October rent', '2026-09-16T12:00:00.000Z'::timestamptz,
               0.9, 'open', $2::uuid, $3::timestamptz, $3::timestamptz)`,
      [domainId, eventId, at],
    );
  });

  it("renders the morning brief to stdout (exit 0) and persists the artifact", async () => {
    const out = captureStream();
    const errOut = captureStream();
    const code = await runBriefCommand(["node", "josctl", "brief"], {
      databaseUrl: baseUrl.replace(/\/[^/]*$/, `/${dbName}`),
      output: out.stream,
      errOutput: errOut.stream,
    });
    expect(code).toBe(0);
    expect(errOut.text()).toBe("");
    const text = out.text();
    expect(text).toContain("MORNING BRIEF — ");
    expect(text).toContain("OVERDUE Pay October rent");
    // CLI persist path: exactly one brief artifact so far.
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: baseUrl.replace(/\/[^/]*$/, `/${dbName}`) });
    try {
      const count = await pool.query(`SELECT count(*)::int AS n FROM artifacts WHERE kind = 'brief'`);
      expect(count.rows[0].n).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
