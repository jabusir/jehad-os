// The read/classify half of the sensor (gateway Phase A).
//
// One poll: read rows with rowid > cursor (batched), classify each row's
// direction (is_from_me is the PRIMARY loop guard — docs/plans/
// imessage-gateway.md §5.2), decode attributedBody via the Lane A decoder
// when the text column is empty (79.5% of recent messages on this host are
// attributedBody-only — the decoder is load-bearing), and compute the
// canonical loop-defense hash for is_from_me rows ONLY.
//
// PRIVACY RULE (multi-principal, binding contract — ig-multiprincipal-
// contracts.md "Heartbeat response carries sensor config"): non-own
// message content leaves this process ONLY when the row's handle is in
// the paired-handle cache the server sends with every heartbeat response
// (src/paired.ts). EVERY other non-own row with content carries
// `pairing_attempt_hash` = sha256(canonicalNormalize(content)) instead —
// metadata, lengths, hashes and decoder status otherwise. Own rows are
// unchanged: loop hash only, never content. The ingest service enforces
// the same rule server-side (stray content → discard + audit).
//
// Canonical normalization + hash are IDENTICAL to the Lane C edge
// (apps/edge-agent/src/render.ts; ig-phase-a-contracts.md): NFC + CR/CRLF
// → LF, no trimming, no punctuation rewrite, sha256 hex of UTF-8.

import { createHash } from "node:crypto";
import type { ChatDbHandle, ChatDbSnapshot, ChatMessageRow } from "./db.js";
import { decodeAttributedBody, type DecodeResult } from "./decoder/index.js";
import type { PairedHandleLookup } from "./paired.js";

export type SensorDecodedStatus =
  | "ok"
  | "own-ok"
  | "skipped-malformed"
  | "skipped-unknown"
  | "not-attempted";

/** The contract wire row (snake_case; matches ImessageTransportEventInput). */
export interface TransportEventWire {
  readonly guid: string;
  readonly rowid: number;
  readonly is_from_me: boolean;
  readonly transport_handle: string;
  readonly service: string | null;
  readonly has_text: boolean;
  readonly has_attributed_body: boolean;
  readonly decoded_status: SensorDecodedStatus;
  readonly text_length: number | null;
  readonly normalized_text_sha256?: string;
  /** Decoded text — ONLY for non-own rows whose handle is paired (privacy rule). */
  readonly content?: string;
  /** sha256(canonicalNormalize(content)) — ONLY for non-own rows with content whose handle is NOT paired. */
  readonly pairing_attempt_hash?: string;
  readonly observed_at: string;
}

export interface RowClassification {
  readonly event: TransportEventWire;
  readonly decodeAttempted: boolean;
  readonly decodeFailed: boolean;
}

/** Canonical text normalization BEFORE any hashing (binding contract). */
export function canonicalNormalize(text: string): string {
  return text.normalize("NFC").replace(/\r\n|\r/g, "\n");
}

/** sha256 hex (UTF-8) of the canonical form — the loop-defense fingerprint. */
export function canonicalTextSha256(text: string): string {
  return createHash("sha256").update(canonicalNormalize(text), "utf8").digest("hex");
}

type Decoder = (blob: Uint8Array) => DecodeResult;

function failedStatus(result: Extract<DecodeResult, { ok: false }>): SensorDecodedStatus {
  return result.reason === "unknown-archive" ? "skipped-unknown" : "skipped-malformed";
}

/**
 * Classifies one chat.db row into its transport-event wire shape. Pure
 * apart from the injected decoder (defaults to the real Lane A decoder).
 * Content (text or decoded attributedBody) is placed on the wire ONLY
 * for non-own rows whose handle is paired (lookup from the heartbeat
 * config cache); every other non-own row with content carries its
 * canonical pairing hash instead. Own rows keep the loop hash only.
 */
