/**
 * Event envelope (docs/event-model.md §2; plan §8; ADR-0006).
 *
 * The envelope is the wire and verbatim-stored form (camelCase); the
 * snake_case relational projection is `events`/`outbox` columns. The single
 * mapping point between the two lives in ./store.ts (D2 resolution,
 * event-model §9.1).
 *
 * Ingest minting (plan §15 M2): the caller supplies the occurrence fields
 * (type, source, externalId, occurredAt, domainId, sensitivity, payload);
 * this module's store mints `id` (uuid v7), `idempotencyKey`
 * (sha256(source + "\u0000" + externalId) — the NUL separator makes the
 * source/externalId split unambiguous, so cross-source concatenation can
 * never collide: (adapter:a, "bc") ≠ (adapter:ab, "c")), `recordedAt`, and
 * defaults `runId` to null — "those are ingest-API responsibilities"
 * (ports/source-adapter.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  isCatalogV1EventTypeName,
  LATEST_PAYLOAD_SCHEMA_VERSION,
  type EventTypeName,
} from "./catalog.js";

/**
 * Sensitivity vocabulary v1 (plan §8; mirrors the `Sensitivity` type in
 * @jehad/adapters ports — kept structural there, defined here so @jehad/core
 * stays dependency-free). TODO(at M4): confirm against policy.yaml v1.
 */
export const SENSITIVITY_V1 = ["normal", "sensitive", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITY_V1)[number];

