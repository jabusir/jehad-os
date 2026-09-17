/**
 * LocalBackend — the DomainBackend for `storage_mode=local` domains
 * (ADR-0010; docs/domain-boundaries.md §2.1). Reads local tables with
 * `domain_id` enforced on every read path (plan §10) — isolation is in the
 * SQL, not in model discipline.
 *
 * `SqlExecutor` is the structural slice of a pg Pool the backend needs; core
 * takes no direct dependency on pg.
 */

import type { ContextPacket, ContextRequest, DomainAccessContext, DomainBackend, DomainCapability, DomainHealth, DomainQuery, DomainQueryResult } from "@jehad/adapters";

/** Structural slice of a pg Pool (or test double) — no pg import in core. */
export interface SqlExecutor {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

const RECENT_EVENTS_SELECT = `
  SELECT id, type, source, occurred_at, sensitivity
  FROM events
  WHERE domain_id = $1
  ORDER BY occurred_at DESC
  LIMIT $2
`;

export interface LocalEventRow {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly occurred_at: string;
  readonly sensitivity: string;
}

/** Reads local tables for exactly one domain. */
export class LocalBackend implements DomainBackend {
  readonly id: string;
  readonly mode = "local" as const;
  readonly #domainKey: string;
  readonly #sql: SqlExecutor;
  #domainIdPromise: Promise<string> | undefined;

  constructor(domainKey: string, sql: SqlExecutor) {
    this.id = `local:${domainKey}`;
    this.#domainKey = domainKey;
    this.#sql = sql;
  }

  /** Resolves (and caches) the domain's uuid from the domains table. */
  #domainId(): Promise<string> {
    this.#domainIdPromise ??= (async () => {
      const result = await this.#sql.query("SELECT id FROM domains WHERE key = $1", [this.#domainKey]);
      const row = (result.rows as readonly { id: unknown }[])[0];
      if (row === undefined || typeof row.id !== "string") {
        throw new Error(`LocalBackend: domain key "${this.#domainKey}" not found in domains table`);
      }
      return row.id;
    })();
    return this.#domainIdPromise;
  }

  /**
   * Supported kinds: `events.count` → [{count}] and `events.recent`
   * (params: {limit?}) → recent envelope projections. Every path filters by
   * this backend's domain_id. Unknown kinds throw — never guess.
   */
  async query(request: DomainQuery, _ctx: DomainAccessContext): Promise<DomainQueryResult> {
    void _ctx;
    const domainId = await this.#domainId();
    if (request.kind === "events.count") {
      const result = await this.#sql.query("SELECT count(*)::int AS count FROM events WHERE domain_id = $1", [domainId]);
      const row = (result.rows as readonly { count: unknown }[])[0];
      return { rows: [{ count: typeof row?.count === "number" ? row.count : 0 }] };
    }
    if (request.kind === "events.recent") {
      const limit = numberParam(request.params?.limit, 10);
      const result = await this.#sql.query(RECENT_EVENTS_SELECT, [domainId, limit]);
      return { rows: result.rows as readonly LocalEventRow[] };
    }
    throw new Error(`LocalBackend: unsupported query kind "${request.kind}"`);
  }

  /** Recent events for this domain only; watermark = newest occurred_at. */
  async context(request: ContextRequest, ctx: DomainAccessContext): Promise<ContextPacket> {
    void request;
    const rows = (await this.query({ kind: "events.recent", params: { limit: 10 } }, ctx)).rows as readonly LocalEventRow[];
    // rows are ORDER BY occurred_at DESC — the first is the high-water mark
    const watermark = rows.length > 0 ? new Date(rows[0]!.occurred_at).toISOString() : undefined;
    return { watermark, items: rows };
  }

  async capabilities(): Promise<DomainCapability[]> {
    return [
      { name: "events.count", available: true },
      { name: "events.recent", available: true },
      { name: "context", available: true },
    ];
  }

  async health(): Promise<DomainHealth> {
    try {
      await this.#sql.query("SELECT 1");
      return { status: "healthy" };
    } catch {
      return { status: "unavailable" };
    }
  }
}

function numberParam(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error(`LocalBackend: invalid limit param ${JSON.stringify(value)}`);
  }
  return value;
}
