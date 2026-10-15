// Plan-at-create (mission-execution v1): createOutcome persists an explicit
// typed plan (`[{ assign: { role, task } }]`) as the outcome's plan of
// record; an absent plan stores/returns `[]` — never null. Against an
// isolated migrated database. Needs PostgreSQL 16 — skipped unless
// TEST_DATABASE_URL is set.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { createOutcome } from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ACTOR = "system:plan-test";

describe.skipIf(!TEST_DATABASE_URL)("outcome plan-at-create (mission-execution v1)", () => {
  let db: IsolatedDb;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "outplan");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'plan-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const exec = {
    query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]),
  };

  it("persists an explicit plan at create and returns it as the plan of record", async () => {
    const plan = [{ assign: { role: "research", task: "t" } }];
    const created = await createOutcome(
      exec,
      {
        principalId,
        title: "Planful outcome",
        directive: "Do the planned thing.",
        criteria: [{ criterion: "done" }],
        plan,
      },
      { now: NOW, actor: ACTOR },
    );

    expect(created.outcome.plan).toEqual([{ assign: { role: "research", task: "t" } }]);

    const row = await db.pool.query(`SELECT plan FROM outcomes WHERE id = $1::uuid`, [created.outcome.id]);
    expect(row.rows[0]!["plan"]).toEqual([{ assign: { role: "research", task: "t" } }]);
  });

  it("absent plan → empty plan (never null)", async () => {
    const created = await createOutcome(
      exec,
      {
        principalId,
        title: "Unplanned outcome",
        directive: "Wing it.",
        criteria: [{ criterion: "done" }],
      },
      { now: NOW, actor: ACTOR },
    );

    expect(created.outcome.plan).toEqual([]);

    const row = await db.pool.query(`SELECT plan FROM outcomes WHERE id = $1::uuid`, [created.outcome.id]);
    expect(row.rows[0]!["plan"]).toEqual([]);
  });
});
