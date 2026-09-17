// Polymorphic item resolution for query result labels. relationships
// from_id/to_id are polymorphic (no FK — data-model.md §5.7), so displaying a
// blocked item or a blocker means resolving the (type, id) pair against the
// right canonical table. Read-only; unknown types/ids degrade to the raw id
// as the label rather than erroring — a query must never lose rows to a
// dangling edge (the writer's contract owns edge integrity).

import { itemKey, type QueryExecutor } from "./executor.js";

export interface ItemRef {
  readonly type: string;
  readonly id: string;
}

export interface ItemInfo {
  readonly type: string;
  readonly id: string;
  /** Human label: commitment description / decision question / entity name / … */
  readonly label: string;
  /** Domain key once resolvable; null for dangling/unknown rows. */
  readonly domainKey: string | null;
  /** commitments.status when the item is a commitment row; null otherwise. */
  readonly commitmentStatus: string | null;
}

// Per-type batch lookups. Commitment domain is the direct
// commitments.domain_id column (004_commitments_domain).
// `base` must alias the primary table as `t` and expose `dom.key AS domain`.
const BATCH_SPECS: Record<string, { base: string; labelExpr: string }> = {
  commitment: {
    base: "FROM commitments t JOIN domains dom ON dom.id = t.domain_id",
    labelExpr: "t.description",
  },
  decision: {
    base: "FROM decisions t JOIN domains dom ON dom.id = t.domain_id",
    labelExpr: "t.question",
  },
  entity: {
    base: "FROM entities t JOIN domains dom ON dom.id = t.domain_id",
    labelExpr: "t.name",
  },
  evidence: {
    base: "FROM evidence t JOIN domains dom ON dom.id = t.domain_id",
    labelExpr: "t.claim",
  },
  assumption: {
    base: "FROM assumptions t JOIN decisions dd ON dd.id = t.decision_id JOIN domains dom ON dom.id = dd.domain_id",
    labelExpr: "t.statement",
  },
  memory_candidate: {
    base: "FROM memory_candidates t JOIN domains dom ON dom.id = t.domain_id",
    labelExpr: "coalesce(t.payload->>'statement', t.payload->>'description', t.id::text)",
  },
};

/** Resolves labels/domains for a batch of polymorphic refs, keyed `${type}\u0000${id}`. */
export async function resolveItems(
  db: QueryExecutor,
  refs: readonly ItemRef[],
): Promise<Map<string, ItemInfo>> {
  const resolved = new Map<string, ItemInfo>();
  const byType = new Map<string, Set<string>>();
  for (const ref of refs) {
    const spec = BATCH_SPECS[ref.type];
    if (spec === undefined) {
      resolved.set(itemKey(ref.type, ref.id), {
        type: ref.type,
        id: ref.id,
        label: ref.id,
        domainKey: null,
        commitmentStatus: null,
      });
      continue;
    }
    const ids = byType.get(ref.type) ?? new Set<string>();
    ids.add(ref.id);
    byType.set(ref.type, ids);
  }
  for (const [type, ids] of byType) {
    const spec = BATCH_SPECS[type]!;
    const statusExpr = type === "commitment" ? "t.status" : "NULL::text";
    const result = await db.query(
      `SELECT t.id AS item_id, ${spec.labelExpr} AS label,
              ${statusExpr} AS commitment_status, dom.key AS domain_key
       ${spec.base}
       WHERE t.id = ANY($1::uuid[])`,
      [[...ids]],
    );
    for (const row of result.rows) {
      resolved.set(itemKey(type, String(row.item_id)), {
        type,
        id: String(row.item_id),
        label:
          row.label === null || row.label === undefined
            ? String(row.item_id)
            : String(row.label),
        domainKey:
          row.domain_key === null || row.domain_key === undefined
            ? null
            : String(row.domain_key),
        commitmentStatus:
          row.commitment_status === null || row.commitment_status === undefined
            ? null
            : String(row.commitment_status),
      });
    }
  }
  return resolved;
}
