// W1.1 finding 1 — atomicity regression: the durable sequence (Outcome row +
// canonical event + AttentionItem truth) commits in ONE transaction on the
// production Pool path. A failure ANYWHERE in that sequence rolls the whole
// transition back — a committed canonical transition can never lack its
// attention truth, and an attention failure can never half-land a transition.
//
// The producer module is forced to throw; everything else is the real
// machinery against an isolated TEST_DATABASE_URL database.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateUp, seedDomains, sha256Hex, upsertPrincipalCredential } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../../packages/db/tests/test-db";
import { createOutcome, transitionOutcome } from "./service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

vi.mock("../attention/outcome-producer.js", () => ({
  emitOutcomeAttention: () => {
    throw new Error("forced producer failure (W1.1 atomicity regression)");
  },
  deliverOutcomeAttentionNow: async () => {
    throw new Error("delivery must never run when the durable part threw");
  },
}));

describe.skipIf(!TEST_DATABASE_URL)("W1.1 transition atomicity (integration)", () => {
  let db: IsolatedDb;
  let principalId: string;
  const T0 = new Date("2026-10-12T17:00:00.000Z");

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w11atomic");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const user = await upsertPrincipalCredential(db.pool, {
      type: "user", name: "w11-atomic", credentialHash: sha256Hex("x"),
    });
    principalId = user.id;
  });

  afterAll(async () => { await dropIsolatedTestDb(TEST_DATABASE_URL!, db); });

  it("a producer failure rolls back the outcome, the event, AND the attention truth (pool path)", async () => {
    const created = await createOutcome(db.pool, {
      principalId,
      title: "Atomicity probe",
      directive: "Roll back completely when the attention truth fails.",
      criteria: [{ criterion: "Owner judges success", verificationMethod: { kind: "owner_judgment" } }],
      createdBy: "josctl",
    }, { now: T0, actor: "w1.1" });
    const outcomeId = created.outcome.id;

    await expect(
      transitionOutcome(db.pool, outcomeId, "queued", {}, { now: new Date(T0.getTime() + 60_000), actor: "w1.1" }),
    ).rejects.toThrow("forced producer failure");

    // NOTHING landed: not the status, not the event, not the attention row.
    const status = await db.pool.query("SELECT status FROM outcomes WHERE id = $1::uuid", [outcomeId]);
    expect(String(status.rows[0]!.status)).toBe("accepted");
    const events = await db.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE type = 'outcome.status_changed' AND payload->>'outcomeId' = $1",
      [outcomeId],
    );
    expect(Number(events.rows[0]!.n)).toBe(0);
    const items = await db.pool.query(
      "SELECT count(*)::int AS n FROM attention_items WHERE source_object_id = $1",
      [outcomeId],
    );
    expect(Number(items.rows[0]!.n)).toBe(0);
  });

  it("the same failure never leaves a partial outcome.status_changed even for a later transition", async () => {
    const created = await createOutcome(db.pool, {
      principalId,
      title: "Atomicity probe 2",
      directive: "Second rollback probe.",
      criteria: [{ criterion: "Owner judges success", verificationMethod: { kind: "owner_judgment" } }],
      createdBy: "josctl",
    }, { now: T0, actor: "w1.1" });
    const outcomeId = created.outcome.id;
    await expect(
      transitionOutcome(db.pool, outcomeId, "running", {}, { now: new Date(T0.getTime() + 120_000), actor: "w1.1" }),
    ).rejects.toThrow();
    const events = await db.pool.query(
      "SELECT count(*)::int AS n FROM events WHERE type = 'outcome.status_changed' AND payload->>'outcomeId' = $1",
      [outcomeId],
    );
    expect(Number(events.rows[0]!.n)).toBe(0); // created/accepted only — no partial transition event
    expect(randomUUID).toBeDefined(); // keep import honest
  });
});
