/**
 * Gate 5 canonical writers. Every semantic write flows through domain tables
 * carrying source_event_id provenance (plan §15 M5); no writer calls a
 * model, and no write path exists outside these tables (schema v1):
 *
 *   commitment → commitments (+ optional counterparty entity link and
 *                relationship edge when the counterparty resolves as text)
 *   decision   → decisions
 *   preference / semantic claims / standalone assumptions → evidence rows
 *                (the claim primitive, review §20 — metadata marks class,
 *                candidate, and verified:false; claims are NEVER verified
 *                facts, T14)
 *   assumption w/ payload.decisionId → assumptions
 *   procedural/policy with body_ref → procedures index rows
 *   episodic/working → no semantic write (the event log / harness own them)
 */

import type { AssertionKind, ProposedClass } from "../memory/candidate-contract.js";
import type { ConflictInfo, GateEvaluation } from "./gates.js";
import type { PromotionGateConfig } from "./config.js";

/** Structural slice of a pg Pool client/Pool — no pg import in core. */
export interface WriterSql {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface WriteContext {
  readonly candidateId: string;
  readonly domainUuid: string;
  readonly sourceEventId: string;
  readonly assertionKind: AssertionKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly confidence: number;
  readonly evaluation: GateEvaluation;
  readonly config: PromotionGateConfig;
  readonly now: Date;
}

export interface CanonicalWriteResult {
  /** Which store was written; "none" for event-log-only landings. */
  readonly target:
    | "commitments"
    | "decisions"
    | "assumptions"
    | "evidence_claim"
    | "procedures"
    | "none";
  readonly targetId: string | null;
  /** Counterparty entity link, when a commitment counterparty resolved. */
  readonly entityId: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isoOr(value: unknown, fallback: Date): string {
  const s = str(value);
  if (s === null) return fallback.toISOString();
  const parsed = new Date(s);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback.toISOString();
}

/** Evidence metadata shared by every claim-shaped landing (T14 marker). */
function claimMetadata(ctx: WriteContext, cls: ProposedClass): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    candidateId: ctx.candidateId,
    class: cls,
    verified: false,
  };
  const key = str(ctx.payload[ctx.config.gate4Confidence.conflict.payloadKeyField]);
  const value = str(ctx.payload[ctx.config.gate4Confidence.conflict.payloadValueField]);
  if (key !== null) meta.conflictKey = key;
  if (value !== null) meta.value = value;
  if (cls === "assumption" && str(ctx.payload.decisionId) === null) {
    meta.pendingDecisionLink = true;
  }
  return meta;
}

function claimText(ctx: WriteContext, cls: ProposedClass): string {
  const statement = str(ctx.payload.statement);
  if (statement !== null) return statement;
  const key = str(ctx.payload[ctx.config.gate4Confidence.conflict.payloadKeyField]);
  const value = str(ctx.payload[ctx.config.gate4Confidence.conflict.payloadValueField]);
  if (cls === "preference" && key !== null && value !== null) return `${key}: ${value}`;
  const description = str(ctx.payload.description);
  return description ?? "";
}

async function writeClaim(
  tx: WriterSql,
  ctx: WriteContext,
  cls: ProposedClass,
): Promise<CanonicalWriteResult> {
  const result = await tx.query(
    `INSERT INTO evidence (domain_id, source_type, source_ref, claim, observed_at, confidence, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, $6, $7::jsonb)
     RETURNING id`,
    [
      ctx.domainUuid,
      ctx.assertionKind,
      ctx.sourceEventId,
      claimText(ctx, cls),
      ctx.now.toISOString(),
      ctx.confidence,
      JSON.stringify(claimMetadata(ctx, cls)),
    ],
  );
  const evidenceId = String(result.rows[0]!.id);
  await recordConflictEdge(tx, ctx, evidenceId);
  return { target: "evidence_claim", targetId: evidenceId, entityId: null };
}

/** Both records are kept; the conflict is recorded as a relationships edge (§38). */
async function recordConflictEdge(
  tx: WriterSql,
  ctx: WriteContext,
  newRecordId: string,
): Promise<void> {
  const conflict: ConflictInfo | null = ctx.evaluation.conflict;
  if (conflict === null) return;
  await tx.query(
    `INSERT INTO relationships (domain_id, from_type, from_id, relation, to_type, to_id,
                                source_event_id, confidence, metadata)
     VALUES ($1::uuid, 'evidence', $2::uuid, 'conflicts_with', 'evidence', $3::uuid,
             $4::uuid, $5, $6::jsonb)`,
    [
      ctx.domainUuid,
      newRecordId,
      conflict.existingRecordId,
      ctx.sourceEventId,
      ctx.confidence,
      JSON.stringify({
        candidateId: ctx.candidateId,
        key: conflict.key,
        existingValue: conflict.existingValue,
        newValue: conflict.newValue,
      }),
    ],
  );
}

