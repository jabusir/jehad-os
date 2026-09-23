// Outcome primitive integration tests (roadmap §5; ADR-0017) against an
// isolated migrated database — migration 024 up included: creation +
// criteria, the guarded state machine, the criteria completion gate, typed
// predicate validation, wait CAS exactly-once, and principal isolation.
// Needs PostgreSQL 16 — skipped unless TEST_DATABASE_URL is set.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { parseOutcomeWaitPredicate } from "./predicates.js";
import {
  createOutcome,
  createOutcomeWait,
  getOutcomeByRef,
  listActiveOutcomes,
  satisfyWaitsForEvent,
  setCriterionStatus,
  transitionOutcome,
} from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const ACTOR = "system:outcome-test";

describe.skipIf(!TEST_DATABASE_URL)("outcome primitive (D0, ADR-0017)", () => {
  let db: IsolatedDb;
  let principalId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "outcomesd0");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const row = await db.pool.query(
      `INSERT INTO principals (type, name) VALUES ('user', 'outcome-owner') RETURNING id`,
    );
    principalId = String(row.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function q(sql: string, params: readonly unknown[] = []): { rows: Array<Record<string, unknown>> } {
    return db.pool.query(sql, params) as unknown as { rows: Array<Record<string, unknown>> };
  }

  const exec = {
    query: (sql: string, params: readonly unknown[] = []) => db.pool.query(sql, params as unknown[]),
  };

  async function seedOutcome(): Promise<{ id: string; ref: string }> {
    const created = await createOutcome(exec, {
      principalId,
      title: "Chase the Acme quote",
      directive: "Keep track of the packaging quote and get everything ready when they reply.",
      criteria: [{ criterion: "Acme reply grounded in the gmail source record" }, { criterion: "Price/MOQ extracted with citations" }],
      createdBy: "conversation",
    }, { now: NOW, actor: ACTOR });
    return { id: created.outcome.id, ref: created.outcome.ref };
  }

  it("predicates: the typed vocabulary validates and refuses", () => {
    expect(parseOutcomeWaitPredicate({ v: 1, type: "arrival", source: "gmail", fromDomain: "acme.com" })).toEqual({
      v: 1, type: "arrival", source: "gmail", fromDomain: "acme.com",
    });
    expect(parseOutcomeWaitPredicate({ v: 1, type: "arrival", source: "gmail" })).toBeNull(); // gmail needs sender scope
    expect(parseOutcomeWaitPredicate({ type: "arrival", source: "gmail", fromDomain: "acme.com" })).toBeNull(); // no version
    expect(parseOutcomeWaitPredicate({ v: 1, type: "arrival", source: "smtp", fromDomain: "acme.com" })).toBeNull();
    expect(parseOutcomeWaitPredicate({ v: 1, type: "state_change", entity: "outcome", toStatus: "completed" })).not.toBeNull();
    expect(parseOutcomeWaitPredicate({ v: 1, type: "state_change", entity: "outcome", toStatus: "completed'; DROP" })).toBeNull();
    expect(parseOutcomeWaitPredicate({ v: 1, type: "threshold", metric: "outcome_spend_usd", gt: 5 })).not.toBeNull();
    expect(parseOutcomeWaitPredicate("SELECT 1")).toBeNull();
  });

  it("creation: accepted outcome + first-class criteria + canonical events; empty criteria refused", async () => {
    const { id, ref } = await seedOutcome();
    expect(ref).toMatch(/^[0-9A-Z]{3}$/);

    const criteria = await q(
      `SELECT ordinal, criterion, status FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal`,
      [id],
    );
    expect(criteria.rows).toHaveLength(2);
    expect(criteria.rows[0]!.status).toBe("pending");

    const events = await q(`SELECT type FROM events WHERE type LIKE 'outcome.%' ORDER BY occurred_at ASC`);
    expect(events.rows.map((r) => r.type)).toEqual(["outcome.created", "outcome.accepted"]);

    expect(
      createOutcome(exec, {
        principalId, title: "x", directive: "y", criteria: [],
      }, { now: NOW, actor: ACTOR }),
    ).rejects.toThrow(/at least one success criterion/);

    expect((await listActiveOutcomes(exec, principalId)).map((o) => o.id)).toContain(id);
    // Principal isolation: a foreign principal cannot see or address it.
    expect(await getOutcomeByRef(exec, randomUUID(), ref)).toBeNull();
  });

  it("state machine: legal path advances; illegal transitions are refused", async () => {
    const { id } = await seedOutcome();
    await transitionOutcome(exec, id, "queued", {}, { now: NOW, actor: ACTOR });
    await transitionOutcome(exec, id, "running", {}, { now: NOW, actor: ACTOR });
    const wait = await transitionOutcome(exec, id, "waiting_external", { waitingOn: { why: "acme reply" } }, { now: NOW, actor: ACTOR });
    expect(wait.changed).toBe(true);
    expect(wait.outcome.status).toBe("waiting_external");

    await expect(
      transitionOutcome(exec, id, "verifying", {}, { now: NOW, actor: ACTOR }),
    ).rejects.toThrow(/illegal transition/); // waiting_external → verifying is not a legal edge

    await transitionOutcome(exec, id, "running", {}, { now: NOW, actor: ACTOR });
    // running → completed skips verifying. Both defenses may fire (triggers
    // run alphabetically: the completion gate first) — either refusal is correct.
    await expect(
      transitionOutcome(exec, id, "completed", {}, { now: NOW, actor: ACTOR }),
    ).rejects.toThrow(/illegal transition|unmet criteria remain/);
  });

  it("completion gate: completed refuses while criteria are unmet; passes once verified", async () => {
    const { id } = await seedOutcome();
    for (const s of ["queued", "running", "verifying"] as const) {
      await transitionOutcome(exec, id, s, {}, { now: NOW, actor: ACTOR });
    }
    await expect(
      transitionOutcome(exec, id, "completed", {}, { now: NOW, actor: ACTOR }),
    ).rejects.toThrow(/unmet criteria remain/);

    // Worker prose cannot verify: a verified criterion must carry evidence.
    await expect(
      setCriterionStatus(exec, id, 1, "verified", { now: NOW, actor: ACTOR }),
    ).rejects.toThrow(/evidence or a verifier assignment/);

    await setCriterionStatus(exec, id, 1, "verified", { now: NOW, actor: ACTOR, evidenceRef: null as unknown as string }).catch(() => {
      // evidenceRef null → treated as missing → still refused; use a real evidence row instead.
    });
    const evidence = await q(
      `INSERT INTO evidence (domain_id, source_type, source_ref, claim, observed_at)
       SELECT d.id, 'manual', $1, 'test evidence row', $2::timestamptz
       FROM domains d WHERE d.key = 'personal' RETURNING id`,
      [`evidence-${randomUUID()}`, NOW.toISOString()],
    );
    await setCriterionStatus(exec, id, 1, "verified", { now: NOW, actor: ACTOR, evidenceRef: String(evidence.rows[0]!.id) });
    await setCriterionStatus(exec, id, 2, "waived_by_owner", { now: NOW, actor: ACTOR });

    const done = await transitionOutcome(exec, id, "completed", {}, { now: NOW, actor: ACTOR });
    expect(done.changed).toBe(true);

    // Terminal: no exits.
    await expect(
      transitionOutcome(exec, id, "running", {}, { now: NOW, actor: ACTOR }),
    ).rejects.toThrow(/terminal status/);
    expect((await listActiveOutcomes(exec, principalId)).map((o) => o.id)).not.toContain(id);
  });

  it("waits: typed creation, event matching, CAS exactly-once", async () => {
    const { id } = await seedOutcome();
    await transitionOutcome(exec, id, "queued", {}, { now: NOW, actor: ACTOR });
    await transitionOutcome(exec, id, "running", {}, { now: NOW, actor: ACTOR });
    await transitionOutcome(exec, id, "waiting_external", { waitingOn: { why: "quote reply" } }, { now: NOW, actor: ACTOR });

    // Non-matchable types are refused (fail closed — never a silent stall).
    await expect(
      createOutcomeWait(exec, id, "gmail.message.received", { v: 1, type: "absence_past", subject: "commitment", olderThanHours: 48 }, { now: NOW, actor: ACTOR }),
    ).rejects.toThrow(/no router matcher/);
    await expect(
      createOutcomeWait(exec, id, "made.up.event", { v: 1, type: "arrival", source: "gmail", fromDomain: "acme.com" }, { now: NOW, actor: ACTOR }),
    ).rejects.toThrow(/unsupported wait event type/);

    const { waitId } = await createOutcomeWait(
      exec, id, "gmail.message.received",
      { v: 1, type: "arrival", source: "gmail", fromDomain: "acme.com" },
      { now: NOW, actor: ACTOR },
    );

    // Mismatched sender → nothing satisfies.
    const miss = await satisfyWaitsForEvent(exec, "gmail.message.received", { fromDomain: "other.com" }, { now: NOW, actor: ACTOR });
    expect(miss).toEqual([]);
    // Matching sender → satisfied exactly once.
    const hit = await satisfyWaitsForEvent(exec, "gmail.message.received", { fromDomain: "acme.com" }, { now: NOW, actor: ACTOR });
    expect(hit).toEqual([{ waitId, outcomeId: id }]);
    // Redelivered event → CAS keeps it exactly-once.
    const replay = await satisfyWaitsForEvent(exec, "gmail.message.received", { fromDomain: "acme.com" }, { now: NOW, actor: ACTOR });
    expect(replay).toEqual([]);

    const waitRow = await q(`SELECT status, satisfied_at FROM outcome_waits WHERE id = $1::uuid`, [waitId]);
    expect(waitRow.rows[0]!.status).toBe("satisfied");
    expect(waitRow.rows[0]!.satisfied_at).not.toBeNull();
  });
});
