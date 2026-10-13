// W1.1 production-shaped atomicity regression (owner correction pass).
//
// Exercises the SAME DB shape runOutcomeExecutor uses — the `executorDb`
// adapter — NOT a bare Pool. The adapter must preserve Pool.connect so
// isPoolDb() sees a Pool and transitionOutcome wraps the durable sequence
// (Outcome CAS UPDATE → canonical event → Attention truth → audit) in one
// BEGIN/COMMIT. If the adapter erases connect (the 397dbbe hole), every
// statement autocommits and a forced producer failure leaves a HALF-LANDED
// transition: status advanced + event persisted + no AttentionItem.
//
// This test FAILS against 397dbbe by construction. The producer failure is
// forced at the DATA level (a test-only trigger that rejects attention
// inserts for poisoned titles) so the REAL module chain runs unmocked.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../db/tests/test-db.js";
import { createOutcome, transitionOutcome } from "@jehad/core";
import { executorDb } from "./outcome-workflows.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const POISON = "w11-poison-marker";

describe.skipIf(!TEST_DATABASE_URL)("W1.1 production-shaped atomicity (executorDb adapter)", () => {
  let db: IsolatedDb;
  let principalId: string;
  const T0 = new Date("2026-10-12T18:00:00.000Z");

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w11prodatomic");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "w1.1-prod-atomic", credentialHash: sha256Hex("x"),
    });
    principalId = user.id;
    // The poison: any attention_items INSERT carrying the marker title fails
    // — deterministic, inside the production code path, no module mocking.
    await db.pool.query(`
      CREATE OR REPLACE FUNCTION w11_poison_attn_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW.title LIKE '%${POISON}%' THEN
            RAISE EXCEPTION 'forced producer failure (W1.1 production-shaped atomicity)';
          END IF;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql
    `);
    await db.pool.query(
      "CREATE TRIGGER w11_poison_attn_trg BEFORE INSERT ON attention_items FOR EACH ROW EXECUTE FUNCTION w11_poison_attn_insert()",
    );
  });

  afterAll(async () => { await dropIsolatedTestDb(TEST_DATABASE_URL!, db); });

  it("a producer failure through the EXECUTOR adapter rolls back status, event, and attention truth", async () => {
    const created = await createOutcome(db.pool, {
      principalId,
      title: `Production atomicity probe ${POISON}`,
      directive: "Roll back completely through the executor adapter.",
      criteria: [{ criterion: "Owner judges success", verificationMethod: { kind: "owner_judgment" } }],
      createdBy: "josctl",
    }, { now: T0, actor: "w1.1" });
    const outcomeId = created.outcome.id;

    const prodDb = executorDb(db.pool);
    expect(typeof (prodDb as { connect?: unknown }).connect).toBe("function"); // the seam this test guards

    // queued/running produce no attention item — drive clean through them.
    await transitionOutcome(prodDb, outcomeId, "queued", {}, { now: new Date(T0.getTime() + 60_000), actor: "w1.1" });
    await transitionOutcome(prodDb, outcomeId, "running", {}, { now: new Date(T0.getTime() + 120_000), actor: "w1.1" });

    // waiting_user is the producing transition — the poisoned attention
    // INSERT fires here and the WHOLE durable sequence must roll back to
    // running.
    await expect(
      transitionOutcome(prodDb, outcomeId, "waiting_user", {}, { now: new Date(T0.getTime() + 180_000), actor: "w1.1" }),
    ).rejects.toThrow("forced producer failure");

    // NOTHING landed — the exact assertions that fail on 397dbbe.
    const status = await db.pool.query("SELECT status FROM outcomes WHERE id = $1::uuid", [outcomeId]);
    expect(String(status.rows[0]!.status)).toBe("running");
    const events = await db.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE type = 'outcome.status_changed' AND payload->>'outcomeId' = $1 AND payload->>'toStatus' = 'waiting_user'",
      [outcomeId],
    );
    expect(Number(events.rows[0]!.n)).toBe(0);
    const items = await db.pool.query(
      "SELECT count(*)::int AS n FROM attention_items WHERE source_object_id = $1",
      [outcomeId],
    );
    expect(Number(items.rows[0]!.n)).toBe(0);
  });
});
