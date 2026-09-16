/**
 * SourceAdapter port — normalized event ingress from authorized sources.
 *
 * Source: plan §4 (ports list), plan §8 (event model; every source defines
 * its external id), plan §13/§15 M2 (CLI capture adapter is the Phase-1
 * implementation). Defining ADR: ADR-0006 (event envelope compatibility
 * contract).
 *
 * Product model (plan §8): authorized source → SourceAdapter → normalized
 * observation/event → extraction/policy → world-model update. A connector
 * is built only when the system knows what useful state it intends to derive
 * from it. Poll/cursor and webhook mechanics arrive with E3 sources; this
 * port defines only the normalization contract now.
 */

/**
 * Sensitivity classification carried on events (plan §8) and consulted by
 * the model egress policy (plan §9; ADR-0012). v1 vocabulary:
 * `normal` | `sensitive` | `secret` — `secret` is never in model context.
 * TODO(at M4): confirm the authoritative vocabulary against the policy
 * engine (`policy.yaml` v1); extend here, never per-adapter.
 */
export type Sensitivity = "normal" | "sensitive" | "secret";

/**
 * The event-envelope fields (plan §8; docs/event-model.md §2) a source
 * adapter produces for one external occurrence.
 *
 * The adapter does NOT mint `id` (uuid v7), `idempotencyKey`
 * (`sha256(source + externalId)`), `recordedAt`, or `runId` — those are
 * ingest-API responsibilities (plan §15 M2).
 *
 * Every source defines its `externalId` (plan §8): adapter retries reuse it
 * so a redelivery of one real-world occurrence dedupes against the unique
 * idempotency key; distinct real-world occurrences get a new one (the CLI
 * mints a fresh uuid per capture/decide invocation).
 */
export interface NormalizedExternalEvent {
  /** Catalog name, `<noun>.<verb_past>` — immutable once released (ADR-0006). */
  readonly type: string;
  /** Provenance: `cli.capture | openclaw.channel | adapter:<id> | internal`. */
  readonly source: string;
  /** External id defined by the source; feeds the idempotency key. */
  readonly externalId: string;
  /** ISO 8601 — when it happened in the world (recordedAt is minted at ingest). */
  readonly occurredAt: string;
  readonly domainId: string;
  readonly sensitivity: Sensitivity;
  /** Type-specific, versioned body. Secrets never enter payloads (AGENTS.md, T4). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Normalizes one raw external occurrence into envelope fields. Vendor SDK
 * types must not appear in this signature (ADR-0002): `TRaw` is the
 * adapter's own private input type, opaque to domain code.
 */
export interface SourceAdapter {
  readonly id: string;
  normalizeExternal<TRaw = unknown>(raw: TRaw): NormalizedExternalEvent;
}
