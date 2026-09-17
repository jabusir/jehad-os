// Evidence service — minimal provenance ledger primitive (review §20 "accepted,
// minimal"; plan §7; data-model.md §5.8). Decisions, assumptions, and memory
// candidates link evidence rows via `relationships` edges instead of embedding
// provenance in JSON.
//
// Provenance rule: every evidence row carries observed_at + source_ref — no
// floating claims. Evidence rows are immutable: there is deliberately no
// update path (append-only like events); a correction is a new row linked to
// the same target. NO fetching/scraping/research here — source_type='url'
// records a reference, it never retrieves one.

export interface EvidenceExecutor {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export type EvidenceSourceType = "url" | "event" | "document" | "message" | "manual";

export const EVIDENCE_SOURCE_TYPES: readonly EvidenceSourceType[] = [
  "url",
  "event",
  "document",
  "message",
  "manual",
];

export type EvidenceTargetType = "decision" | "assumption" | "memory_candidate";

export type EvidenceRelation = "supported_by" | "derived_from" | "contradicts";

const TARGET_TABLES: Record<EvidenceTargetType, string> = {
  decision: "decisions",
  assumption: "assumptions",
  memory_candidate: "memory_candidates",
};

export class EvidenceNotFoundError extends Error {
  constructor(readonly evidenceId: string) {
    super(`evidence "${evidenceId}" does not exist`);
    this.name = "EvidenceNotFoundError";
  }
}

export class EvidenceTargetNotFoundError extends Error {
  constructor(
    readonly targetType: EvidenceTargetType,
    readonly targetId: string,
  ) {
    super(`${targetType} "${targetId}" does not exist`);
    this.name = "EvidenceTargetNotFoundError";
  }
}

export interface RecordEvidenceInput {
  domainId: string;
  sourceType: EvidenceSourceType;
  sourceRef: string;
  claim: string;
  /** When the claim was observed — required; never defaulted to now(). */
  observedAt: Date | string;
  confidence?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface EvidenceRecord {
  id: string;
  domainId: string;
  sourceType: string;
  sourceRef: string;
  claim: string;
  observedAt: Date;
  confidence: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface LinkEvidenceInput {
  evidenceId: string;
  targetType: EvidenceTargetType;
  targetId: string;
  relation: EvidenceRelation;
}

export interface EvidenceLinkRecord {
  id: string;
  evidenceId: string;
  targetType: EvidenceTargetType;
  targetId: string;
  relation: EvidenceRelation;
}

export interface EvidenceTarget {
  targetType: EvidenceTargetType;
  targetId: string;
}

/** Evidence row plus the relation that links it to the queried target. */
export interface LinkedEvidence extends EvidenceRecord {
  linkId: string;
  relation: EvidenceRelation;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertNonEmpty(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function toTimestamp(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} must be a valid date`);
  }
  return date;
}

function toConfidence(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`confidence must be a finite number between 0 and 1, got ${String(value)}`);
  }
  return value;
}

function assertSourceType(value: EvidenceSourceType): void {
  if (!(EVIDENCE_SOURCE_TYPES as readonly string[]).includes(value)) {
    throw new TypeError(
      `sourceType must be one of ${EVIDENCE_SOURCE_TYPES.join("|")}, got ${String(value)}`,
    );
  }
}

function assertTargetType(value: EvidenceTargetType): void {
  if (!(Object.keys(TARGET_TABLES) as readonly string[]).includes(value)) {
    throw new TypeError(
      `targetType must be one of ${Object.keys(TARGET_TABLES).join("|")}, got ${String(value)}`,
    );
  }
}

function assertRelation(value: EvidenceRelation): void {
  const relations: readonly string[] = ["supported_by", "derived_from", "contradicts"];
  if (!relations.includes(value)) {
    throw new TypeError(`relation must be one of ${relations.join("|")}, got ${String(value)}`);
  }
}

function rowToEvidence(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: String(row.id),
    domainId: String(row.domain_id),
    sourceType: String(row.source_type),
    sourceRef: String(row.source_ref),
    claim: String(row.claim),
    observedAt: new Date(String(row.observed_at)),
    confidence:
      row.confidence === null || row.confidence === undefined
        ? null
        : Number(row.confidence),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(row.created_at)),
  };
}

/**
 * Records one immutable evidence row. observed_at + source_ref are required
 * (provenance rule). An unknown domainId fails the domains FK (23503).
 */
export async function recordEvidence(
  db: EvidenceExecutor,
  input: RecordEvidenceInput,
): Promise<EvidenceRecord> {
  assertNonEmpty(input.domainId, "domainId");
  assertSourceType(input.sourceType);
  assertNonEmpty(input.sourceRef, "sourceRef");
  assertNonEmpty(input.claim, "claim");
  const observedAt = toTimestamp(input.observedAt, "observedAt");
  const confidence = toConfidence(input.confidence ?? null);

  const result = await db.query(
    `INSERT INTO evidence
       (domain_id, source_type, source_ref, claim, observed_at, confidence, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id, domain_id, source_type, source_ref, claim, observed_at,
               confidence, metadata, created_at`,
    [
      input.domainId,
      input.sourceType,
      input.sourceRef,
      input.claim,
      observedAt,
      confidence,
      input.metadata ?? null,
    ],
  );
  return rowToEvidence(result.rows[0]!);
}

/**
 * Links evidence to a decision/assumption/memory_candidate as a relationships
 * edge (from=target, relation, to=evidence — data-model.md §5.8 shapes).
 * relationships.from_id/to_id are polymorphic (no FK), so target existence is
 * enforced here: an unknown target or evidence id throws.
 */
export async function linkEvidence(
  db: EvidenceExecutor,
  input: LinkEvidenceInput,
): Promise<EvidenceLinkRecord> {
  assertNonEmpty(input.evidenceId, "evidenceId");
  assertTargetType(input.targetType);
  assertNonEmpty(input.targetId, "targetId");
  assertRelation(input.relation);

  const evidence = await db.query(`SELECT id, domain_id FROM evidence WHERE id = $1::uuid`, [
    input.evidenceId,
  ]);
  if (evidence.rows.length === 0) {
    throw new EvidenceNotFoundError(input.evidenceId);
  }

  // Writer's contract on the polymorphic edge: the target row must exist.
  const target = await db.query(
    `SELECT 1 FROM ${TARGET_TABLES[input.targetType]} WHERE id = $1::uuid`,
    [input.targetId],
  );
  if (target.rows.length === 0) {
    throw new EvidenceTargetNotFoundError(input.targetType, input.targetId);
  }

  const result = await db.query(
    `INSERT INTO relationships (domain_id, from_type, from_id, relation, to_type, to_id)
     VALUES ($1::uuid, $2, $3::uuid, $4, 'evidence', $5::uuid)
     RETURNING id, from_type, from_id, relation, to_id`,
    [
      String(evidence.rows[0]!.domain_id),
      input.targetType,
      input.targetId,
      input.relation,
      input.evidenceId,
    ],
  );
  const row = result.rows[0]!;
  return {
    id: String(row.id),
    evidenceId: String(row.to_id),
    targetType: String(row.from_type) as EvidenceTargetType,
    targetId: String(row.from_id),
    relation: String(row.relation) as EvidenceRelation,
  };
}

/**
 * Lists evidence linked to a target, each labeled with its relation — a
 * `contradicts` link is returned distinctly from `supported_by`/`derived_from`.
 */
export async function getEvidenceFor(
  db: EvidenceExecutor,
  target: EvidenceTarget,
): Promise<LinkedEvidence[]> {
  assertTargetType(target.targetType);
  assertNonEmpty(target.targetId, "targetId");

  const result = await db.query(
    `SELECT r.id AS link_id, r.relation,
            e.id, e.domain_id, e.source_type, e.source_ref, e.claim,
            e.observed_at, e.confidence, e.metadata, e.created_at
     FROM relationships r
     JOIN evidence e ON e.id = r.to_id
     WHERE r.from_type = $1 AND r.from_id = $2::uuid AND r.to_type = 'evidence'
     ORDER BY e.observed_at DESC, e.id`,
    [target.targetType, target.targetId],
  );
  return result.rows.map((row) => ({
    ...rowToEvidence(row),
    linkId: String(row.link_id),
    relation: String(row.relation) as EvidenceRelation,
  }));
}
