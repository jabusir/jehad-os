// The two directional commitment queries (plan §13: the §40 item-5
// "what am i waiting for / what waits on me" questions over structured state
// only — never LLM). Read-only. Domain filter is by domain KEY ("personal",
// "work", …) matching the envelope convention; commitments.domain_id is the
// direct column (004_commitments_domain; the 001 source-event-join derivation
// it replaces was the M6A flag this column resolves).
//
// Date-trust gating (owner directive 2026-09-17): an item's overdue flag may
// only fire when its due_at is trustworthy — commitments.temporal
// (TemporalProvenance, W6A) must be resolved AND either calendar-native or
// resolved with resolutionConfidence >= trustThreshold (default 0.9).
// Ambiguous/unsupported/malformed temporal, and legacy rows without a
// temporal block (or on schemas before the column lands), NEVER auto-flag
// overdue; a past-due-but-untrusted due date surfaces as
// needsReview: "ambiguous_due_date" so review/briefs can show it without
// asserting overdue.

import { toIsoOrNull, type QueryExecutor } from "./executor.js";
import { AMBIGUOUS_DUE_DATE, assessDueDateTrust, DEFAULT_DATE_TRUST_THRESHOLD } from "../trust/index.js";

export interface WaitingOptions {
  /** Domain key ("personal"); omit for all domains. */
  readonly domainId?: string;
  readonly now?: () => Date;
  /**
   * Minimum normalizer resolutionConfidence for a non-calendar-native
   * resolved date to drive overdue (default 0.9 — owner directive
   * 2026-09-17).
   */
  readonly trustThreshold?: number;
}

export interface CommitmentListItem {
  readonly id: string;
  readonly direction: "owes_me" | "i_owe";
  readonly counterpartyText: string;
  readonly counterpartyEntityId: string | null;
  readonly description: string;
  readonly dueAt: string | null;
  readonly confidence: number;
  readonly status: string;
  readonly domainKey: string;
  /** due_at in the past while still open, AND date-trustworthy. */
  readonly overdue: boolean;
  /**
   * Past due but the due date is not trustworthy (ambiguous/unsupported/
   * legacy): never auto-overdue — surfaced for review instead. Optional for
   * backward compatibility with older item constructors.
   */
  readonly needsReview?: typeof AMBIGUOUS_DUE_DATE | null;
}

export interface WaitsOnMeItem extends CommitmentListItem {
  /** due_at within dueSoonDays from now (and not past due). */
  readonly dueSoon: boolean;
}

export interface WaitsOnMeOptions extends WaitingOptions {
  /** due-soon window in days (default 3 — plan §7's due/overdue variants). */
  readonly dueSoonDays?: number;
}

const OPEN_COLUMNS = `
  SELECT c.id, c.direction, c.counterparty_text, c.counterparty_entity_id,
         c.description, c.due_at, c.confidence, c.status, dom.key AS domain_key
`;

const OPEN_BY_DIRECTION_SQL = `
  FROM commitments c
  JOIN domains dom ON dom.id = c.domain_id
  WHERE c.status = 'open'
    AND c.direction = $1
    AND ($2::text IS NULL OR dom.key = $2)
  ORDER BY (c.due_at IS NULL) ASC, c.due_at ASC, c.id ASC
`;

// W6A's commitments.temporal column may not be migrated yet — detect it and
// degrade gracefully (absent column ⇒ every row is legacy ⇒ strictest rule).
const TEMPORAL_COLUMN_SQL = `
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'commitments'
    AND column_name = 'temporal'
`

const MS_PER_DAY = 86_400_000;

function parseTrustThreshold(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DATE_TRUST_THRESHOLD;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`trustThreshold must be a number in [0, 1], got ${String(value)}`);
  }
  return value;
}

async function commitmentsTemporalColumnExists(db: QueryExecutor): Promise<boolean> {
  const result = await db.query(TEMPORAL_COLUMN_SQL, []);
  return result.rows.length > 0;
}

