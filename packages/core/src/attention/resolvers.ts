// Attention liveness resolvers (ADR-0018 §4; W1 contract). The liveness
// sweep is the backstop that closes items whose underlying object is gone —
// producer closes are primary, this is the safety net. A resolver answers
// 'live' (leave open), 'gone' (the sweep resolves the item), or 'unknown'
// (skip — unknown NEVER closes, fail-closed against silent swallowing).
//
// Defaults: `system` items are always live (system blindness items close on
// owner ack only, ADR-0018 §1.5); an unregistered sourceType resolves
// 'unknown' forever. Lane C registers the `outcome` resolver at
// outcome-producer module load; registration is idempotent (last write wins).

import type { SqlExecutor } from "../actions/audit.js";
import type { AttentionItemRow, AttentionSourceType } from "./types.js";

export type AttentionLiveness = "live" | "gone" | "unknown";

export type AttentionResolver = (
  db: SqlExecutor,
  item: AttentionItemRow,
  now: Date,
) => Promise<AttentionLiveness>;

const RESOLVERS = new Map<AttentionSourceType, AttentionResolver>();

const ALWAYS_LIVE: AttentionResolver = async () => "live";

/** Idempotent: re-registering a sourceType replaces its resolver. */
export function registerAttentionResolver(sourceType: AttentionSourceType, resolver: AttentionResolver): void {
  RESOLVERS.set(sourceType, resolver);
}

const FALLBACK: AttentionResolver = async () => "unknown";

/** The registry read: system → live; unregistered sourceType → unknown. */
export function resolveLiveness(db: SqlExecutor, item: AttentionItemRow, now: Date): Promise<AttentionLiveness> {
  const resolver = RESOLVERS.get(item.sourceType) ?? (item.sourceType === "system" ? ALWAYS_LIVE : FALLBACK);
  return resolver(db, item, now);
}