export function classifyRow(
  row: ChatMessageRow,
  observedAt: string,
  paired?: PairedHandleLookup,
  decode: Decoder = decodeAttributedBody,
): RowClassification {
  const hasText = row.text !== null && row.text.length > 0;
  const blob = row.attributedBody;

  let content: string | null = hasText ? row.text : null;
  let status: SensorDecodedStatus = "not-attempted";
  let decodeAttempted = false;
  let decodeFailed = false;

  if (content === null && blob !== null) {
    decodeAttempted = true;
    const result = decode(blob);
    if (result.ok) {
      content = result.text;
    } else {
      decodeFailed = true;
      status = failedStatus(result);
    }
  }

  if (content !== null) status = row.isFromMe ? "own-ok" : "ok";

  // Multi-principal content rule: paired handle → content; any other
  // non-own row with content → pairing hash; own rows → loop hash only.
  const rowContent = content;
  const pairedRow = !row.isFromMe && rowContent !== null && (paired?.has(row.handleId) ?? false);
  const unpairedRow = !row.isFromMe && rowContent !== null && !pairedRow;

  const event: TransportEventWire = {
    guid: row.guid.length > 0 ? row.guid : `rowid:${row.rowid}`,
    rowid: row.rowid,
    is_from_me: row.isFromMe,
    transport_handle:
      row.handleId !== null && row.handleId.length > 0 ? row.handleId.slice(0, 255) : "unknown",
    service: row.service,
    has_text: hasText,
    has_attributed_body: blob !== null,
    decoded_status: status,
    text_length: rowContent !== null ? Buffer.byteLength(rowContent, "utf8") : null,
    ...(row.isFromMe && rowContent !== null
      ? { normalized_text_sha256: canonicalTextSha256(rowContent) }
      : {}),
    ...(pairedRow && rowContent !== null ? { content: rowContent } : {}),
    ...(unpairedRow && rowContent !== null
      ? { pairing_attempt_hash: canonicalTextSha256(rowContent) }
      : {}),
    observed_at: observedAt,
  };

  return { event, decodeAttempted, decodeFailed };
}

export interface PollOutcome {
  readonly events: readonly TransportEventWire[];
  /** Cursor AFTER this batch (last rowid seen; unchanged when no rows). */
  readonly cursorRowid: number;
  readonly maxRowid: number;
  readonly snapshot: ChatDbSnapshot;
  /** Batch hit the cap with more rows remaining — next cycle continues. */
  readonly truncated: boolean;
  readonly decodeAttempted: number;
  readonly decodeFailed: number;
  /** true when at least one decode SUCCEEDED this poll (resets the drift counter). */
  readonly hasDecodeSuccess: boolean;
  /** Trailing run of decode failures AFTER the last success in this poll. */
  readonly decodeFailureTailRun: number;
  /** ≥1 is_from_me row fully classified (content + hash) this poll. */
  readonly ownObserved: boolean;
  /** ≥1 is_from_me row undecodable this poll (loop correlation blind). */
  readonly ownDecodeFailure: boolean;
}

/**
 * One read pass: rows with rowid > cursorRowid, ascending, capped at
 * batchCap, classified to wire shape. Never writes, never throws on data
 * (decoder failures become per-row skipped-* statuses + counters).
 * `paired` is the heartbeat-config lookup; omitted → nothing is paired
 * (fail closed: hash-only for all non-own rows).
 */
export function pollOnce(
  chat: ChatDbHandle,
  cursorRowid: number,
  batchCap: number,
  now: () => Date = () => new Date(),
  paired?: PairedHandleLookup,
  decode: Decoder = decodeAttributedBody,
): PollOutcome {
  const snapshot = chat.snapshot();
  if (snapshot.maxRowid <= cursorRowid) {
    return {
      events: [],
      cursorRowid,
      maxRowid: snapshot.maxRowid,
      snapshot,
      truncated: false,
      decodeAttempted: 0,
      decodeFailed: 0,
      hasDecodeSuccess: false,
      decodeFailureTailRun: 0,
      ownObserved: false,
      ownDecodeFailure: false,
    };
  }
  const rows = chat.readBatch(cursorRowid, batchCap);
  const observedAt = now().toISOString();
  let decodeAttempted = 0;
  let decodeFailed = 0;
  let hasDecodeSuccess = false;
  let failureRun = 0;
  let tailRun = 0;
  let ownObserved = false;
  let ownDecodeFailure = false;
  const events: TransportEventWire[] = [];
  for (const row of rows) {
    const classified = classifyRow(row, observedAt, paired, decode);
    if (classified.decodeAttempted) {
      decodeAttempted += 1;
      if (classified.decodeFailed) {
        decodeFailed += 1;
        failureRun += 1;
        tailRun = failureRun;
        if (row.isFromMe) ownDecodeFailure = true;
      } else {
        hasDecodeSuccess = true;
        failureRun = 0;
        tailRun = 0;
      }
    }
    if (row.isFromMe && classified.event.decoded_status === "own-ok") ownObserved = true;
    events.push(classified.event);
  }
  const lastRowid = rows.length > 0 ? rows[rows.length - 1]!.rowid : cursorRowid;
  return {
    events,
    cursorRowid: lastRowid,
    maxRowid: snapshot.maxRowid,
    snapshot,
    truncated: rows.length === batchCap && snapshot.maxRowid > lastRowid,
    decodeAttempted,
    decodeFailed,
    hasDecodeSuccess,
    decodeFailureTailRun: tailRun,
    ownObserved,
    ownDecodeFailure,
  };
}
