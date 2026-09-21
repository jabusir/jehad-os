import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { recallMemory, renderMemoryRecallBlock } from "./memory-recall.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const NOW = new Date("2026-09-17T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

interface FixtureIds {
  readonly evidence: {
    readonly e1: string;
    readonly e2: string;
    readonly eMulti: string;
    readonly eHealth: string;
    readonly eFlow: string;
  };
  readonly decisions: {
    readonly d1: string;
    readonly dOld: string;
    readonly dSeating: string;
    readonly dWork: string;
  };
  readonly procedures: {
    readonly pV1: string;
    readonly pV2: string;
    readonly pRitual: string;
  };
  readonly commitments: {
    readonly c1: string;
    readonly cMet: string;
    readonly cWork: string;
  };
}

const READ_ONLY_PIN_TABLES = [
  "evidence",
  "decisions",
  "procedures",
  "commitments",
  "events",
  "relationships",
  "memory_candidates",
  "domains",
  "entities",
  "runs",
  "audit_log",
] as const;

async function tableCounts(db: IsolatedDb): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of READ_ONLY_PIN_TABLES) {
    const result = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = Number(result.rows[0]!["n"]);
  }
  return counts;
}

describe.skipIf(!TEST_DATABASE_URL)("memory recall (integration)", () => {
  let db: IsolatedDb;
  let f: FixtureIds;
  let principalA: string;
  let principalB: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "w2memrecall");
    await migrateUp(db.pool);
    const t0 = NOW.getTime();
    const at = (daysAgo: number): string => new Date(t0 - daysAgo * MS_PER_DAY).toISOString();

    const domainIds = new Map<string, string>();
    for (const [key, sensitivity] of [
      ["personal", "normal"],
      ["work", "work"],
      ["health", "sensitive"],
    ] as const) {
      const inserted = await db.pool.query(
        `INSERT INTO domains (key, name, sensitivity, retention_class, detachable, storage_mode)
         VALUES ($1, $2, $3, 'default', $4, 'local') RETURNING id`,
        [key, key, sensitivity, key === "work"],
      );
      domainIds.set(key, String(inserted.rows[0]!.id));
    }
    const dom = (key: string): string => domainIds.get(key)!;

    const insertEvent = async (domainKey: string, ageDays: number): Promise<string> => {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO events (id, type, source, occurred_at, recorded_at, idempotency_key,
                             domain_id, payload, sensitivity, schema_version)
         VALUES ($1, 'capture.recorded', 'cli.capture', $2::timestamptz, $2::timestamptz, $3,
                 $4::uuid, $5::jsonb, 'normal', 1)`,
        [id, at(ageDays), `sha256:${randomUUID()}`, dom(domainKey), JSON.stringify({ text: "fixture" })],
      );
      return id;
    };

    const insertEvidence = async (args: {
      domainKey: string;
      claim: string;
      sourceType: string;
      sourceRef: string;
      ageDays: number;
    }): Promise<string> => {
      const inserted = await db.pool.query(
        `INSERT INTO evidence (domain_id, source_type, source_ref, claim, observed_at, confidence,
                               metadata, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, 0.9, NULL, $5::timestamptz, $5::timestamptz)
         RETURNING id`,
        [dom(args.domainKey), args.sourceType, args.sourceRef, args.claim, at(args.ageDays)],
      );
      return String(inserted.rows[0]!.id);
    };

    const insertDecision = async (args: {
      domainKey: string;
      question: string;
      chosen: string;
      ageDays: number;
    }): Promise<string> => {
      const sourceEventId = await insertEvent(args.domainKey, args.ageDays);
      const inserted = await db.pool.query(
        `INSERT INTO decisions (domain_id, question, chosen, decided_at, source_event_id,
                                created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::uuid, $4::timestamptz, $4::timestamptz)
         RETURNING id`,
        [dom(args.domainKey), args.question, args.chosen, at(args.ageDays), sourceEventId],
      );
      return String(inserted.rows[0]!.id);
    };

    const insertProcedure = async (args: {
      name: string;
      version: number;
      bodyRef: string;
      ageDays: number;
    }): Promise<string> => {
      const inserted = await db.pool.query(
        `INSERT INTO procedures (name, version, body_ref, created_at, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz) RETURNING id`,
        [args.name, args.version, args.bodyRef, at(args.ageDays)],
      );
      return String(inserted.rows[0]!.id);
    };

    const insertCommitment = async (args: {
      domainKey: string;
      description: string;
      counterparty: string;
      status: string;
      ageDays: number;
    }): Promise<string> => {
      const sourceEventId = await insertEvent(args.domainKey, args.ageDays);
      const inserted = await db.pool.query(
        `INSERT INTO commitments (domain_id, direction, counterparty_text, description, due_at,
                                  confidence, status, source_event_id, created_at, updated_at)
         VALUES ($1::uuid, 'i_owe', $2, $3, NULL, 0.9, $4, $5::uuid, $6::timestamptz, $6::timestamptz)
         RETURNING id`,
        [
          dom(args.domainKey),
          args.counterparty,
          args.description,
          args.status,
          sourceEventId,
          at(args.ageDays),
        ],
      );
      return String(inserted.rows[0]!.id);
    };

    const e1 = await insertEvidence({
      domainKey: "personal",
      claim: "Venue deposit must clear before the dinner",
      sourceType: "user_declared",
      sourceRef: randomUUID(),
      ageDays: 3,
    });
    const e2 = await insertEvidence({
      domainKey: "personal",
      claim: "Henna asked to move the family sync to Thursday",
      sourceType: "message",
      sourceRef: "imessage:msg-42",
      ageDays: 1,
    });
    const eMulti = await insertEvidence({
      domainKey: "personal",
      claim: "No shellfish at group dinners",
      sourceType: "user_declared",
      sourceRef: randomUUID(),
      ageDays: 2,
    });
    const eHealth = await insertEvidence({
      domainKey: "health",
      claim: "Venue near the clinic is quieter",
      sourceType: "manual",
      sourceRef: "note:1",
      ageDays: 2,
    });
    const eFlow = await insertEvidence({
      domainKey: "personal",
      claim: "Packing list:\nsuitcase and passports",
      sourceType: "observed",
      sourceRef: randomUUID(),
      ageDays: 4,
    });

    const d1 = await insertDecision({
      domainKey: "personal",
      question: "Venue for the anniversary dinner",
      chosen: "The River Café",
      ageDays: 5,
    });
    const dOld = await insertDecision({
      domainKey: "personal",
      question: "Venue and cake for the dinner party",
      chosen: "Home baking",
      ageDays: 30,
    });
    const dSeating = await insertDecision({
      domainKey: "personal",
      question: "Dinner seating chart",
      chosen: "one long table",
      ageDays: 3,
    });
    const dWork = await insertDecision({
      domainKey: "work",
      question: "Venue for the team offsite",
      chosen: "Lisbon",
      ageDays: 2,
    });

    const pV1 = await insertProcedure({
      name: "Venue booking checklist",
      version: 1,
      bodyRef: "procedures/venue-booking.v1.md",
      ageDays: 20,
    });
    const pV2 = await insertProcedure({
      name: "Venue booking checklist",
      version: 2,
      bodyRef: "procedures/venue-booking.md",
      ageDays: 10,
    });
    const pRitual = await insertProcedure({
      name: "Weekly review ritual",
      version: 1,
      bodyRef: "procedures/weekly-review.md",
      ageDays: 4,
    });

    const c1 = await insertCommitment({
      domainKey: "personal",
      description: "Confirm venue by Friday",
      counterparty: "Henna",
      status: "open",
      ageDays: 9,
    });
    const cMet = await insertCommitment({
      domainKey: "personal",
      description: "Pay the venue deposit",
      counterparty: "River Café",
      status: "met",
      ageDays: 15,
    });
    const cWork = await insertCommitment({
      domainKey: "work",
      description: "Send venue contract to employer",
      counterparty: "employer",
      status: "open",
      ageDays: 1,
    });

    f = {
      evidence: { e1, e2, eMulti, eHealth, eFlow },
      decisions: { d1, dOld, dSeating, dWork },
      procedures: { pV1, pV2, pRitual },
      commitments: { c1, cMet, cWork },
    };

    const mkPrincipal = async (name: string): Promise<string> => {
      const inserted = await db.pool.query(
        `INSERT INTO principals (type, name) VALUES ('user', $1) RETURNING id`,
        [name],
      );
      return String(inserted.rows[0]!.id);
    };
    principalA = await mkPrincipal(`jehad-${randomUUID().slice(0, 8)}`);
    principalB = await mkPrincipal(`yusra-${randomUUID().slice(0, 8)}`);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  it("relevance ordering: matched-term count first, recency on ties, ≤5 cap", async () => {
    const results = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "venue dinner henna",
    });
    expect(results).toHaveLength(5);
    expect(results.map((item) => item.ref)).toEqual([
      f.evidence.e1,
      f.decisions.d1,
      f.commitments.c1,
      f.decisions.dOld,
      f.evidence.e2,
    ]);
    expect(results.map((item) => item.score)).toEqual([2, 2, 2, 2, 1]);
    for (const excluded of [f.decisions.dWork, f.evidence.eHealth, f.commitments.cWork]) {
      expect(results.map((item) => item.ref)).not.toContain(excluded);
    }
  });

  it("limit is clamped to 5 and honored below it", async () => {
    const clamped = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "venue dinner henna",
      limit: 99,
    });
    expect(clamped).toHaveLength(5);
    const small = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "venue dinner henna",
      limit: 2,
    });
    expect(small.map((item) => item.ref)).toEqual([f.evidence.e1, f.decisions.d1]);
  });

  it("attribution: assertion kind, source label, and per-kind date fields", async () => {
    const results = await recallMemory(db.pool, { principalId: principalA, queryText: "henna" });
    const e2Item = results.find((item) => item.ref === f.evidence.e2);
    expect(e2Item).toMatchObject({
      kind: "evidence",
      assertionKind: null,
      sourceAttribution: "message:imessage:msg-42",
      score: 1,
    });
    expect(e2Item!.kind === "evidence" && e2Item.occurredAt).toBe(
      new Date(NOW.getTime() - MS_PER_DAY).toISOString(),
    );

    const decisions = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "seating chart",
    });
    const dItem = decisions.find((item) => item.ref === f.decisions.dSeating);
    expect(dItem).toMatchObject({
      kind: "decision",
      assertionKind: null,
      sourceAttribution: "cli.capture",
      summary: "Dinner seating chart → one long table",
    });
    expect(dItem!.kind === "decision" && dItem.decidedAt).toBe(
      new Date(NOW.getTime() - 3 * MS_PER_DAY).toISOString(),
    );

    const procedures = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "booking checklist",
    });
    const pItem = procedures.find((item) => item.ref === f.procedures.pV2);
    expect(pItem).toMatchObject({
      kind: "procedure",
      sourceAttribution: "procedures/venue-booking.md",
      summary: "Venue booking checklist",
    });
    expect(procedures.map((item) => item.ref)).not.toContain(f.procedures.pV1);
    expect(procedures.map((item) => item.ref)).not.toContain(f.procedures.pRitual);
  });

  it("promoted evidence claims carry their assertion kind; newlines flatten", async () => {
    const results = await recallMemory(db.pool, { principalId: principalA, queryText: "shellfish" });
    const item = results.find((r) => r.ref === f.evidence.eMulti);
    expect(item).toMatchObject({ kind: "evidence", assertionKind: "user_declared" });
    expect(item!.summary).toBe("No shellfish at group dinners");

    const flow = await recallMemory(db.pool, { principalId: principalA, queryText: "packing passports" });
    const flowItem = flow.find((r) => r.ref === f.evidence.eFlow);
    expect(flowItem).toBeDefined();
    expect(flowItem!.summary).toBe("Packing list:\\nsuitcase and passports");
    expect(flowItem!.summary).not.toContain("\n");
    expect(renderMemoryRecallBlock(flow)[0]).not.toContain("\n");
  });

  it("must-return-none: nothing matches, nothing fabricated", async () => {
    await expect(
      recallMemory(db.pool, { principalId: principalA, queryText: "kayak glacier expedition" }),
    ).resolves.toEqual([]);
    await expect(
      recallMemory(db.pool, { principalId: principalA, queryText: "" }),
    ).resolves.toEqual([]);
  });

  it("domain sensitivity gate: non-normal domains never surface, even when named", async () => {
    const workScoped = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "venue offsite",
      domainId: "work",
    });
    expect(workScoped.filter((item) => item.kind !== "procedure")).toEqual([]);
    const all = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "venue",
    });
    for (const excluded of [f.decisions.dWork, f.evidence.eHealth, f.commitments.cWork]) {
      expect(all.map((item) => item.ref)).not.toContain(excluded);
    }
  });

  it("principal convention: no principal linkage on these tables — recall is domain-scoped identically", async () => {
    const a = await recallMemory(db.pool, { principalId: principalA, queryText: "venue dinner" });
    const b = await recallMemory(db.pool, { principalId: principalB, queryText: "venue dinner" });
    expect(a).toEqual(b);
  });

  it("commitment memory includes discharged items with their status", async () => {
    const results = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "pay the venue deposit",
    });
    const cMetItem = results.find((item) => item.ref === f.commitments.cMet);
    expect(cMetItem).toMatchObject({ kind: "commitment", status: "met", score: 4 });
    expect(results[0]!.ref).toBe(f.commitments.cMet);
    expect(results[1]!.ref).toBe(f.evidence.e1);
    const lines = renderMemoryRecallBlock(results);
    const cMetLine = lines.find((line) => line.startsWith("[commitment "));
    expect(cMetLine).toBeDefined();
    expect(cMetLine).toContain("(met)");
  });

  it("render: attributed, flattened, capped, deterministic lines", async () => {
    const first = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "venue dinner henna",
    });
    const second = await recallMemory(db.pool, {
      principalId: principalA,
      queryText: "venue dinner henna",
    });
    expect(first).toEqual(second);
    const lines = renderMemoryRecallBlock(first);
    expect(lines).toHaveLength(first.length);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(200);
      expect(line).toMatch(
        /^\[(evidence|decision|procedure|commitment) [edpc]-\d{4}-\d{2}-\d{2}(#\d+)? \| .+\] /,
      );
      expect(line).not.toContain("\n");
    }
    expect(lines.join("\n")).toContain("per your decision on Sep 12");
    expect(lines.join("\n")).toContain("user_declared");
  });

  it("read-only pin: zero writes to any touched table across recalls", async () => {
    const before = await tableCounts(db);
    await recallMemory(db.pool, { principalId: principalA, queryText: "venue dinner henna" });
    await recallMemory(db.pool, { principalId: principalB, queryText: "henna" });
    await recallMemory(db.pool, { principalId: principalA, queryText: "shellfish" });
    await recallMemory(db.pool, { principalId: principalA, queryText: "kayak" });
    await renderMemoryRecallBlock(
      await recallMemory(db.pool, { principalId: principalA, queryText: "booking checklist" }),
    );
    const after = await tableCounts(db);
    expect(after).toEqual(before);
  });
});
