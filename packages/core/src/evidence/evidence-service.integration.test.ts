// Evidence service integration tests (review §20 "accepted, minimal"; plan
// §7; data-model.md §5.8). Needs PostgreSQL 16 — skipped unless
// TEST_DATABASE_URL is set. Per-file isolated database.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import {
  EVIDENCE_SOURCE_TYPES,
  EvidenceNotFoundError,
  EvidenceTargetNotFoundError,
  getEvidenceFor,
  linkEvidence,
  recordEvidence,
  type EvidenceTargetType,
} from "./evidence-service.js";
import * as evidenceModule from "./index.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("evidence service (integration)", () => {
  let db: IsolatedDb;
  let domainId: string;
  let eventId: string;
  let decisionId: string;
  let assumptionId: string;
  let candidateId: string;

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "evidence");
    await migrateUp(db.pool);
    const domain = await db.pool.query(
      `INSERT INTO domains (key, name, sensitivity, retention_class)
       VALUES ('personal', 'Personal', 'normal', 'default') RETURNING id`,
    );
    domainId = String(domain.rows[0]!.id);
    const event = await db.pool.query(
      `INSERT INTO events (id, type, source, occurred_at, idempotency_key, domain_id,
                           payload, sensitivity, schema_version)
       VALUES ($1, 'decision.recorded', 'cli.capture', now(), $2, $3, '{}', 'normal', 1)
       RETURNING id`,
      [randomUUID(), `sha256:${randomUUID()}`, domainId],
    );
    eventId = String(event.rows[0]!.id);
    const decision = await db.pool.query(
      `INSERT INTO decisions (domain_id, question, chosen, decided_at, source_event_id)
       VALUES ($1, 'Use Postgres?', 'yes', now(), $2) RETURNING id`,
      [domainId, eventId],
    );
    decisionId = String(decision.rows[0]!.id);
    const assumption = await db.pool.query(
      `INSERT INTO assumptions (decision_id, statement) VALUES ($1, 'PG16 suffices') RETURNING id`,
      [decisionId],
    );
    assumptionId = String(assumption.rows[0]!.id);
    const candidate = await db.pool.query(
      `INSERT INTO memory_candidates (domain_id, proposed_class, assertion_kind, payload, provenance)
       VALUES ($1, 'working', 'observed', '{}', '{}') RETURNING id`,
      [domainId],
    );
    candidateId = String(candidate.rows[0]!.id);
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  function validInput() {
    return {
      domainId,
      sourceType: "url" as const,
      sourceRef: "https://example.com/report",
      claim: "Report states Q3 revenue grew 12%",
      observedAt: new Date("2026-09-01T12:00:00Z"),
      confidence: 0.8,
      metadata: { page: 4 },
    };
  }

  it("records evidence with all fields round-tripping", async () => {
    const record = await recordEvidence(db.pool, validInput());
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.domainId).toBe(domainId);
    expect(record.sourceType).toBe("url");
    expect(record.sourceRef).toBe("https://example.com/report");
    expect(record.claim).toBe("Report states Q3 revenue grew 12%");
    expect(record.observedAt).toEqual(new Date("2026-09-01T12:00:00Z"));
    expect(record.confidence).toBe(0.8);
    expect(record.metadata).toEqual({ page: 4 });
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it("round-trips record + link + query for every target type", async () => {
    const targets: Array<[EvidenceTargetType, string, "supported_by" | "derived_from"]> = [
      ["decision", decisionId, "supported_by"],
      ["assumption", assumptionId, "supported_by"],
      ["memory_candidate", candidateId, "derived_from"],
    ];
    for (const [targetType, targetId, relation] of targets) {
      const record = await recordEvidence(db.pool, validInput());
      const link = await linkEvidence(db.pool, {
        evidenceId: record.id,
        targetType,
        targetId,
        relation,
      });
      expect(link.evidenceId).toBe(record.id);
      expect(link.targetType).toBe(targetType);
      expect(link.targetId).toBe(targetId);
      expect(link.relation).toBe(relation);

      const evidence = await getEvidenceFor(db.pool, { targetType, targetId });
      const found = evidence.find((e) => e.id === record.id);
      expect(found).toBeDefined();
      expect(found!.relation).toBe(relation);
      expect(found!.claim).toBe(record.claim);
      expect(found!.linkId).toBe(link.id);
    }
  });

  it("records a contradicts link distinctly from supported_by", async () => {
    const supporting = await recordEvidence(db.pool, validInput());
    const contradicting = await recordEvidence(db.pool, {
      ...validInput(),
      claim: "Report correction: Q3 revenue fell 3%",
      sourceRef: "https://example.com/report/correction",
      observedAt: "2026-09-10T09:00:00Z",
    });
    await linkEvidence(db.pool, {
      evidenceId: supporting.id,
      targetType: "decision",
      targetId: decisionId,
      relation: "supported_by",
    });
    await linkEvidence(db.pool, {
      evidenceId: contradicting.id,
      targetType: "decision",
      targetId: decisionId,
      relation: "contradicts",
    });

    const evidence = await getEvidenceFor(db.pool, {
      targetType: "decision",
      targetId: decisionId,
    });
    const contra = evidence.find((e) => e.id === contradicting.id);
    const pro = evidence.find((e) => e.id === supporting.id);
    expect(contra?.relation).toBe("contradicts");
    expect(pro?.relation).toBe("supported_by");
    expect(evidence.filter((e) => e.relation === "contradicts")).toHaveLength(1);
  });

  it("rejects invalid recordEvidence inputs (provenance rule + validation)", async () => {
    await expect(recordEvidence(db.pool, { ...validInput(), confidence: 1.5 })).rejects.toThrow(
      RangeError,
    );
    await expect(recordEvidence(db.pool, { ...validInput(), confidence: -0.1 })).rejects.toThrow(
      RangeError,
    );
    await expect(recordEvidence(db.pool, { ...validInput(), confidence: Number.NaN })).rejects
      .toThrow(RangeError);
    await expect(recordEvidence(db.pool, { ...validInput(), sourceType: "vibe" })).rejects.toThrow(
      TypeError,
    );
    await expect(recordEvidence(db.pool, { ...validInput(), claim: "  " })).rejects.toThrow(
      TypeError,
    );
    await expect(recordEvidence(db.pool, { ...validInput(), sourceRef: "" })).rejects.toThrow(
      TypeError,
    );
    // No floating claims: observedAt is required and must be a real date.
    await expect(
      recordEvidence(db.pool, { ...validInput(), observedAt: undefined as unknown as Date }),
    ).rejects.toThrow(TypeError);
    await expect(recordEvidence(db.pool, { ...validInput(), observedAt: "not-a-date" })).rejects
      .toThrow(TypeError);
  });

  it("fails the domains FK on unknown domainId", async () => {
    const err = await recordEvidence(db.pool, {
      ...validInput(),
      domainId: randomUUID(),
    }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503");
  });

  it("rejects links to unknown evidence or unknown targets", async () => {
    const record = await recordEvidence(db.pool, validInput());
    await expect(
      linkEvidence(db.pool, {
        evidenceId: randomUUID(),
        targetType: "decision",
        targetId: decisionId,
        relation: "supported_by",
      }),
    ).rejects.toThrow(EvidenceNotFoundError);
    await expect(
      linkEvidence(db.pool, {
        evidenceId: record.id,
        targetType: "decision",
        targetId: randomUUID(),
        relation: "supported_by",
      }),
    ).rejects.toThrow(EvidenceTargetNotFoundError);
    for (const targetType of ["assumption", "memory_candidate"] as const) {
      await expect(
        linkEvidence(db.pool, {
          evidenceId: record.id,
          targetType,
          targetId: randomUUID(),
          relation: "supported_by",
        }),
      ).rejects.toThrow(EvidenceTargetNotFoundError);
    }
    await expect(
      linkEvidence(db.pool, {
        evidenceId: record.id,
        targetType: "decision",
        targetId: decisionId,
        relation: "relates_to" as never,
      }),
    ).rejects.toThrow(TypeError);
  });

  it("returns no evidence for an unlinked target", async () => {
    const evidence = await getEvidenceFor(db.pool, {
      targetType: "decision",
      targetId: randomUUID(),
    });
    expect(evidence).toEqual([]);
  });

  it("exposes no update/delete path — evidence is immutable (append-only)", async () => {
    const surface = Object.keys(evidenceModule);
    expect(surface).toContain("recordEvidence");
    expect(surface).toContain("linkEvidence");
    expect(surface).toContain("getEvidenceFor");
    expect(surface.filter((name) => /update|patch|delete|remove/i.test(name))).toEqual([]);
    // Append-only: re-recording the same claim yields a new row, not a mutation.
    const input = { ...validInput(), claim: "Immutability probe: unique claim" };
    const first = await recordEvidence(db.pool, input);
    const second = await recordEvidence(db.pool, input);
    expect(second.id).not.toBe(first.id);
    const rows = await db.pool.query(`SELECT claim FROM evidence WHERE claim = $1`, [
      first.claim,
    ]);
    expect(rows.rows).toHaveLength(2);
  });

  it("keeps the v1 source_type vocabulary exactly url|event|document|message|manual", () => {
    expect([...EVIDENCE_SOURCE_TYPES]).toEqual([
      "url",
      "event",
      "document",
      "message",
      "manual",
    ]);
  });
});