function isSensitivity(value: unknown): value is Sensitivity {
  return (
    typeof value === "string" &&
    (SENSITIVITY_V1 as readonly string[]).includes(value)
  );
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Provenance vocabulary (event-model §2): named sources + adapter escape hatch. */
export const SOURCE_RE =
  /^(?:cli\.capture|openclaw\.channel|internal|adapter:[a-z0-9][a-z0-9._-]*)$/;

/** The stored, canonical event form — camelCase, timestamps as ISO strings. */
export interface EventEnvelope {
  readonly id: string;
  readonly type: EventTypeName;
  readonly schemaVersion: number;
  readonly source: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly domainId: string;
  readonly idempotencyKey: string;
  readonly sensitivity: Sensitivity;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly runId: string | null;
}

/**
 * One external occurrence as submitted to POST /events — the
 * NormalizedExternalEvent fields (ports/source-adapter.ts) plus the payload
 * `schemaVersion` the compatibility contract requires on every event.
 */
export interface EventIngestInput {
  readonly type: EventTypeName;
  readonly schemaVersion: number;
  readonly source: string;
  readonly externalId: string;
  readonly occurredAt: string;
  readonly domainId: string;
  readonly sensitivity: Sensitivity;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly runId: string | null;
}

export type EventValidationErrorCode =
  | "ENVELOPE_MALFORMED"
  | "TYPE_NOT_IN_CATALOG"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "SOURCE_INVALID"
  | "EXTERNAL_ID_INVALID"
  | "OCCURRED_AT_INVALID"
  | "DOMAIN_ID_INVALID"
  | "SENSITIVITY_INVALID"
  | "PAYLOAD_INVALID"
  | "RUN_ID_INVALID";

export interface EventValidationError {
  readonly code: EventValidationErrorCode;
  readonly message: string;
}

export type EventValidationResult =
  | { ok: true; value: EventIngestInput }
  | { ok: false; error: EventValidationError };

function err(code: EventValidationErrorCode, message: string): EventValidationResult {
  return { ok: false, error: { code, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDatetime(value: string): boolean {
  if (!value.includes("T")) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/** Max JSON nesting depth accepted in an ingest payload (R7 guard). */
export const MAX_PAYLOAD_DEPTH = 64;

/** Max serialized payload size in bytes (R7 guard). */
export const MAX_PAYLOAD_JSON_BYTES = 256 * 1024;

/**
 * True when `value` nests containers deeper than `limit` levels (the
 * top-level object is depth 1; primitives consume no depth). Recursion is
 * bounded by `limit + 1` frames, so adversarially deep input is rejected,
 * never stack-crashed.
 */
function exceedsDepth(value: unknown, limit: number): boolean {
  function walk(node: unknown, depth: number): boolean {
    if (Array.isArray(node)) {
      if (depth > limit) return true;
      return node.some((child) => walk(child, depth + 1));
    }
    if (isPlainObject(node)) {
      if (depth > limit) return true;
      return Object.values(node).some((child) => walk(child, depth + 1));
    }
    return false;
  }
  return walk(value, 1);
}

/** Serialized byte size of the payload as it will be stored (jsonb). */
function payloadJsonBytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/**
 * Validates an ingest body. Deterministic: checks fields in a fixed order and
 * reports the first failure as a stable (code, message) pair — the API maps
 * every code to HTTP 400.
 */
export function validateEventIngest(input: unknown): EventValidationResult {
  if (!isPlainObject(input)) {
    return err("ENVELOPE_MALFORMED", "request body must be a JSON object");
  }
  if (!isCatalogV1EventTypeName(input.type)) {
    return err(
      "TYPE_NOT_IN_CATALOG",
      `type ${JSON.stringify(input.type)} is not in catalog v1`,
    );
  }
  const type: EventTypeName = input.type;
  if (
    typeof input.schemaVersion !== "number" ||
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < 1 ||
    input.schemaVersion > LATEST_PAYLOAD_SCHEMA_VERSION
  ) {
    return err(
      "SCHEMA_VERSION_UNSUPPORTED",
      `schemaVersion must be an integer between 1 and ${LATEST_PAYLOAD_SCHEMA_VERSION}`,
    );
  }
  const schemaVersion: number = input.schemaVersion;
  if (typeof input.source !== "string" || !SOURCE_RE.test(input.source)) {
    return err(
      "SOURCE_INVALID",
      'source must be "cli.capture", "openclaw.channel", "internal", or "adapter:<id>"',
    );
  }
  const source: string = input.source;
  if (
    typeof input.externalId !== "string" ||
    input.externalId.length === 0 ||
    input.externalId.length > 256
  ) {
    return err(
      "EXTERNAL_ID_INVALID",
      "externalId must be a non-empty string of at most 256 characters",
    );
  }
  const externalId: string = input.externalId;
  if (typeof input.occurredAt !== "string" || !isIsoDatetime(input.occurredAt)) {
    return err("OCCURRED_AT_INVALID", "occurredAt must be an ISO 8601 datetime string");
  }
  const occurredAt: string = new Date(input.occurredAt).toISOString();
  if (
    typeof input.domainId !== "string" ||
    input.domainId.trim().length === 0 ||
    input.domainId !== input.domainId.trim()
  ) {
    return err("DOMAIN_ID_INVALID", "domainId must be a non-empty domain key");
  }
  const domainId: string = input.domainId;
  if (!isSensitivity(input.sensitivity)) {
    return err(
      "SENSITIVITY_INVALID",
      'sensitivity must be one of "normal", "sensitive", "secret"',
    );
  }
  const sensitivity: Sensitivity = input.sensitivity;
  if (!isPlainObject(input.payload)) {
    return err("PAYLOAD_INVALID", "payload must be a JSON object");
  }
  const payload: Record<string, unknown> = input.payload;
  if (exceedsDepth(payload, MAX_PAYLOAD_DEPTH)) {
    return err(
      "PAYLOAD_INVALID",
      `payload must not nest deeper than ${MAX_PAYLOAD_DEPTH} levels`,
    );
  }
  if (payloadJsonBytes(payload) > MAX_PAYLOAD_JSON_BYTES) {
    return err(
      "PAYLOAD_INVALID",
      `payload must serialize to at most ${MAX_PAYLOAD_JSON_BYTES} bytes`,
    );
  }
  const rawRunId: unknown = input.runId;
  let runId: string | null = null;
  if (rawRunId !== undefined && rawRunId !== null) {
    if (typeof rawRunId !== "string" || !UUID_RE.test(rawRunId)) {
      return err("RUN_ID_INVALID", "runId must be null or a UUID");
    }
    runId = rawRunId;
  }
  return {
    ok: true,
    value: {
      type,
      schemaVersion,
      source,
      externalId,
      occurredAt,
      domainId,
      sensitivity,
      payload,
      runId,
    },
  };
}

/**
 * Idempotency key: sha256(source + "\u0000" + external id) — plan §8. The NUL
 * separator cannot appear in either string (source is matched by SOURCE_RE,
 * externalId is validated non-empty UTF-8 text), so the (source, externalId)
 * pair maps injectively onto the hashed bytes — no cross-source collisions
 * ((adapter:a, "bc") vs (adapter:ab, "c") hash differently). Every source
 * defines its external id; adapter retries reuse it (redelivery dedupes),
 * distinct real-world occurrences mint a new one.
 */
export function idempotencyKeyFor(source: string, externalId: string): string {
  return createHash("sha256")
    .update(`${source}\u0000${externalId}`, "utf8")
    .digest("hex");
}

/** Mints the envelope id: UUID v7 (time-ordered; PG16 has no uuidv7()). */
export function mintEventId(now: Date = new Date()): string {
  const ms = now.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0 || ms >= 2 ** 48) {
    throw new RangeError(`mintEventId: timestamp out of 48-bit range: ${ms}`);
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
