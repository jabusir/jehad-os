// Web-citation evidence landing (mission-execution v1): a completed
// assignment's web citations land as source_type='url' evidence rows keyed by
// the validated public URL (page title in metadata), legacy citations stay
// source_type='assignment', and a citation carrying a private/loopback URL
// fails the WHOLE envelope — the assignment stays running and nothing lands.
// Against an isolated migrated database. Needs PostgreSQL 16 — skipped unless
// TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  AssignmentError,
  completeAssignment,
  createAssignment,
  getAssignmentById,
  transitionAssignment,
} from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ACTOR = "system:web-citation-test";

describe.skipIf(!TEST_DATABASE_URL)("assignment web citations → evidence (mission-execution v1)", () => {
  let db: IsolatedDb;
  let principalId: string;
  let outcomeId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "asgweb");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'web-citation-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
    const outcome = await db.pool.query(
      `INSERT INTO outcomes (id, principal_id, ref, title, directive, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'WEB', 'web outcome', 'research the thing', 'running', 'josctl')
       RETURNING id`,
      [randomUUID(), principalId],
    );
    outcomeId = String(outcome.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function newRunningAssignment(task: string): Promise<string> {
    const created = await createAssignment(
      db.pool,
      {
        outcomeId,
        principalId,
        role: "research",
        task,
        context: "ctx",
        successCriteria: ["grounded"],
        budgetUsd: 1,
      },
      { now: NOW, actor: ACTOR },
    );
    await transitionAssignment(db.pool, created.assignment.id, "running", { now: NOW, actor: ACTOR });
    return created.assignment.id;
  }

  it("lands web citations as url evidence and legacy citations as assignment evidence", async () => {
    const assignmentId = await newRunningAssignment("Mixed citations");
    const { assignment, evidenceIds } = await completeAssignment(
      db.pool,
      {
        assignmentId,
        result: {
          summary: "Grounded synthesis.",
          artifact: { title: "Findings", body: "Body grounded in sources." },
          citations: [
            { ref: "source-1", url: "https://example.com/a", title: "Example", note: "n" },
            { ref: "[Gmail] block", note: "m" },
          ],
          costUsd: 0.01,
        },
        runId: null,
        domainId: "personal",
      },
      { now: NOW, actor: ACTOR },
    );
    expect(assignment.status).toBe("succeeded");
    expect(evidenceIds).toHaveLength(2);

    const rows = await db.pool.query(
      `SELECT source_type, source_ref, claim, metadata FROM evidence WHERE metadata->>'assignmentId' = $1`,
      [assignmentId],
    );
    expect(rows.rows).toHaveLength(2);
    const byType = new Map(rows.rows.map((r) => [String(r["source_type"]), r]));
    const urlRow = byType.get("url")!;
    expect(urlRow["source_ref"]).toBe("https://example.com/a");
    expect(urlRow["metadata"]).toMatchObject({ title: "Example", assignmentId });
    expect(urlRow["claim"]).toBe("n");
    const legacyRow = byType.get("assignment")!;
    expect(legacyRow["source_ref"]).toBe("[Gmail] block");
    expect(legacyRow["claim"]).toBe("m");
  });

  it("a citation with a private/loopback URL fails the whole envelope — nothing lands", async () => {
    const assignmentId = await newRunningAssignment("Hostile citation");
    await expect(
      completeAssignment(
        db.pool,
        {
          assignmentId,
          result: {
            summary: "Tries to cite loopback.",
            artifact: { title: "Bad", body: "Body." },
            citations: [
              { ref: "ok", note: "fine" },
              { ref: "smuggled", url: "http://127.0.0.1:8080/x", note: "hostile" },
            ],
            costUsd: 0,
          },
          runId: null,
          domainId: "personal",
        },
        { now: NOW, actor: ACTOR },
      ),
    ).rejects.toThrow(AssignmentError);

    const after = await getAssignmentById(db.pool, assignmentId);
    expect(after!.status).toBe("running");
    expect(after!.result).toBeNull();
    const rows = await db.pool.query(
      `SELECT count(*)::int AS n FROM evidence WHERE metadata->>'assignmentId' = $1`,
      [assignmentId],
    );
    expect(Number(rows.rows[0]!["n"])).toBe(0);
  });
});
