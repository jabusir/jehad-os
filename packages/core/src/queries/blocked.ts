// whatIsBlocked — the §40 item-5 "what is blocked" question with §7's
// variants (plan §13). Two read-only parts:
//
//  1. explicit blocking: items with an ACTIVE relationships edge
//     (relation='blocked_by', valid_from/valid_until window containing now),
//     each carrying resolved blocker info and a cycle flag.
//  2. derived "silently stalled" (review §17 — derived state, NEVER a stored
//     status): open commitments and project entities with no meaningful
//     progress for N days, where "meaningful progress" = any event whose
//     payload references the item OR the row's updated_at, and items with an
//     active blocked_by edge are excluded (blocked ≠ stalled). Stored status
//     is never touched.
//
// Cycle note: cycles in the blocked_by graph (A blocked_by B, B blocked_by A)
// are reported per-item (cycle: true) — the walk terminates via a visited set,
// so no infinite loop.

import { itemKey, toIso, type QueryExecutor } from "./executor.js";
import { resolveItems, type ItemInfo, type ItemRef } from "./items.js";

export interface StalledThresholds {
  /** Default for types without an override (default 7 — review §17 "N days"). */
  readonly defaultDays?: number;
  /** Per-type override, e.g. { commitment: 5, project: 30 }. */
  readonly byType?: Readonly<Record<string, number>>;
}

export interface WhatIsBlockedOptions {
  /** Domain key ("personal"); omit for all domains. */
  readonly domainId?: string;
  readonly now?: () => Date;
  readonly stalled?: StalledThresholds;
}

export interface BlockedItem {
  readonly itemType: string;
  readonly itemId: string;
  readonly itemLabel: string;
  readonly domainKey: string | null;
  readonly blockerType: string;
  readonly blockerId: string;
  readonly blockerLabel: string;
  /** True when the item participates in a blocked_by cycle. */
  readonly cycle: boolean;
  readonly edgeId: string;
}

export interface StalledItem {
  readonly itemType: "commitment" | "project";
  readonly itemId: string;
  readonly itemLabel: string;
  readonly domainKey: string;
  readonly lastProgressAt: string;
  readonly stalledForDays: number;
  readonly thresholdDays: number;
}

export interface WhatIsBlockedResult {
  readonly blocked: readonly BlockedItem[];
  readonly stalled: readonly StalledItem[];
}

export interface BlockedByEdge {
  readonly edgeId: string;
  readonly from: ItemRef;
  readonly to: ItemRef;
  readonly domainKey: string;
}

const MS_PER_DAY = 86_400_000;

const ACTIVE_EDGES_SQL = `
  SELECT r.id AS edge_id, r.from_type, r.from_id, r.to_type, r.to_id,
         dom.key AS domain_key
  FROM relationships r
  JOIN domains dom ON dom.id = r.domain_id
  WHERE r.relation = 'blocked_by'
    AND (r.valid_from IS NULL OR r.valid_from <= $1::timestamptz)
    AND (r.valid_until IS NULL OR r.valid_until > $1::timestamptz)
    AND ($2::text IS NULL OR dom.key = $2)
  ORDER BY r.created_at ASC, r.id ASC
`;

/** Active (validity-window-passing) blocked_by edges in scope (domain filter on the edge). */
export async function fetchActiveBlockedByEdges(
  db: QueryExecutor,
  opts: { now: Date; domainId?: string },
): Promise<readonly BlockedByEdge[]> {
  const result = await db.query(ACTIVE_EDGES_SQL, [opts.now.toISOString(), opts.domainId ?? null]);
  return result.rows.map((row) => ({
    edgeId: String(row.edge_id),
    from: { type: String(row.from_type), id: String(row.from_id) },
    to: { type: String(row.to_type), id: String(row.to_id) },
    domainKey: String(row.domain_key),
  }));
}

/**
 * True when following blockers transitively from `start` returns to `start`
 * (A blocked_by B, B blocked_by A). Visited-set bounded — never loops.
 */
function participatesInCycle(
  start: ItemRef,
  blockersOf: Map<string, readonly ItemRef[]>,
): boolean {
  const startKey = itemKey(start.type, start.id);
  const seen = new Set<string>();
  const stack = [...(blockersOf.get(startKey) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const key = itemKey(current.type, current.id);
    if (key === startKey) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of blockersOf.get(key) ?? []) {
      stack.push(next);
    }
  }
  return false;
}

// Stalled candidates: open commitments + project entities. "Meaningful
// progress" per candidate = latest same-domain event whose payload references
// the item id as a quoted JSON string value (uuids are fixed-length, so a
// quoted full-uuid match cannot false-positive), or the row's updated_at —
// whichever is newer. (Note: jsonb `@>` scalar containment does NOT match
// object values in Postgres — only array members — hence the text match.)
const STALLED_COMMITMENTS_SQL = `
  SELECT c.id, c.description AS label, c.updated_at, dom.key AS domain_key,
         (SELECT MAX(GREATEST(ev.occurred_at, ev.recorded_at))
          FROM events ev
          WHERE ev.domain_id = src.domain_id
            AND ev.payload::text LIKE concat('%"', c.id::text, '"%')) AS last_event_at
  FROM commitments c
  JOIN events src ON src.id = c.source_event_id
  JOIN domains dom ON dom.id = src.domain_id
  WHERE c.status = 'open'
    AND ($1::text IS NULL OR dom.key = $1)
`;

