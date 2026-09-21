import { toIso, type QueryExecutor } from "./executor.js";
import { BRIEF_DOMAIN_KEY } from "../briefs/data.js";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";
import type { AssertionKind } from "../memory/candidate-contract.js";

export const MEMORY_RECALL_COVERAGE =
  "reviewed canonical memory only — decisions, commitments, evidence claims, and procedures matched by keyword in the personal domain; conversation history, unreviewed captures, and semantic similarity are not covered";

export const MAX_RECALL_LIMIT = 5;
export const MAX_QUERY_TERMS = 8;
export const CAP_RECALL_SUMMARY_CHARS = 200;
export const CAP_RECALL_LINE_CHARS = 200;

const ASSERTION_KINDS: readonly string[] = [
  "observed",
  "user_declared",
  "externally_sourced",
  "model_inferred",
  "computed",
];

export type MemoryRecallKind = "evidence" | "decision" | "procedure" | "commitment";

export interface MemoryRecallItemBase {
  readonly ref: string;
  readonly summary: string;
  readonly assertionKind: AssertionKind | null;
  readonly sourceAttribution: string | null;
  readonly score: number;
}

export interface EvidenceRecallItem extends MemoryRecallItemBase {
  readonly kind: "evidence";
  readonly occurredAt: string;
}

export interface DecisionRecallItem extends MemoryRecallItemBase {
  readonly kind: "decision";
  readonly decidedAt: string;
}

export interface ProcedureRecallItem extends MemoryRecallItemBase {
  readonly kind: "procedure";
  readonly createdAt: string;
}

export interface CommitmentRecallItem extends MemoryRecallItemBase {
  readonly kind: "commitment";
  readonly capturedAt: string;
  readonly status: string;
}

export type MemoryRecallResult =
  | EvidenceRecallItem
  | DecisionRecallItem
  | ProcedureRecallItem
  | CommitmentRecallItem;

export interface MemoryRecallInput {
  readonly principalId: string;
  readonly queryText: string;
  readonly limit?: number;
  readonly now?: () => Date;
  readonly domainId?: string;
}

const EVIDENCE_SQL = `
  SELECT * FROM (
    SELECT ev.id, ev.claim, ev.source_type, ev.source_ref, ev.observed_at,
           (SELECT count(*)::int FROM unnest($2::text[]) AS t(pat)
              WHERE ev.claim ILIKE pat) AS score
    FROM evidence ev
    JOIN domains dom ON dom.id = ev.domain_id
    WHERE dom.key = $1 AND dom.sensitivity = 'normal'
  ) s
  WHERE s.score > 0
  ORDER BY s.score DESC, s.observed_at DESC, s.id ASC
  LIMIT $3
`;

const DECISION_SQL = `
  SELECT * FROM (
    SELECT d.id, d.question, d.chosen, d.reasons, d.decided_at,
           src.source AS source_label,
           (SELECT count(*)::int FROM unnest($2::text[]) AS t(pat)
              WHERE d.question ILIKE pat OR d.chosen ILIKE pat OR d.reasons ILIKE pat) AS score
    FROM decisions d
    JOIN domains dom ON dom.id = d.domain_id
    LEFT JOIN events src ON src.id = d.source_event_id
    WHERE dom.key = $1 AND dom.sensitivity = 'normal'
  ) s
  WHERE s.score > 0
  ORDER BY s.score DESC, s.decided_at DESC, s.id ASC
  LIMIT $3
`;

const PROCEDURE_SQL = `
  SELECT * FROM (
    SELECT DISTINCT ON (p.name)
           p.id, p.name, p.version, p.body_ref, p.created_at,
           (SELECT count(*)::int FROM unnest($1::text[]) AS t(pat)
              WHERE p.name ILIKE pat) AS score
    FROM procedures p
    ORDER BY p.name, p.version DESC, p.id ASC
  ) s
  WHERE s.score > 0
  ORDER BY s.score DESC, s.created_at DESC, s.id ASC
  LIMIT $2
`;

const COMMITMENT_SQL = `
  SELECT * FROM (
    SELECT c.id, c.description, c.counterparty_text, c.status, c.created_at,
           src.source AS source_label,
           (SELECT count(*)::int FROM unnest($2::text[]) AS t(pat)
              WHERE c.description ILIKE pat OR c.counterparty_text ILIKE pat) AS score
    FROM commitments c
    JOIN domains dom ON dom.id = c.domain_id
    LEFT JOIN events src ON src.id = c.source_event_id
    WHERE dom.key = $1 AND dom.sensitivity = 'normal'
  ) s
  WHERE s.score > 0
  ORDER BY s.score DESC, s.created_at DESC, s.id ASC
  LIMIT $3
`;

function parseLimit(value: number | undefined): number {
  if (value === undefined) return MAX_RECALL_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new RangeError(`limit must be a number >= 1, got ${String(value)}`);
  }
  return Math.min(Math.floor(value), MAX_RECALL_LIMIT);
}

function flattenText(text: string): string {
  return text.replace(/[\r\n]+/g, "\\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

export function splitQueryTerms(queryText: string): readonly string[] {
  if (typeof queryText !== "string") return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of queryText.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length === MAX_QUERY_TERMS) break;
  }
  return terms;
}

function assertionKindOf(sourceType: string): AssertionKind | null {
  return ASSERTION_KINDS.includes(sourceType) ? (sourceType as AssertionKind) : null;
}

