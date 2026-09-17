/**
 * DomainBackend registry (ADR-0010; docs/domain-boundaries.md §3).
 *
 * Resolves the backend for a domain key. Local domains resolve to a
 * LocalBackend that reads local tables (with `domain_id` enforced on every
 * read path — plan §10); non-local domains resolve only through backends
 * explicitly registered for them — a non-local domain without a backend is
 * unresolvable, i.e. denied by default.
 */

import type { DomainBackend } from "@jehad/adapters";
import { LocalBackend, type SqlExecutor } from "./local-backend.js";

/** Thrown when resolving a domain with no registered backend. Fail closed. */
export class UnknownDomainError extends Error {
  readonly domainKey: string;
  constructor(domainKey: string) {
    super(`no DomainBackend registered for domain "${domainKey}"`);
    this.name = "UnknownDomainError";
    this.domainKey = domainKey;
  }
}

export class DomainBackendRegistry {
  readonly #backends = new Map<string, DomainBackend>();

  /** Registers a backend for a domain key. Duplicate keys are an error. */
  register(domainKey: string, backend: DomainBackend): this {
    if (this.#backends.has(domainKey)) throw new Error(`DomainBackend already registered for "${domainKey}"`);
    this.#backends.set(domainKey, backend);
    return this;
  }

  has(domainKey: string): boolean {
    return this.#backends.has(domainKey);
  }

  /** Resolves the backend for a domain key; throws if none (deny by default). */
  resolve(domainKey: string): DomainBackend {
    const backend = this.#backends.get(domainKey);
    if (backend === undefined) throw new UnknownDomainError(domainKey);
    return backend;
  }

  keys(): readonly string[] {
    return [...this.#backends.keys()];
  }
}

const STORAGE_MODES = new Set(["local", "remote", "federated", "opaque"]);

/**
 * Builds a registry from the `domains` table: every `storage_mode=local`
 * domain gets a LocalBackend over `sql`; non-local domains resolve only if a
 * backend is supplied in `backends` (fake adapters in Phase 1 — A16). A
 * non-local domain without a backend stays unresolvable on purpose.
 */
export async function loadDomainBackendRegistry(
  sql: SqlExecutor,
  opts: { backends?: Readonly<Record<string, DomainBackend>> } = {},
): Promise<DomainBackendRegistry> {
  const result = await sql.query("SELECT key, storage_mode FROM domains");
  const registry = new DomainBackendRegistry();
  for (const row of result.rows as readonly { key: unknown; storage_mode: unknown }[]) {
    if (typeof row.key !== "string" || row.key.length === 0) throw new Error(`domains table contains a row with an invalid key: ${JSON.stringify(row.key)}`);
    if (typeof row.storage_mode !== "string" || !STORAGE_MODES.has(row.storage_mode)) {
      throw new Error(`domain "${row.key}" has invalid storage_mode ${JSON.stringify(row.storage_mode)}`);
    }
    if (row.storage_mode === "local") {
      registry.register(row.key, new LocalBackend(row.key, sql));
    } else {
      const backend = opts.backends?.[row.key];
      if (backend !== undefined) registry.register(row.key, backend);
    }
  }
  return registry;
}