const STALLED_PROJECTS_SQL = `
  SELECT e.id, e.name AS label, e.updated_at, dom.key AS domain_key,
         (SELECT MAX(GREATEST(ev.occurred_at, ev.recorded_at))
          FROM events ev
          WHERE ev.domain_id = e.domain_id
            AND ev.payload::text LIKE concat('%"', e.id::text, '"%')) AS last_event_at
  FROM entities e
  JOIN domains dom ON dom.id = e.domain_id
  WHERE e.discriminator = 'project'
    AND ($1::text IS NULL OR dom.key = $1)
`;

interface StalledCandidate {
  readonly itemType: "commitment" | "project";
  readonly itemId: string;
  readonly label: string;
  readonly domainKey: string;
  readonly updatedAtMs: number;
  readonly lastEventMs: number | null;
}

function toCandidate(
  row: Record<string, unknown>,
  itemType: "commitment" | "project",
): StalledCandidate {
  return {
    itemType,
    itemId: String(row.id),
    label: String(row.label),
    domainKey: String(row.domain_key),
    updatedAtMs: new Date(toIso(row.updated_at, "updated_at")).getTime(),
    lastEventMs:
      row.last_event_at === null || row.last_event_at === undefined
        ? null
        : new Date(toIso(row.last_event_at, "last_event_at")).getTime(),
  };
}

export async function whatIsBlocked(
  db: QueryExecutor,
  opts: WhatIsBlockedOptions = {},
): Promise<WhatIsBlockedResult> {
  const now = opts.now?.() ?? new Date();
  const defaultDays = opts.stalled?.defaultDays ?? 7;
  const byType = opts.stalled?.byType ?? {};

  const edges = await fetchActiveBlockedByEdges(db, { now, domainId: opts.domainId });
  const refs: ItemRef[] = edges.flatMap((edge) => [edge.from, edge.to]);
  const info = await resolveItems(db, refs);

  // Strict domain containment: when a domain filter is set, the item AND the
  // blocker must belong to that domain (not just the edge) — no cross-domain
  // leakage either way.
  const inDomain = (item: ItemInfo | undefined): boolean => {
    if (opts.domainId === undefined) return true;
    return item?.domainKey === opts.domainId;
  };

  const blockersOf = new Map<string, ItemRef[]>();
  for (const edge of edges) {
    const key = itemKey(edge.from.type, edge.from.id);
    const list = blockersOf.get(key) ?? [];
    list.push(edge.to);
    blockersOf.set(key, list);
  }

  const blocked: BlockedItem[] = [];
  for (const edge of edges) {
    const item = info.get(itemKey(edge.from.type, edge.from.id));
    const blocker = info.get(itemKey(edge.to.type, edge.to.id));
    if (!inDomain(item) || !inDomain(blocker)) continue;
    blocked.push({
      itemType: edge.from.type,
      itemId: edge.from.id,
      itemLabel: item?.label ?? edge.from.id,
      domainKey: item?.domainKey ?? null,
      blockerType: edge.to.type,
      blockerId: edge.to.id,
      blockerLabel: blocker?.label ?? edge.to.id,
      cycle: participatesInCycle(edge.from, blockersOf),
      edgeId: edge.edgeId,
    });
  }
  blocked.sort(
    (a, b) =>
      Number(b.cycle) - Number(a.cycle) ||
      (a.itemType < b.itemType ? -1 : a.itemType > b.itemType ? 1 : 0) ||
      (a.itemId < b.itemId ? -1 : 1),
  );

  // Explicitly blocked (active edge, from-side) items are excluded from the
  // stalled derivation — blocked, not silently stalled.
  const blockedItemKeys = new Set(edges.map((e) => itemKey(e.from.type, e.from.id)));

  const domainParam = opts.domainId ?? null;
  const [commitmentRows, projectRows] = await Promise.all([
    db.query(STALLED_COMMITMENTS_SQL, [domainParam]),
    db.query(STALLED_PROJECTS_SQL, [domainParam]),
  ]);

  const stalled: StalledItem[] = [];
  const candidates: StalledCandidate[] = [
    ...commitmentRows.rows.map((row) => toCandidate(row, "commitment")),
    ...projectRows.rows.map((row) => toCandidate(row, "project")),
  ];
  for (const candidate of candidates) {
    const key = itemKey(candidate.itemType, candidate.itemId);
    if (blockedItemKeys.has(key)) continue;
    const thresholdDays = byType[candidate.itemType] ?? defaultDays;
    const lastMs = Math.max(
      candidate.updatedAtMs,
      candidate.lastEventMs ?? candidate.updatedAtMs,
    );
    const elapsedMs = now.getTime() - lastMs;
    if (elapsedMs <= thresholdDays * MS_PER_DAY) continue;
    stalled.push({
      itemType: candidate.itemType,
      itemId: candidate.itemId,
      itemLabel: candidate.label,
      domainKey: candidate.domainKey,
      lastProgressAt: new Date(lastMs).toISOString(),
      stalledForDays: Math.round((elapsedMs / MS_PER_DAY) * 100) / 100,
      thresholdDays,
    });
  }
  stalled.sort(
    (a, b) =>
      b.stalledForDays - a.stalledForDays ||
      (a.itemType < b.itemType ? -1 : a.itemType > b.itemType ? 1 : 0) ||
      (a.itemId < b.itemId ? -1 : 1),
  );

  return { blocked, stalled };
}
