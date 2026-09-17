// The two directional commitment queries (plan §13: the §40 item-5
// "what am i waiting for / what waits on me" questions over structured state
// only — never LLM). Read-only. Domain filter is by domain KEY ("personal",
// "work", …) matching the envelope convention; commitments.domain_id is the
// direct column (004_commitments_domain; the 001 source-event-join derivation
// it replaces was the M6A flag this column resolves).

import { toIsoOrNull, type QueryExecutor } from "./executor.js";

export interface WaitingOptions {
  /** Domain key ("personal"); omit for all domains. */
  readonly domainId?: string;
  readonly now?: () => Date;
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
  /** due_at in the past while still open. */
  readonly overdue: boolean;
}

export interface WaitsOnMeItem extends CommitmentListItem {
  /** due_at within dueSoonDays from now (and not overdue). */
  readonly dueSoon: boolean;
}

export interface WaitsOnMeOptions extends WaitingOptions {
  /** due-soon window in days (default 3 — plan §7's due/overdue variants). */
  readonly dueSoonDays?: number;
}

const OPEN_BY_DIRECTION_SQL = `
  SELECT c.id, c.direction, c.counterparty_text, c.counterparty_entity_id,
         c.description, c.due_at, c.confidence, c.status, dom.key AS domain_key
  FROM commitments c
  JOIN domains dom ON dom.id = c.domain_id
  WHERE c.status = 'open'
    AND c.direction = $1
    AND ($2::text IS NULL OR dom.key = $2)
  ORDER BY (c.due_at IS NULL) ASC, c.due_at ASC, c.id ASC
`;

const MS_PER_DAY = 86_400_000;

function toListItem(row: Record<string, unknown>, now: Date): CommitmentListItem {
  const dueAt = toIsoOrNull(row.due_at, "due_at");
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
    overdue: dueAt !== null && new Date(dueAt).getTime() < now.getTime(),
  };
}

/**
 * Open commitments where someone owes Jehad (direction=owes_me), each flagged
 * overdue when due_at is in the past. Renegotiated/void/met/missed rows are
 * excluded by the status filter.
 */
export async function whatAmIWaitingFor(
  db: QueryExecutor,
  opts: WaitingOptions = {},
): Promise<readonly CommitmentListItem[]> {
  const now = opts.now?.() ?? new Date();
  const result = await db.query(OPEN_BY_DIRECTION_SQL, ["owes_me", opts.domainId ?? null]);
  return result.rows.map((row) => toListItem(row, now));
}

/**
 * Open commitments Jehad owes (direction=i_owe), each flagged overdue and
 * due-soon (configurable window) so the brief can rank what needs action.
 */
export async function whatWaitsOnMe(
  db: QueryExecutor,
  opts: WaitsOnMeOptions = {},
): Promise<readonly WaitsOnMeItem[]> {
  const now = opts.now?.() ?? new Date();
  const dueSoonDays = opts.dueSoonDays ?? 3;
  if (!Number.isFinite(dueSoonDays) || dueSoonDays < 0) {
    throw new RangeError(`dueSoonDays must be a non-negative number, got ${String(dueSoonDays)}`);
  }
  const soonCutoff = now.getTime() + dueSoonDays * MS_PER_DAY;
  const result = await db.query(OPEN_BY_DIRECTION_SQL, ["i_owe", opts.domainId ?? null]);
  return result.rows.map((row) => {
    const item = toListItem(row, now);
    const dueMs = item.dueAt === null ? null : new Date(item.dueAt).getTime();
    return {
      ...item,
      dueSoon: dueMs !== null && !item.overdue && dueMs <= soonCutoff,
    };
  });
}
