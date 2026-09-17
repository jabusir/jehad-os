// highestLeverageDecision — the §13/§25 leverage query: "what should I
// decide next to unlock the most downstream work?" (review §25's dependency-
// leverage test: Decision A blocks B/C/D, E blocks F → A). Computed
// deterministically from the relationships graph (blocked_by edges) — a pure
// TS breadth-first walk over SQL-fetched edges, never LLM (review §9/§25).
//
// Unresolved-decision rule (schema v1 has no closed column on decisions):
// a decision is a leverage candidate iff its revisit_conditions are empty
// (null / [] / {} — never given closure conditions) OR it still has an
// active blocked_by edge pointing at it whose blocked item is open. A
// decision with non-empty revisit_conditions and zero open downstream items
// is treated as resolved and excluded.

import { itemKey, toIso, type QueryExecutor } from "./executor.js";
import { resolveItems, type ItemInfo, type ItemRef } from "./items.js";
import { fetchActiveBlockedByEdges } from "./blocked.js";

export interface LeverageOptions {
  /** Domain key ("personal"); omit for all domains. */
  readonly domainId?: string;
  readonly now?: () => Date;
  /** Max graph depth for transitive downstream (default 3 — task spec). */
  readonly maxDepth?: number;
  /** Max decisions returned (default 50). */
  readonly limit?: number;
  /** Max items surfaced per decision as topBlockedItems (default 5). */
  readonly topItemsLimit?: number;
}

export interface BlockedItemSummary {
  readonly itemType: string;
  readonly itemId: string;
  readonly label: string;
  readonly depth: number;
}

export interface LeverageDecision {
  readonly decisionId: string;
  readonly question: string;
  readonly chosen: string;
  readonly domainKey: string;
  readonly decidedAt: string;
  readonly directDownstreamCount: number;
  readonly transitiveDownstreamCount: number;
  readonly topBlockedItems: readonly BlockedItemSummary[];
}

const CANDIDATE_DECISIONS_SQL = `
  SELECT d.id, d.question, d.chosen, d.decided_at, dom.key AS domain_key,
         (d.revisit_conditions IS NULL
           OR d.revisit_conditions::text IN ('[]', '{}', 'null')) AS revisit_empty
  FROM decisions d
  JOIN domains dom ON dom.id = d.domain_id
  WHERE ($1::text IS NULL OR dom.key = $1)
    AND (
      d.revisit_conditions IS NULL
      OR d.revisit_conditions::text IN ('[]', '{}', 'null')
      OR EXISTS (
        SELECT 1
        FROM relationships r
        LEFT JOIN commitments c ON r.from_type = 'commitment' AND c.id = r.from_id
        WHERE r.relation = 'blocked_by'
          AND r.to_type = 'decision'
          AND r.to_id = d.id
          AND r.domain_id = d.domain_id
          AND (r.valid_from IS NULL OR r.valid_from <= $2::timestamptz)
          AND (r.valid_until IS NULL OR r.valid_until > $2::timestamptz)
          AND (c.id IS NULL OR c.status = 'open')
      )
    )
  ORDER BY d.decided_at ASC, d.id ASC
`;

interface CandidateRow {
  readonly decisionId: string;
  readonly question: string;
  readonly chosen: string;
  readonly domainKey: string;
  readonly decidedAtMs: number;
  readonly revisitEmpty: boolean;
}

/** An item is open downstream work: commitments must be status='open'; other v1 types carry no status and count as open (schema limitation). */
function isOpenDownstream(item: ItemInfo | undefined): boolean {
  if (item === undefined) return false;
  if (item.type === "commitment") return item.commitmentStatus === "open";
  return true;
}

/**
 * Ranked leverage list: decisions sorted by transitive downstream count desc
 * (ties: direct desc, most recently decided first, then id), each with direct
 * + transitive open-downstream counts (blocked_by edges walked against their
 * direction up to maxDepth) and the top blocked items.
 */
