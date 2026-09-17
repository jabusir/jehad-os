// whatChanged — the delta-oriented §40 item-5 question (plan §13: the morning
// brief / evening close render deltas, never full dumps). Returns events plus
// canonical writes (commitments/decisions/relationships rows) touched since a
// timestamp, grouped by event type. Read-only.
//
// Delta semantics: an event is "new since" when the newer of occurred_at /
// recorded_at exceeds `since` — a backdated import learned now (recorded_at)
// and a forward-dated occurrence both surface; canonical rows use updated_at
// (updated_at = created_at on INSERT, so new rows are deltas too).

import { parseDateInput, toIso, type QueryExecutor } from "./executor.js";

export interface WhatChangedOptions {
  /** Exclusive lower bound for the delta. */
  readonly since: Date | string;
  /** Domain key ("personal"); omit for all domains. */
  readonly domainId?: string;
  /** Per-group row cap (default 200). */
  readonly limit?: number;
}

export interface ChangedEvent {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly sensitivity: string;
  readonly domainKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ChangedEventGroup {
  readonly type: string;
  readonly count: number;
  readonly events: readonly ChangedEvent[];
}

export interface ChangedCommitment {
  readonly id: string;
  readonly description: string;
  readonly direction: string;
  readonly status: string;
  readonly dueAt: string | null;
  readonly domainKey: string;
  readonly updatedAt: string;
}

export interface ChangedDecision {
  readonly id: string;
  readonly question: string;
  readonly chosen: string;
  readonly domainKey: string;
  readonly decidedAt: string;
  readonly updatedAt: string;
}

export interface ChangedRelationship {
  readonly id: string;
  readonly fromType: string;
  readonly fromId: string;
  readonly relation: string;
  readonly toType: string;
  readonly toId: string;
  readonly domainKey: string;
  readonly updatedAt: string;
}

export interface WhatChangedResult {
  readonly since: string;
  readonly eventGroups: readonly ChangedEventGroup[];
  readonly commitments: readonly ChangedCommitment[];
  readonly decisions: readonly ChangedDecision[];
  readonly relationships: readonly ChangedRelationship[];
}

const EVENTS_SQL = `
  SELECT ev.id, ev.type, ev.source, ev.occurred_at, ev.recorded_at,
         ev.sensitivity, ev.payload, dom.key AS domain_key
  FROM events ev
  JOIN domains dom ON dom.id = ev.domain_id
  WHERE GREATEST(ev.occurred_at, ev.recorded_at) > $1::timestamptz
    AND ($2::text IS NULL OR dom.key = $2)
  ORDER BY GREATEST(ev.occurred_at, ev.recorded_at) ASC, ev.id ASC
  LIMIT $3
`;

const COMMITMENTS_SQL = `
  SELECT c.id, c.description, c.direction, c.status, c.due_at, c.updated_at,
         dom.key AS domain_key
  FROM commitments c
  JOIN events src ON src.id = c.source_event_id
  JOIN domains dom ON dom.id = src.domain_id
  WHERE c.updated_at > $1::timestamptz
    AND ($2::text IS NULL OR dom.key = $2)
  ORDER BY c.updated_at ASC, c.id ASC
  LIMIT $3
`;

const DECISIONS_SQL = `
  SELECT d.id, d.question, d.chosen, d.decided_at, d.updated_at,
         dom.key AS domain_key
  FROM decisions d
  JOIN domains dom ON dom.id = d.domain_id
  WHERE d.updated_at > $1::timestamptz
    AND ($2::text IS NULL OR dom.key = $2)
  ORDER BY d.updated_at ASC, d.id ASC
  LIMIT $3
`;

const RELATIONSHIPS_SQL = `
  SELECT r.id, r.from_type, r.from_id, r.relation, r.to_type, r.to_id,
         r.updated_at, dom.key AS domain_key
  FROM relationships r
  JOIN domains dom ON dom.id = r.domain_id
  WHERE r.updated_at > $1::timestamptz
    AND ($2::text IS NULL OR dom.key = $2)
  ORDER BY r.updated_at ASC, r.id ASC
  LIMIT $3
`;

/**
 * Events + canonical writes since a timestamp, events grouped by type
 * (groups ordered by count desc then name; events in occurrence order).
 */
export async function whatChanged(
  db: QueryExecutor,
  opts: WhatChangedOptions,
): Promise<WhatChangedResult> {
  const since = parseDateInput(opts.since, "since");
  const limit = opts.limit ?? 200;
  const params = [since.toISOString(), opts.domainId ?? null, limit];

  const [events, commitments, decisions, relationships] = await Promise.all([
    db.query(EVENTS_SQL, params),
    db.query(COMMITMENTS_SQL, params),
    db.query(DECISIONS_SQL, params),
    db.query(RELATIONSHIPS_SQL, params),
  ]);

  const byType = new Map<string, ChangedEvent[]>();
  for (const row of events.rows) {
    const type = String(row.type);
    const changed: ChangedEvent = {
      id: String(row.id),
      type,
      source: String(row.source),
      occurredAt: toIso(row.occurred_at, "occurred_at"),
      recordedAt: toIso(row.recorded_at, "recorded_at"),
      sensitivity: String(row.sensitivity),
      domainKey: String(row.domain_key),
      payload: (row.payload ?? {}) as Record<string, unknown>,
    };
    const group = byType.get(type);
    if (group === undefined) {
      byType.set(type, [changed]);
    } else {
      group.push(changed);
    }
  }
  const eventGroups: ChangedEventGroup[] = [...byType.entries()]
    .map(([type, group]) => ({ type, count: group.length, events: group }))
    .sort((a, b) => (b.count - a.count) || (a.type < b.type ? -1 : 1));

  return {
    since: since.toISOString(),
    eventGroups,
    commitments: commitments.rows.map((row) => ({
      id: String(row.id),
      description: String(row.description),
      direction: String(row.direction),
      status: String(row.status),
      dueAt: row.due_at === null || row.due_at === undefined ? null : toIso(row.due_at, "due_at"),
      domainKey: String(row.domain_key),
      updatedAt: toIso(row.updated_at, "updated_at"),
    })),
    decisions: decisions.rows.map((row) => ({
      id: String(row.id),
      question: String(row.question),
      chosen: String(row.chosen),
      domainKey: String(row.domain_key),
      decidedAt: toIso(row.decided_at, "decided_at"),
      updatedAt: toIso(row.updated_at, "updated_at"),
    })),
    relationships: relationships.rows.map((row) => ({
      id: String(row.id),
      fromType: String(row.from_type),
      fromId: String(row.from_id),
      relation: String(row.relation),
      toType: String(row.to_type),
      toId: String(row.to_id),
      domainKey: String(row.domain_key),
      updatedAt: toIso(row.updated_at, "updated_at"),
    })),
  };
}
