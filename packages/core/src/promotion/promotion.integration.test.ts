// Promotion pipeline integration tests (M5C acceptance): the five gates
// against a real PostgreSQL schema — canonical landings, review routing,
// conflicts, T14 claim-vs-fact, and memory.promoted events. Needs
// PostgreSQL 16; skipped unless TEST_DATABASE_URL is set. Isolated DB.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp, seedDomains } from "@jehad/db";
import { createIsolatedTestDb, dropIsolatedTestDb, type IsolatedDb } from "../../../db/tests/test-db.js";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import { acceptEvent } from "../events/store.js";
import {
  InvalidCandidateStatusError,
  promoteCandidate,
  type PromotionOutcome,
} from "./pipeline.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("promotion pipeline (integration)", () => {
  let db: IsolatedDb;
  let domainUuids: Map<string, string>;

  const registry = new ModelEgressPolicyRegistry([
    {
      id: "personal-normal",
      domainId: "personal",
      sensitivity: "normal",
      allowedProviders: ["openrouter"],
      allowRemote: false,
      requireRedaction: false,
    },
    {
      id: "work-sensitive-remote",
      domainId: "work",
      sensitivity: "sensitive",
      allowedProviders: ["openrouter"],
      allowRemote: true,
      requireRedaction: true,
    },
  ]);

  beforeAll(async () => {
    db = await createIsolatedTestDb(TEST_DATABASE_URL!, "m5cpromo");
    await migrateUp(db.pool);
    await seedDomains(db.pool);
    const domains = await db.pool.query("SELECT id, key FROM domains");
    domainUuids = new Map(domains.rows.map((row) => [String(row.key), String(row.id)]));
  });

  afterAll(async () => {
    await dropIsolatedTestDb(TEST_DATABASE_URL!, db);
  });

  let eventCounter = 0;
  async function insertSourceEvent(domainKey = "personal"): Promise<string> {
    eventCounter += 1;
    const accepted = await acceptEvent(db.pool, {
      type: "capture.recorded",
      schemaVersion: 1,
      source: "cli.capture",
      externalId: `promo-test-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      domainId: domainKey,
      sensitivity: "normal",
      payload: { seq: eventCounter },
      runId: null,
    });
    return accepted.envelope.id;
  }

  async function insertCandidate(args: {
    domainKey?: string;
    proposedClass: string;
    assertionKind: string;
    payload: Record<string, unknown>;
    confidence?: number;
    provenance?: Record<string, unknown>;
    sourceEventId?: string | null;
  }): Promise<string> {
    const domainKey = args.domainKey ?? "personal";
    const sourceEventId = args.sourceEventId === undefined ? await insertSourceEvent(domainKey) : args.sourceEventId;
    const provenance =
      args.provenance ??
      {
        sourceEventId,
        runId: null,
        model: args.assertionKind === "model_inferred" ? "test-model" : null,
        promptVersion: args.assertionKind === "model_inferred" ? "p1" : null,
      };
    // The table has no confidence column (data-model §5.9): the seam
    // contract's confidence serializes as payload.confidence.
    const payload = { ...args.payload, confidence: args.confidence ?? 0.9 };
    const inserted = await db.pool.query(
      `INSERT INTO memory_candidates (domain_id, proposed_class, assertion_kind, payload, provenance)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING id`,
      [
        domainUuids.get(domainKey),
        args.proposedClass,
        args.assertionKind,
        JSON.stringify(payload),
        JSON.stringify(provenance),
      ],
    );
    return String(inserted.rows[0].id);
  }

  async function candidateRow(id: string): Promise<Record<string, unknown>> {
    const result = await db.pool.query("SELECT * FROM memory_candidates WHERE id = $1::uuid", [id]);
    return result.rows[0]!;
  }

  async function promotedEvent(candidateId: string): Promise<Record<string, unknown> | undefined> {
    const result = await db.pool.query(
      `SELECT * FROM events WHERE type = 'memory.promoted' AND payload->>'candidateId' = $1`,
      [candidateId],
    );
    return result.rows[0];
  }

  function promote(id: string): Promise<PromotionOutcome> {
    return promoteCandidate(db.pool, id, { egressRegistry: registry });
  }

  it("happy path: user_declared commitment lands canonical with entity link + memory.promoted", async () => {
    const entity = await db.pool.query(
      `INSERT INTO entities (discriminator, domain_id, name, sensitivity)
       VALUES ('org', $1::uuid, 'Acme Corp', 'normal') RETURNING id`,
      [domainUuids.get("personal")],
    );
    const entityId = String(entity.rows[0].id);
    const sourceEventId = await insertSourceEvent();
    const candidateId = await insertCandidate({
      proposedClass: "commitment",
      assertionKind: "user_declared",
      sourceEventId,
      payload: {
        direction: "i_owe",
        counterparty: "acme corp",
        description: "Deliver the migration plan by Friday",
        dueAt: "2026-09-25T17:00:00Z",
      },
    });

    const outcome = await promote(candidateId);
    expect(outcome.action).toBe("promoted");
    expect(outcome.write?.target).toBe("commitments");

    const commitment = (
      await db.pool.query("SELECT * FROM commitments WHERE source_event_id = $1::uuid", [sourceEventId])
    ).rows[0];
    expect(commitment).toMatchObject({
      domain_id: domainUuids.get("personal"),
      direction: "i_owe",
      counterparty_text: "acme corp",
      counterparty_entity_id: entityId,
      description: "Deliver the migration plan by Friday",
      status: "open",
      may_follow_up: false,
    });

    const edge = (
      await db.pool.query(
        `SELECT * FROM relationships
         WHERE from_type = 'commitment' AND from_id = $1::uuid
           AND relation = 'counterparty' AND to_type = 'entity' AND to_id = $2::uuid`,
        [commitment.id, entityId],
      )
    ).rows[0];
    expect(edge).toBeDefined();
    expect(edge.source_event_id).toBe(sourceEventId);

    const event = await promotedEvent(candidateId);
    expect(event).toBeDefined();
    expect((event!.payload as Record<string, unknown>).targetId).toBe(commitment.id);
    const outbox = (
      await db.pool.query("SELECT * FROM outbox WHERE event_id = $1::uuid", [event!.id])
    ).rows[0];
    expect(outbox).toBeDefined();
  });

  it("episodic writes without review and emits memory.promoted (event log is canonical)", async () => {
    const candidateId = await insertCandidate({
      proposedClass: "episodic",
      assertionKind: "observed",
      payload: { summary: "argued with the router for an hour" },
    });
    const outcome = await promote(candidateId);
    expect(outcome.action).toBe("promoted");
    expect(outcome.write).toBeNull();
    const row = await candidateRow(candidateId);
    expect(row.status).toBe("promoted");
    expect((row.gate_result as Record<string, unknown>).note).toBe("episodic_event_log");
    expect(await promotedEvent(candidateId)).toBeDefined();
    const semanticWrites = await db.pool.query(
      "SELECT count(*)::int AS n FROM evidence WHERE metadata->>'candidateId' = $1",
      [candidateId],
    );
    expect(semanticWrites.rows[0].n).toBe(0);
  });

  it("model_inferred semantic lands in the review queue, nothing canonical yet", async () => {
    const candidateId = await insertCandidate({
      proposedClass: "semantic",
      assertionKind: "model_inferred",
      payload: { statement: "Jehad prefers concise summaries" },
    });
    const outcome = await promote(candidateId);
    expect(outcome.action).toBe("in_review");
    expect(outcome.reason).toBe("semantic_requires_review");
    const row = await candidateRow(candidateId);
    expect(row.status).toBe("in_review");
    expect(row.gated_class).toBe("semantic");
    const claims = await db.pool.query(
      "SELECT count(*)::int AS n FROM evidence WHERE metadata->>'candidateId' = $1",
      [candidateId],
    );
    expect(claims.rows[0].n).toBe(0);
    expect(await promotedEvent(candidateId)).toBeUndefined();
  });

  it("work-domain semantic is blocked by gate 2; abstract method-level learning passes", async () => {
    const blocked = await insertCandidate({
      domainKey: "work",
      proposedClass: "semantic",
      assertionKind: "user_declared",
      payload: { statement: "Employer X has vulnerability Y in table Z" },
    });
    const blockedOutcome = await promote(blocked);
    expect(blockedOutcome).toMatchObject({ action: "rejected", gate: 2, reason: "work_domain_blocked" });
    expect((await candidateRow(blocked)).status).toBe("rejected");

    const abstract = await insertCandidate({
      domainKey: "work",
      proposedClass: "preference",
      assertionKind: "user_declared",
      payload: {
        key: "webhook-idempotency",
        value: "experienced",
        abstraction: "method_level",
      },
    });
    const abstractOutcome = await promote(abstract);
    expect(abstractOutcome.action).toBe("promoted");
    expect(abstractOutcome.write?.target).toBe("evidence_claim");
    const claim = (
      await db.pool.query("SELECT * FROM evidence WHERE metadata->>'candidateId' = $1", [abstract])
    ).rows[0];
    expect(claim.domain_id).toBe(domainUuids.get("work"));
  });

  it("missing provenance is rejected with reason", async () => {
    const candidateId = await insertCandidate({
      proposedClass: "preference",
      assertionKind: "user_declared",
      payload: { key: "theme", value: "dark" },
      provenance: { runId: null, model: null, promptVersion: null },
    });
    const outcome = await promote(candidateId);
    expect(outcome).toMatchObject({ action: "rejected", gate: 1, reason: "provenance_missing" });
    expect((await candidateRow(candidateId)).status).toBe("rejected");
  });

  it("conflict: contradicting preferences — both kept, conflict recorded, review if material", async () => {
    const first = await insertCandidate({
      proposedClass: "preference",
      assertionKind: "user_declared",
      payload: { key: "code-review-detail", value: "verbose" },
    });
    expect((await promote(first)).action).toBe("promoted");

    const second = await insertCandidate({
      proposedClass: "preference",
      assertionKind: "user_declared",
      payload: { key: "code-review-detail", value: "concise" },
    });
    const outcome = await promote(second);
    expect(outcome).toMatchObject({ action: "in_review", reason: "material_conflict" });
    const row = await candidateRow(second);
    const conflict = (row.gate_result as Record<string, unknown>).conflict as Record<string, unknown>;
    expect(conflict).toMatchObject({ key: "code-review-detail", existingValue: "verbose", newValue: "concise" });

    // Approve: the second preference also lands — both are kept, and the
    // conflict is recorded as a relationships edge between the two claims.
    const approved = await promoteCandidate(db.pool, second, {
      egressRegistry: registry,
      review: { approvedBy: "jehad" },
    });
    expect(approved.action).toBe("promoted");

    const claims = (
      await db.pool.query(
        "SELECT * FROM evidence WHERE metadata->>'conflictKey' = 'code-review-detail' ORDER BY created_at",
      )
    ).rows;
    expect(claims).toHaveLength(2);

    const edge = (
      await db.pool.query(
        `SELECT * FROM relationships
         WHERE relation = 'conflicts_with' AND from_type = 'evidence' AND to_type = 'evidence'`,
      )
    ).rows[0];
    expect(edge).toBeDefined();
    expect(edge.from_id).toBe(claims[1].id);
    expect(edge.to_id).toBe(claims[0].id);

    const event = await promotedEvent(second);
    expect((event!.payload as Record<string, unknown>).review).toMatchObject({ approvedBy: "jehad" });
  });

  it("T14 regression: 'Company X has 3M customers' stays a claim, never a verified fact", async () => {
    const candidateId = await insertCandidate({
      proposedClass: "semantic",
      assertionKind: "user_declared",
      payload: { statement: "Company X has 3M customers" },
    });
    // Not auto-promoted: a user statement about the external world is a claim.
    const routed = await promote(candidateId);
    expect(routed.action).toBe("in_review");

    const approved = await promoteCandidate(db.pool, candidateId, {
      egressRegistry: registry,
      review: { approvedBy: "jehad" },
    });
    expect(approved.action).toBe("promoted");

    const claim = (
      await db.pool.query("SELECT * FROM evidence WHERE metadata->>'candidateId' = $1", [candidateId])
    ).rows[0];
    expect(claim).toMatchObject({
      claim: "Company X has 3M customers",
      source_type: "user_declared",
    });
    expect((claim.metadata as Record<string, unknown>)).toMatchObject({ verified: false, class: "semantic" });
    // "Jehad said X" did NOT become a commitment/decision/verified fact:
    const canonical = await db.pool.query(
      "SELECT count(*)::int AS n FROM commitments UNION ALL SELECT count(*)::int FROM decisions",
    );
    expect(canonical.rows[0].n).toBe(1); // the happy-path commitment only
    expect(canonical.rows[1].n).toBe(0);
  });

  it("user_declared personal decision lands canonical in decisions", async () => {
    const sourceEventId = await insertSourceEvent();
    const candidateId = await insertCandidate({
      proposedClass: "decision",
      assertionKind: "user_declared",
      sourceEventId,
      payload: { question: "Which database?", chosen: "PostgreSQL", reasons: "boring and explicit" },
    });
    const outcome = await promote(candidateId);
    expect(outcome.write?.target).toBe("decisions");
    const decision = (
      await db.pool.query("SELECT * FROM decisions WHERE source_event_id = $1::uuid", [sourceEventId])
    ).rows[0];
    expect(decision).toMatchObject({ question: "Which database?", chosen: "PostgreSQL" });
  });

  it("gate 3: egress denial rejects the promotion before any write", async () => {
    // finance maps to sensitivity "sensitive"; the registry has no rule
    // allowing any provider for finance.sensitive → deny by default.
    const candidateId = await insertCandidate({
      domainKey: "finance",
      proposedClass: "semantic",
      assertionKind: "user_declared",
      payload: { statement: "payroll clears on the 28th" },
    });
    const outcome = await promote(candidateId);
    expect(outcome).toMatchObject({ action: "rejected", gate: 3, reason: "egress_denied" });
  });

  it("status guards: in_review candidates only move through the review path", async () => {
    const candidateId = await insertCandidate({
      proposedClass: "semantic",
      assertionKind: "model_inferred",
      payload: { statement: "something inferred" },
    });
    await promote(candidateId); // → in_review
    await expect(promote(candidateId)).rejects.toBeInstanceOf(InvalidCandidateStatusError);
    const fresh = await insertCandidate({
      proposedClass: "semantic",
      assertionKind: "model_inferred",
      payload: { statement: "another inference" },
    });
    await expect(
      promoteCandidate(db.pool, fresh, { egressRegistry: registry, review: { approvedBy: "jehad" } }),
    ).rejects.toBeInstanceOf(InvalidCandidateStatusError);
  });
});
