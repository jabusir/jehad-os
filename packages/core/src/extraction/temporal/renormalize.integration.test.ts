// Re-normalization without re-extraction (integration; owner temporal
// directive 2026-09-17): stored rawExpression + anchorTime re-resolve through
// the CURRENT normalizer, healing normalizedTime/due_at and the version stamp
// in place — no model call, no candidate rewrite.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { acceptEvent } from "../../events/store.js";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../../db/tests/test-db.js";
import { NORMALIZER_VERSION } from "./normalizer.js";
import { renormalizeTemporal } from "./renormalize.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface TemporalRow {
  id: string;
  due_at: Date | null;
  temporal: {
    rawExpression: string;
    anchorTime: string;
    anchorTimezone: string;
    normalizedTime: string | null;
    resolutionStatus: string;
    normalizerVersion: string;
  };
}

describe.skipIf(!TEST_DATABASE_URL)("renormalizeTemporal (integration)", () => {
  let db: IsolatedDb;
  let domainUuid: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w6atemporal");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domain = await db.pool.query<{ id: string }>(
      "SELECT id FROM domains WHERE key = 'personal'",
    );
    domainUuid = String(domain.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  async function insertCommitment(args: {
    sourceEventId: string;
    temporal: Record<string, unknown>;
    dueAt: string | null;
  }): Promise<string> {
    const inserted = await db.pool.query<{ id: string }>(
      `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at,
                                confidence, status, source_event_id, temporal)
       VALUES ($1::uuid, 'i_owe', 'Jehad', 'send the plan', $2::timestamptz, 0.9, 'open', $3::uuid, $4::jsonb)
       RETURNING id`,
      [domainUuid, args.dueAt, args.sourceEventId, JSON.stringify(args.temporal)],
    );
    return String(inserted.rows[0]!.id);
  }

  async function row(id: string): Promise<TemporalRow> {
    const result = await db.pool.query<TemporalRow>(
      "SELECT id, due_at, temporal FROM commitments WHERE id = $1::uuid",
      [id],
    );
    return result.rows[0]!;
  }

  it("re-resolves stored expressions with the current normalizer and heals due_at", async () => {
    const { envelope } = await acceptEvent(db.pool, {
      type: "capture.recorded",
      source: "cli.capture",
      externalId: crypto.randomUUID(),
      occurredAt: "2026-09-17T09:00:00.000Z",
      domainId: "personal",
      sensitivity: "normal",
      schemaVersion: 1,
      payload: { text: "I'll send it Friday." },
    });

    // A row written by a stale/buggy normalizer: wrong date, old version.
    const staleFriday = await insertCommitment({
      sourceEventId: envelope.id,
      dueAt: "2027-01-01T00:00:00.000Z",
      temporal: {
        rawExpression: "Friday",
        anchorTime: "2026-09-17T09:00:00.000Z",
        anchorTimezone: "UTC",
        normalizedTime: "2027-01-01",
        resolutionStatus: "resolved",
        normalizerVersion: "temporal-norm-v0",
        resolutionConfidence: 1,
        resolutionMethod: "weekday",
      },
    });
    // A row whose stale version FABRICATED a date for a vague expression.
    const staleVague = await insertCommitment({
      sourceEventId: envelope.id,
      dueAt: "2026-10-01T00:00:00.000Z",
      temporal: {
        rawExpression: "sometime next week",
        anchorTime: "2026-09-17T09:00:00.000Z",
        anchorTimezone: "UTC",
        normalizedTime: "2026-10-01",
        resolutionStatus: "resolved",
        normalizerVersion: "temporal-norm-v0",
        resolutionConfidence: 1,
        resolutionMethod: "next-week",
      },
    });

    const first = await renormalizeTemporal(db.pool);
    expect(first.scanned).toBe(2);
    expect(first.updated).toBe(2);

    const healed = await row(staleFriday);
    expect(healed.temporal.normalizedTime).toBe("2026-09-18"); // Thu anchor → next Friday
    expect(healed.temporal.normalizerVersion).toBe(NORMALIZER_VERSION);
    expect(healed.due_at).toBeInstanceOf(Date);
    expect(healed.due_at!.toISOString()).toBe("2026-09-18T00:00:00.000Z");

    const vague = await row(staleVague);
    expect(vague.temporal.resolutionStatus).toBe("ambiguous");
    expect(vague.temporal.normalizedTime).toBeNull();
    expect(vague.due_at).toBeNull(); // fabricated date is WITHDRAWN, not kept

    // Idempotent: nothing left to change on a second pass.
    const second = await renormalizeTemporal(db.pool);
    expect(second).toEqual({ scanned: 2, updated: 0 });
  });
});
