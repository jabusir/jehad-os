// Cross-lane seam regression (M5B extraction → M5C promotion): a user-declared
// capture must travel the full pipeline — event store → extraction candidates
// → five-gate promotion → canonical commitments row — without manual massage.
// The two lanes were built in parallel against candidate-contract.ts; this test
// is where any drift between them surfaces.

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createIsolatedTestDb, dropIsolatedTestDb } from "../../db/tests/test-db.js";
import { migrateUp, seedDomains } from "../../db/src/index.js";
import { acceptEvent } from "../src/events/index.js";
import { extractFromEvent, type WrittenCandidate } from "../src/extraction/index.js";
import { promoteCandidate } from "../src/promotion/index.js";
import { loadEgressPolicyRegistry } from "../src/egress/index.js";
import type { EventEnvelope } from "../src/events/index.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("extraction → promotion seam (integration)", () => {
  let db: Awaited<ReturnType<typeof createIsolatedTestDb>>;
  let registry: Awaited<ReturnType<typeof loadEgressPolicyRegistry>>;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "seam");
    await migrateUp(db.pool, undefined);
    await seedDomains(db.pool);
    registry = await loadEgressPolicyRegistry();
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  const fakeProvider = {
    id: "fake-eval",
    async complete(request: any) {
      return {
        provider: request.provider,
        model: "fake",
        promptVersion: "seam-test",
        text: JSON.stringify({
          is_commitment: true,
          is_decision: false,
          direction: "i_owe",
          counterparty: "Jehad",
          description: "send the migration plan",
          due_date: null,
          confidence: 0.9,
        }),
        inTokens: 10,
        outTokens: 10,
        costUsd: 0,
        latencyMs: 1,
      };
    },
  } as never;

  async function captureAndExtract(text: string): Promise<WrittenCandidate[]> {
    const { envelope } = await acceptEvent(db.pool, {
      type: "capture.recorded",
      source: "cli.capture",
      externalId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      schemaVersion: 1,
      payload: { kind: "capture", text },
    });
    const result = await extractFromEvent(
      { db: db.pool, provider: fakeProvider, model: "fake" },
      envelope as EventEnvelope,
    );
    return [...result.candidates];
  }

  it("lands a user-declared commitment canonically end-to-end", async () => {
    const candidates = await captureAndExtract(
      "I'll send Jehad the migration plan Friday",
    );
    const commitments = candidates.filter((c) => c.contract.payload.kind === "commitment");
    expect(commitments.length).toBeGreaterThan(0);

    for (const candidate of commitments) {
      const outcome = await promoteCandidate(db.pool, candidate.id, {
        egressRegistry: registry,
      });
      expect(outcome.action).toBe("promoted");
      expect(outcome.write?.target).toBe("commitments");
    }

    const rows = await db.pool.query<{
      direction: string;
      counterparty_text: string;
      description: string;
      status: string;
    }>("SELECT direction, counterparty_text, description, status FROM commitments");
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0]!.direction).toBe("i_owe");
    expect(rows.rows[0]!.counterparty_text).toBe("Jehad");
  });

  it("routes model_inferred semantic candidates to review, not canonical (seam honors assertion_kind)", async () => {
    // Same text but ingested via an adapter source → externally_sourced per
    // M5B's assertionKindForSource — must NOT auto-land as canonical fact.
    const { envelope } = await acceptEvent(db.pool, {
      type: "capture.recorded",
      source: "adapter:probe",
      externalId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      domainId: "personal",
      sensitivity: "normal",
      schemaVersion: 1,
      payload: { kind: "capture", text: "Adapter says I owe Jehad a plan" },
    });
    const result = await extractFromEvent(
      { db: db.pool, provider: fakeProvider, model: "fake" },
      envelope as EventEnvelope,
    );
    const before = (
      await db.pool.query("SELECT count(*)::int AS n FROM commitments")
    ).rows[0]!.n;
    for (const candidate of result.candidates) {
      if (candidate.contract.payload.kind !== "commitment") continue;
      const outcome = await promoteCandidate(db.pool, candidate.id, {
        egressRegistry: registry,
      });
      // externally_sourced commitments are semantic writes → review, never
      // direct canonical landing (plan §6.2 gate 5).
      expect(outcome.action).toBe("in_review");
      expect(outcome.write).toBeNull();
    }
    const after = (
      await db.pool.query("SELECT count(*)::int AS n FROM commitments")
    ).rows[0]!.n;
    expect(after).toBe(before);
  });
});