function toListItem(
  row: Record<string, unknown>,
  now: Date,
  trustThreshold: number,
): CommitmentListItem {
  const dueAt = toIsoOrNull(row.due_at, "due_at");
  const pastDue = dueAt !== null && new Date(dueAt).getTime() < now.getTime();
  const trust = assessDueDateTrust(row.temporal, trustThreshold);
  return {
    id: String(row.id),
    direction: String(row.direction) as "owes_me" | "i_owe",
    counterpartyText: String(row.counterparty_text),
    counterpartyEntityId:
      row.counterparty_entity_id === null || row.counterparty_entity_id === undefined
        ? null
        : String(row.counterparty_entity_id),
    description: String(row.description),
    dueAt,
    confidence: Number(row.confidence),
    status: String(row.status),
    domainKey: String(row.domain_key),
    overdue: pastDue && trust.trusted,
    needsReview: pastDue && !trust.trusted ? AMBIGUOUS_DUE_DATE : null,
  };
}

/**
 * Open commitments where someone owes Jehad (direction=owes_me), each flagged
 * overdue when due_at is in the past AND date-trustworthy (calendar-native or
 * high-confidence normalized). Renegotiated/void/met/missed rows are excluded
 * by the status filter; past-due-but-untrusted dates surface
 * needsReview instead of overdue.
 */
export async function whatAmIWaitingFor(
  db: QueryExecutor,
  opts: WaitingOptions = {},
): Promise<readonly CommitmentListItem[]> {
  const now = opts.now?.() ?? new Date();
  const trustThreshold = parseTrustThreshold(opts.trustThreshold);
  const hasTemporal = await commitmentsTemporalColumnExists(db);
  const sql = hasTemporal
    ? `${OPEN_COLUMNS}, c.temporal${OPEN_BY_DIRECTION_SQL}`
    : `${OPEN_COLUMNS}${OPEN_BY_DIRECTION_SQL}`;
  const result = await db.query(sql, ["owes_me", opts.domainId ?? null]);
  return result.rows.map((row) => toListItem(row, now, trustThreshold));
}

/**
 * Open commitments Jehad owes (direction=i_owe), each flagged overdue and
 * due-soon (configurable window) so the brief can rank what needs action.
 * Overdue obeys the same date-trust gating as whatAmIWaitingFor.
 */
export async function whatWaitsOnMe(
  db: QueryExecutor,
  opts: WaitsOnMeOptions = {},
): Promise<readonly WaitsOnMeItem[]> {
  const now = opts.now?.() ?? new Date();
  const trustThreshold = parseTrustThreshold(opts.trustThreshold);
  const dueSoonDays = opts.dueSoonDays ?? 3;
  if (!Number.isFinite(dueSoonDays) || dueSoonDays < 0) {
    throw new RangeError(`dueSoonDays must be a non-negative number, got ${String(dueSoonDays)}`);
  }
  const soonCutoff = now.getTime() + dueSoonDays * MS_PER_DAY;
  const hasTemporal = await commitmentsTemporalColumnExists(db);
  const sql = hasTemporal
    ? `${OPEN_COLUMNS}, c.temporal${OPEN_BY_DIRECTION_SQL}`
    : `${OPEN_COLUMNS}${OPEN_BY_DIRECTION_SQL}`;
  const result = await db.query(sql, ["i_owe", opts.domainId ?? null]);
  return result.rows.map((row) => {
    const item = toListItem(row, now, trustThreshold);
    const dueMs = item.dueAt === null ? null : new Date(item.dueAt).getTime();
    // pastDue (not merely `overdue`): an untrusted past-due date must not
    // silently reappear as "due soon".
    const pastDue = dueMs !== null && dueMs < now.getTime();
    return {
      ...item,
      dueSoon: dueMs !== null && !pastDue && dueMs <= soonCutoff,
    };
  });
}