function toEvidenceItem(row: Record<string, unknown>): EvidenceRecallItem {
  const sourceType = String(row.source_type);
  return {
    kind: "evidence",
    ref: String(row.id),
    summary: truncate(flattenText(String(row.claim)), CAP_RECALL_SUMMARY_CHARS),
    occurredAt: toIso(row.observed_at, "observed_at"),
    assertionKind: assertionKindOf(sourceType),
    sourceAttribution: `${sourceType}:${String(row.source_ref)}`,
    score: Number(row.score),
  };
}

function toDecisionItem(row: Record<string, unknown>): DecisionRecallItem {
  const summary = `${String(row.question)} → ${String(row.chosen)}`;
  return {
    kind: "decision",
    ref: String(row.id),
    summary: truncate(flattenText(summary), CAP_RECALL_SUMMARY_CHARS),
    decidedAt: toIso(row.decided_at, "decided_at"),
    assertionKind: null,
    sourceAttribution:
      row.source_label === null || row.source_label === undefined
        ? null
        : String(row.source_label),
    score: Number(row.score),
  };
}

function toProcedureItem(row: Record<string, unknown>): ProcedureRecallItem {
  return {
    kind: "procedure",
    ref: String(row.id),
    summary: truncate(flattenText(String(row.name)), CAP_RECALL_SUMMARY_CHARS),
    createdAt: toIso(row.created_at, "created_at"),
    assertionKind: null,
    sourceAttribution: String(row.body_ref),
    score: Number(row.score),
  };
}

function toCommitmentItem(row: Record<string, unknown>): CommitmentRecallItem {
  return {
    kind: "commitment",
    ref: String(row.id),
    summary: truncate(flattenText(String(row.description)), CAP_RECALL_SUMMARY_CHARS),
    capturedAt: toIso(row.created_at, "created_at"),
    status: String(row.status),
    assertionKind: null,
    sourceAttribution:
      row.source_label === null || row.source_label === undefined
        ? null
        : String(row.source_label),
    score: Number(row.score),
  };
}

export function recallItemDate(item: MemoryRecallResult): string {
  if (item.kind === "evidence") return item.occurredAt;
  if (item.kind === "decision") return item.decidedAt;
  if (item.kind === "procedure") return item.createdAt;
  return item.capturedAt;
}

export function rankRecallResults(
  items: readonly MemoryRecallResult[],
  limit: number = MAX_RECALL_LIMIT,
): readonly MemoryRecallResult[] {
  const dated = items.map((item) => {
    const ms = Date.parse(recallItemDate(item));
    return { item, ms: Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY };
  });
  dated.sort(
    (a, b) =>
      b.item.score - a.item.score ||
      b.ms - a.ms ||
      (a.item.ref < b.item.ref ? -1 : a.item.ref > b.item.ref ? 1 : 0),
  );
  return dated.slice(0, limit).map((entry) => entry.item);
}

const KIND_REF_TAG: Record<MemoryRecallKind, string> = {
  evidence: "e",
  decision: "d",
  procedure: "p",
  commitment: "c",
};

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(iso));
}

function isoDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: BRIEF_TIMEZONE,
  }).format(new Date(iso));
}

function recallPhrase(item: MemoryRecallResult): string {
  const date = shortDate(recallItemDate(item));
  if (item.kind === "evidence") return `per evidence observed ${date}`;
  if (item.kind === "decision") return `per your decision on ${date}`;
  if (item.kind === "procedure") return `per your procedure from ${date}`;
  return `per your commitment on ${date}${item.status === "open" ? "" : ` (${item.status})`}`;
}

export function renderMemoryRecallBlock(items: readonly MemoryRecallResult[]): readonly string[] {
  const usedShortRefs = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    const base = `${KIND_REF_TAG[item.kind]}-${isoDay(recallItemDate(item))}`;
    let shortRef = base;
    let n = 2;
    while (usedShortRefs.has(shortRef)) {
      shortRef = `${base}#${n}`;
      n += 1;
    }
    usedShortRefs.add(shortRef);
    const labels = [item.assertionKind, item.sourceAttribution]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(", ");
    const header = `[${item.kind} ${shortRef} | ${recallPhrase(item)}${
      labels.length > 0 ? ` | ${labels}` : ""
    }]`;
    lines.push(
      truncate(`${header} ${flattenText(item.summary)}`, CAP_RECALL_LINE_CHARS),
    );
  }
  return lines;
}

export async function recallMemory(
  db: QueryExecutor,
  input: MemoryRecallInput,
): Promise<readonly MemoryRecallResult[]> {
  if (typeof input.principalId !== "string" || input.principalId.trim().length === 0) {
    throw new TypeError("principalId must be a non-empty string");
  }
  if (typeof input.queryText !== "string") {
    throw new TypeError("queryText must be a string");
  }
  const domainId = input.domainId ?? BRIEF_DOMAIN_KEY;
  if (typeof domainId !== "string" || domainId.trim().length === 0) {
    throw new TypeError("domainId must be a non-empty string");
  }
  const limit = parseLimit(input.limit);
  const terms = splitQueryTerms(input.queryText);
  if (terms.length === 0) return [];
  const patterns = terms.map((term) => `%${term}%`);

  const [evidenceRows, decisionRows, procedureRows, commitmentRows] = await Promise.all([
    db.query(EVIDENCE_SQL, [domainId, patterns, limit]),
    db.query(DECISION_SQL, [domainId, patterns, limit]),
    db.query(PROCEDURE_SQL, [patterns, limit]),
    db.query(COMMITMENT_SQL, [domainId, patterns, limit]),
  ]);

  return rankRecallResults(
    [
      ...evidenceRows.rows.map(toEvidenceItem),
      ...decisionRows.rows.map(toDecisionItem),
      ...procedureRows.rows.map(toProcedureItem),
      ...commitmentRows.rows.map(toCommitmentItem),
    ],
    limit,
  );
}