async function writeCommitment(
  tx: WriterSql,
  ctx: WriteContext,
): Promise<CanonicalWriteResult> {
  const counterparty = str(ctx.payload.counterpartyText ?? ctx.payload.counterparty)!;
  // Counterparty resolution: explicit entity id, else an exact (case-insensitive)
  // name match in the candidate's domain. Never auto-created from raw text.
  let entityId: string | null = str(ctx.payload.counterpartyEntityId);
  if (entityId !== null) {
    const check = await tx.query(
      "SELECT id FROM entities WHERE id = $1::uuid AND domain_id = $2::uuid",
      [entityId, ctx.domainUuid],
    );
    if (check.rows.length === 0) {
      throw new Error(`commitment payload.counterpartyEntityId ${entityId} not found in domain`);
    }
  } else {
    const match = await tx.query(
      "SELECT id FROM entities WHERE domain_id = $1::uuid AND lower(name) = lower($2) LIMIT 1",
      [ctx.domainUuid, counterparty],
    );
    entityId = match.rows[0] !== undefined ? String(match.rows[0].id) : null;
  }

  const inserted = await tx.query(
    `INSERT INTO commitments (domain_id, direction, counterparty_text, counterparty_entity_id, link_confidence,
                              description, due_at, confidence, status, source_event_id, may_follow_up)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::timestamptz, $8, 'open', $9::uuid, $10)
     RETURNING id`,
    [
      ctx.domainUuid,
      str(ctx.payload.direction) ?? "i_owe",
      counterparty,
      entityId,
      entityId !== null ? 1 : null,
      str(ctx.payload.description)!,
      str(ctx.payload.dueAt),
      ctx.confidence,
      ctx.sourceEventId,
      ctx.payload.mayFollowUp === true,
    ],
  );
  const commitmentId = String(inserted.rows[0]!.id);

  // The counterparty edge is a first-class relationship when the entity resolves.
  if (entityId !== null) {
    await tx.query(
      `INSERT INTO relationships (domain_id, from_type, from_id, relation, to_type, to_id,
                                  source_event_id, confidence, metadata)
       VALUES ($1::uuid, 'commitment', $2::uuid, 'counterparty', 'entity', $3::uuid,
               $4::uuid, 1, $5::jsonb)`,
      [
        ctx.domainUuid,
        commitmentId,
        entityId,
        ctx.sourceEventId,
        JSON.stringify({ candidateId: ctx.candidateId, via: "text_resolution" }),
      ],
    );
  }
  return { target: "commitments", targetId: commitmentId, entityId };
}

async function writeDecision(
  tx: WriterSql,
  ctx: WriteContext,
): Promise<CanonicalWriteResult> {
  const inserted = await tx.query(
    `INSERT INTO decisions (domain_id, question, chosen, alternatives, reasons, decided_at, source_event_id)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::uuid)
     RETURNING id`,
    [
      ctx.domainUuid,
      str(ctx.payload.question)!,
      str(ctx.payload.chosen)!,
      ctx.payload.alternatives === undefined ? null : JSON.stringify(ctx.payload.alternatives),
      str(ctx.payload.reasons),
      isoOr(ctx.payload.decidedAt, ctx.now),
      ctx.sourceEventId,
    ],
  );
  return { target: "decisions", targetId: String(inserted.rows[0]!.id), entityId: null };
}

async function writeAssumption(
  tx: WriterSql,
  ctx: WriteContext,
): Promise<CanonicalWriteResult> {
  const decisionId = str(ctx.payload.decisionId);
  if (decisionId === null) {
    // The assumptions table requires a decision link (schema v1); a standalone
    // user_declared assumption still canonically lands — as a claim, flagged
    // for a later decision link. Recorded as a limitation, never dropped.
    return writeClaim(tx, ctx, "assumption");
  }
  const inserted = await tx.query(
    `INSERT INTO assumptions (decision_id, statement, status)
     VALUES ($1::uuid, $2, 'held')
     RETURNING id`,
    [decisionId, str(ctx.payload.statement)!],
  );
  return { target: "assumptions", targetId: String(inserted.rows[0]!.id), entityId: null };
}

async function writeProcedureIndex(
  tx: WriterSql,
  ctx: WriteContext,
): Promise<CanonicalWriteResult> {
  const name = str(ctx.payload.name);
  const bodyRef = str(ctx.payload.bodyRef);
  const version = ctx.payload.version;
  if (name === null || bodyRef === null || typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    // Procedural bodies are files in git (A17); without an index triple there
    // is nothing for the kernel to index — the promotion is the record.
    return { target: "none", targetId: null, entityId: null };
  }
  const inserted = await tx.query(
    `INSERT INTO procedures (name, version, body_ref) VALUES ($1, $2, $3) RETURNING id`,
    [name, version, bodyRef],
  );
  return { target: "procedures", targetId: String(inserted.rows[0]!.id), entityId: null };
}

/** Performs the gate-5 canonical write for the evaluated class. Idempotent re-runs are prevented by the caller (status transitions). */
export async function performCanonicalWrite(
  tx: WriterSql,
  ctx: WriteContext,
): Promise<CanonicalWriteResult> {
  if (!ctx.evaluation.canonicalWrite) {
    return { target: "none", targetId: null, entityId: null };
  }
  switch (ctx.evaluation.gatedClass) {
    case "commitment":
      return writeCommitment(tx, ctx);
    case "decision":
      return writeDecision(tx, ctx);
    case "assumption":
      return writeAssumption(tx, ctx);
    case "preference":
    case "semantic":
      return writeClaim(tx, ctx, ctx.evaluation.gatedClass);
    case "procedural":
    case "policy":
      return writeProcedureIndex(tx, ctx);
    default:
      throw new Error(`no canonical writer for class "${ctx.evaluation.gatedClass}"`);
  }
}