export async function highestLeverageDecision(
  db: QueryExecutor,
  opts: LeverageOptions = {},
): Promise<readonly LeverageDecision[]> {
  const now = opts.now?.() ?? new Date();
  const maxDepth = opts.maxDepth ?? 3;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new RangeError(`maxDepth must be a positive integer, got ${String(maxDepth)}`);
  }
  const limit = opts.limit ?? 50;
  const topItemsLimit = opts.topItemsLimit ?? 5;

  const decisionRows = await db.query(CANDIDATE_DECISIONS_SQL, [
    opts.domainId ?? null,
    now.toISOString(),
  ]);
  if (decisionRows.rows.length === 0) return [];

  const candidates: CandidateRow[] = decisionRows.rows.map((row) => ({
    decisionId: String(row.id),
    question: String(row.question),
    chosen: String(row.chosen),
    domainKey: String(row.domain_key),
    decidedAtMs: new Date(toIso(row.decided_at, "decided_at")).getTime(),
    revisitEmpty: row.revisit_empty === true,
  }));

  const edges = await fetchActiveBlockedByEdges(db, { now, domainId: opts.domainId });
  const refs: ItemRef[] = edges.flatMap((edge) => [edge.from, edge.to]);
  for (const candidate of candidates) {
    refs.push({ type: "decision", id: candidate.decisionId });
  }
  const info = await resolveItems(db, refs);

  // Reverse adjacency: blocker -> items it blocks (decision D unlocks X where
  // X blocked_by D). Cycle-safe via the visited set per walk.
  const blockedByBlocker = new Map<string, ItemRef[]>();
  for (const edge of edges) {
    const key = itemKey(edge.to.type, edge.to.id);
    const list = blockedByBlocker.get(key) ?? [];
    list.push(edge.from);
    blockedByBlocker.set(key, list);
  }

  const results: LeverageDecision[] = [];
  for (const candidate of candidates) {
    const infoOf = (ref: ItemRef): ItemInfo | undefined =>
      info.get(itemKey(ref.type, ref.id));

    // Strict domain containment when filtered: walk only same-domain items.
    const domainOk = (ref: ItemRef): boolean => {
      if (opts.domainId === undefined) return true;
      const item = infoOf(ref);
      if (item === undefined) return false;
      return item.domainKey === opts.domainId;
    };

    // Level-by-level BFS against edge direction (blocker → blocked), cycle-
    // safe via the visited set. Closed intermediates (e.g. a met commitment)
    // are pruned: a resolved item no longer blocks its own downstream.
    const startKey = itemKey("decision", candidate.decisionId);
    const visited = new Set<string>([startKey]);
    let frontier: ItemRef[] = (blockedByBlocker.get(startKey) ?? []).filter(domainOk);
    const found: Array<{ ref: ItemRef; depth: number }> = [];
    let depth = 1;
    while (frontier.length > 0 && depth <= maxDepth) {
      const next: ItemRef[] = [];
      for (const ref of frontier) {
        const key = itemKey(ref.type, ref.id);
        if (visited.has(key)) continue;
        visited.add(key);
        const item = infoOf(ref);
        if (!isOpenDownstream(item)) continue;
        found.push({ ref, depth });
        for (const deeper of blockedByBlocker.get(key) ?? []) {
          if (!visited.has(itemKey(deeper.type, deeper.id))) next.push(deeper);
        }
      }
      frontier = next.filter(domainOk);
      depth += 1;
    }

    const directCount = found.filter((f) => f.depth === 1).length;
    // Resolved per the closure rule: non-empty revisit_conditions and no open
    // downstream items left.
    if (!candidate.revisitEmpty && found.length === 0) continue;

    const top = [...found]
      .sort(
        (a, b) =>
          a.depth - b.depth ||
          (a.ref.type < b.ref.type ? -1 : a.ref.type > b.ref.type ? 1 : 0) ||
          (a.ref.id < b.ref.id ? -1 : 1),
      )
      .slice(0, topItemsLimit)
      .map(({ ref, depth: d }) => ({
        itemType: ref.type,
        itemId: ref.id,
        label: infoOf(ref)?.label ?? ref.id,
        depth: d,
      }));

    results.push({
      decisionId: candidate.decisionId,
      question: candidate.question,
      chosen: candidate.chosen,
      domainKey: candidate.domainKey,
      decidedAt: new Date(candidate.decidedAtMs).toISOString(),
      directDownstreamCount: directCount,
      transitiveDownstreamCount: found.length,
      topBlockedItems: top,
    });
  }

  results.sort(
    (a, b) =>
      b.transitiveDownstreamCount - a.transitiveDownstreamCount ||
      b.directDownstreamCount - a.directDownstreamCount ||
      b.decidedAt.localeCompare(a.decidedAt) ||
      (a.decisionId < b.decisionId ? -1 : 1),
  );
  return results.slice(0, limit);
}
