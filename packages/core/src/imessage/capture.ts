// Phase F — conversation capture → memory candidates
// (docs/plans/ig-phase-f-contracts.md; ADR-0004, ADR-0014 §1).
//
// Self-contained detection + landing module for the iMessage conversation
// path. Deterministic-first: an explicit storage imperative in the CURRENT
// inbound turn ("remember that …", "note: …", "don't forget that …") is a
// capture; a mention ("I've been looking at 911s") is working context only.
// Non-matching text may fall back to an INJECTED decision function
// (`intentRouter`) that the orchestrator wires to the Phase E route pass —
// strict contract JSON {"capture":true|false}; absent = deterministic-only.
// NO model calls live in this module.
//
// A capture lands as a memory candidate through the EXISTING pipeline
// conventions — the shared seam contract (../memory/candidate-contract.ts),
// the deterministic candidate id (../extraction/service.ts), the event
// store (../events/store.ts) — with speaker attribution ("Jehad said X",
// never "X is true"), domain 'personal', sensitivity 'normal', and the
// ESCALATE-2 force-review default: status='in_review', no
// auto-canonization; approval happens in the existing review queue.
//
// Audits carry ids/counts only — never content (the candidate row itself
// carries content per the memory pipeline; that is its job).

import { createHash, randomUUID } from "node:crypto";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { acceptEvent } from "../events/store.js";
import { deterministicCandidateId } from "../extraction/service.js";
import type { MemoryCandidateContract } from "../memory/candidate-contract.js";
import { redactContent } from "./redact.js";

/** Event source stamp for iMessage captures (contract §3). */
export const CAPTURE_SOURCE = "imessage.capture";
/** The candidate's source event type (existing catalog v1 name). */
export const CAPTURE_EVENT_TYPE = "capture.recorded";
/** externalId prefix — `<prefix><guid>` (contract §3/§7). */
export const CAPTURE_EXTERNAL_ID_PREFIX = "imessage-capture:";
/** Provenance promptVersion tag for the deterministic detection lane. */
export const CAPTURE_PROMPT_VERSION = "imessage-capture-v1";
export const CAPTURE_SURFACE = "imessage";
export const CAPTURE_DOMAIN_KEY = "personal";
/** Inbound-text cap on the capture event payload (Phase D contract §3). */
export const CAPTURE_TEXT_LIMIT = 2000;

/** Deterministic ack — contract §5 (honest, free, cannot paraphrase memory). */
export const CAPTURE_ACK_REPLY =
  "Noted — captured for review; it becomes memory once you approve.";
/** Dedupe-window noop ack — contract §8 ("already captured"). */
export const CAPTURE_ALREADY_REPLY = "Already captured — it's in your review queue.";
/** Flood-cap ack — contract §8 (honest "capture limit reached"). */
export const CAPTURE_LIMIT_REPLY =
  "Capture limit reached for this hour — nothing was saved. Try again later.";
/** ESCALATE-1 honest denial for non-capture-enabled principals (contract §6). */
export const CAPTURE_DENIED_REPLY =
  "I can't save memories from this chat — memory capture is enabled only for Jehad on this channel.";

export interface CaptureInput {
  readonly principalId: string;
  /** Principal display name — the speaker in the attributed statement. */
  readonly principalName: string;
  /** The CURRENT inbound turn's text — the only input detection ever reads. */
  readonly text: string;
  readonly threadId?: string;
  /**
   * Id of an already-accepted `capture.recorded` event to use as the
   * candidate's provenance (e.g. accepted upstream keyed on the ingest
   * guid, externalId `imessage-capture:<guid>`). Absent → this module
   * accepts the capture.recorded event itself. Synthetic events are never
   * fabricated: without a sourceEventId the event is the real capture
   * record of this turn.
   */
  readonly sourceEventId?: string;
  readonly now: Date;
}

/** policy.yaml `gateway.capture` shape (contract §8 — strict keys). */
export interface CapturePolicy {
  readonly enabled: boolean;
  readonly principals: readonly string[];
  readonly maxCandidatesPerHour: number;
  readonly dedupeWindowHours: number;
}

/** Contract §8 defaults — owner principal 'josctl' enabled, all else denied. */
export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  enabled: true,
  principals: ["josctl"],
  maxCandidatesPerHour: 5,
  dedupeWindowHours: 24,
};

/** Only for principals whose policy enables capture (contract §6). */
export function captureEnabledFor(
  principalName: string,
  policy?: CapturePolicy | null,
): boolean {
  const p = policy ?? DEFAULT_CAPTURE_POLICY;
  return p.enabled && p.principals.includes(principalName);
}

export type CaptureTrigger = "pattern" | "route";

export type CaptureDeclineReason =
  | "principal-not-capture-enabled"
  | "no-capture-trigger"
  | "duplicate-source-event"
  | "duplicate-content"
  | "flood-cap"
  | "intent-router-error";

export interface CaptureOutcome {
  readonly captured: boolean;
  readonly reason?: CaptureDeclineReason;
  /** Deterministic reply line for the orchestrator to append to the turn. */
  readonly reply?: string;
}

/**
 * Injectable LLM-route fallback (contract §2): the orchestrator wires the
 * Phase E route pass behind this. Must implement the STRICT contract JSON
 * `{"capture":true|false}` — exact keys/enums, any deviation fails safe to
 * false. Throwing/rejecting also fails safe (no capture).
 */
export type CaptureIntentRouter = (text: string) => Promise<boolean>;

export interface ConsiderCaptureOptions {
  readonly policy?: CapturePolicy | null;
  readonly intentRouter?: CaptureIntentRouter;
}

// ------------------------------------------------------------- detection

/**
 * Deterministic pre-pass (contract §2): trimmed, case-insensitive prefix
 * match on storage imperatives — `remember that…`, `note that…`,
 * `remember:…`, `note:…`, `don't forget that…`, `keep in mind that…`
 * (optional leading "please"/"just", optional that/this, optional colon).
 */
const IMPERATIVE_PREFIX =
  /^(?:please\s+|just\s+)?(?:don't\s+forget|keep\s+in\s+mind|remember|note)(?:\s+that|\s+this)?\s*:?\s+/i;

/** Negated imperatives ("don't remember…", "never note…") — never captures. */
const NEGATED_IMPERATIVE =
  /^(?:please\s+|just\s+)?(?:do\s*not|don't|dont|never)\s+(?:please\s+)?(?:remember|note|keep\s+in\s+mind)\b/i;

export interface CaptureIntentMatch {
  readonly triggered: boolean;
  readonly trigger: CaptureTrigger | null;
  /** The captured content — the text minus the imperative prefix. */
  readonly content: string | null;
}

const NO_MATCH: CaptureIntentMatch = { triggered: false, trigger: null, content: null };

/** Questions ("remember that we settled it?") are not storage imperatives. */
function looksLikeQuestion(trimmed: string): boolean {
  return trimmed.endsWith("?");
}

export function matchCaptureIntent(text: string): CaptureIntentMatch {
  const trimmed = text.trim();
  if (trimmed.length === 0 || looksLikeQuestion(trimmed)) return NO_MATCH;
  if (NEGATED_IMPERATIVE.test(trimmed)) return NO_MATCH;
  const match = IMPERATIVE_PREFIX.exec(trimmed);
  if (match === null) return NO_MATCH;
  const content = trimmed.slice(match[0].length).trim();
  if (content.length === 0) return NO_MATCH;
  return { triggered: true, trigger: "pattern", content };
}

/**
 * Dedupe normalization (contract §8): the sensor's canonical form (NFC +
 * CR/CRLF → LF — apps/imessage-sensor/src/poll.ts) plus trim + lowercase
 * so a restatement in different casing is still "identical" content.
 */
export function captureNormalize(text: string): string {
  return text.normalize("NFC").replace(/\r\n|\r/g, "\n").trim().toLowerCase();
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

// ------------------------------------------------------------- audits

const CAPTURE_ACTOR = "system:imessage-gateway";

/** ids/counts only — NEVER content (contract §8). */
function audit(
  db: SqlExecutor,
  action: "imessage.capture.proposed" | "imessage.capture.deduped" | "imessage.capture.denied" | "imessage.capture.capped",
  outputs: Record<string, unknown>,
): Promise<void> {
  return recordAudit(db, {
    actor: CAPTURE_ACTOR,
    action,
    reversible: true,
    outputsRef: JSON.stringify(outputs),
  });
}

// ------------------------------------------------------------- queries

async function candidateForSourceEvent(
  db: SqlExecutor,
  sourceEventId: string,
): Promise<string | null> {
  const result = await db.query(
    `SELECT id FROM memory_candidates WHERE provenance->>'sourceEventId' = $1 LIMIT 1`,
    [sourceEventId],
  );
  const row = result.rows[0];
  return row === undefined ? null : String(row.id);
}

async function duplicateContentCandidate(
  db: SqlExecutor,
  principalId: string,
  normalizedTextSha256: string,
  windowStart: string,
): Promise<string | null> {
  const result = await db.query(
    `SELECT id FROM memory_candidates
      WHERE payload->'metadata'->>'principalId' = $1
        AND payload->'metadata'->>'normalizedTextSha256' = $2
        AND created_at >= $3::timestamptz
      LIMIT 1`,
    [principalId, normalizedTextSha256, windowStart],
  );
  const row = result.rows[0];
  return row === undefined ? null : String(row.id);
}

async function capturesLastHour(
  db: SqlExecutor,
  principalId: string,
  hourStart: string,
): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS n FROM memory_candidates
      WHERE payload->'metadata'->>'principalId' = $1
        AND payload->'metadata'->>'captureSource' = $2
        AND created_at >= $3::timestamptz`,
    [principalId, CAPTURE_SOURCE, hourStart],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// ------------------------------------------------------------- landing

const INSERT_CANDIDATE_SQL = `
  INSERT INTO memory_candidates
    (id, domain_id, proposed_class, assertion_kind, payload, provenance,
     gate_result, status, created_at, updated_at)
  VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, 'in_review',
          $8::timestamptz, $8::timestamptz)
  ON CONFLICT (id) DO NOTHING
  RETURNING id
`;

/** ESCALATE-2 force-review marker (contract §5): always the review queue. */
function forceReviewGateResult(now: Date): string {
  return JSON.stringify({
    version: 1,
    action: "in_review",
    gate: null,
    reason: "force_review_source",
    message:
      "iMessage capture candidates always route to review; no auto-canonization (ig-phase-f §5).",
    forceReview: { source: CAPTURE_SOURCE, decidedAt: now.toISOString() },
    write: null,
    review: null,
  });
}

/**
 * Consider one inbound turn for capture. Deterministic-first: pattern
 * pre-pass, then (only if injected) the route-pass fallback. Never calls a
 * model. Land order: policy gate → detection → source-event idempotency →
 * 24h content dedupe → flood cap → candidate + memory.proposed + audit.
 *
 * Replay safety (contract §7, triple idempotency): (a) a sourceEventId that
 * already produced a candidate never captures again; (b) identical
 * normalized content within the dedupe window is a noop + ack; (c) guid
 * redelivery is deduped upstream at ingest — the orchestrator passes the
 * guid-keyed capture.recorded event id as sourceEventId, so one guid → at
 * most one candidate, ever.
 */
export async function considerCapture(
  db: SqlExecutor,
  input: CaptureInput,
  opts: ConsiderCaptureOptions = {},
): Promise<CaptureOutcome> {
  const now = input.now;
  const policy = opts.policy ?? DEFAULT_CAPTURE_POLICY;

  // 1. Principal scoping — single-tenant world model (contract §6).
  if (!captureEnabledFor(input.principalName, policy)) {
    await audit(db, "imessage.capture.denied", {
      reason: "principal-not-capture-enabled",
      principalId: input.principalId,
      principalName: input.principalName,
    });
    return {
      captured: false,
      reason: "principal-not-capture-enabled",
      reply: CAPTURE_DENIED_REPLY,
    };
  }

  // 2. Detection — deterministic pre-pass, then optional route fallback.
  const text = redactContent(input.text).slice(0, CAPTURE_TEXT_LIMIT);
  const match = matchCaptureIntent(input.text);
  let trigger: CaptureTrigger;
  let content: string;
  if (match.triggered && match.trigger === "pattern" && match.content !== null) {
    trigger = "pattern";
    content = match.content;
  } else if (opts.intentRouter !== undefined) {
    let routed: boolean;
    try {
      routed = await opts.intentRouter(input.text);
    } catch {
      // Fail safe (contract §2): any router deviation → no capture.
      return { captured: false, reason: "intent-router-error" };
    }
    if (routed !== true) return { captured: false, reason: "no-capture-trigger" };
    trigger = "route";
    content = input.text.trim();
  } else {
    return { captured: false, reason: "no-capture-trigger" };
  }
  const capturedText = redactContent(content).slice(0, CAPTURE_TEXT_LIMIT);
  const normalizedTextSha256 = sha256Hex(captureNormalize(content));

  // 3a. Source-event idempotency — same sourceEventId never captures twice.
  if (input.sourceEventId !== undefined) {
    const existing = await candidateForSourceEvent(db, input.sourceEventId);
    if (existing !== null) {
      await audit(db, "imessage.capture.deduped", {
        kind: "source-event",
        principalId: input.principalId,
        sourceEventId: input.sourceEventId,
        candidateId: existing,
      });
      return {
        captured: false,
        reason: "duplicate-source-event",
        reply: CAPTURE_ALREADY_REPLY,
      };
    }
  }

  // 3b. Content dedupe — identical normalized text within the window.
  const windowStart = new Date(
    now.getTime() - policy.dedupeWindowHours * 60 * 60_000,
  ).toISOString();
  const dupe = await duplicateContentCandidate(
    db,
    input.principalId,
    normalizedTextSha256,
    windowStart,
  );
  if (dupe !== null) {
    await audit(db, "imessage.capture.deduped", {
      kind: "content",
      principalId: input.principalId,
      candidateId: dupe,
      threadId: input.threadId ?? null,
    });
    return { captured: false, reason: "duplicate-content", reply: CAPTURE_ALREADY_REPLY };
  }

  // 3c. Flood cap — capture candidates per principal per rolling hour.
  const hourStart = new Date(now.getTime() - 60 * 60_000).toISOString();
  const lastHour = await capturesLastHour(db, input.principalId, hourStart);
  if (lastHour >= policy.maxCandidatesPerHour) {
    await audit(db, "imessage.capture.capped", {
      principalId: input.principalId,
      candidatesLastHour: lastHour,
      cap: policy.maxCandidatesPerHour,
    });
    return { captured: false, reason: "flood-cap", reply: CAPTURE_LIMIT_REPLY };
  }

  // 4. Source event: the caller's capture.recorded event, or accept it here.
  let sourceEventId = input.sourceEventId;
  if (sourceEventId === undefined) {
    const accepted = await acceptEvent(
      db,
      {
        type: CAPTURE_EVENT_TYPE,
        schemaVersion: 1,
        source: CAPTURE_SOURCE,
        externalId: `${CAPTURE_EXTERNAL_ID_PREFIX}${randomUUID()}`,
        occurredAt: now.toISOString(),
        domainId: CAPTURE_DOMAIN_KEY,
        sensitivity: "normal",
        payload: {
          text,
          surface: CAPTURE_SURFACE,
          threadId: input.threadId ?? null,
          principalId: input.principalId,
        },
        runId: null,
      },
      { now: () => now },
    );
    sourceEventId = accepted.envelope.id;
  }

  // 5. Candidate via the existing seam: deterministic id, speaker-attributed
  //    statement ("Jehad said X" — never "X is true"), force-review default.
  const domain = await db.query(`SELECT id FROM domains WHERE key = $1`, [
    CAPTURE_DOMAIN_KEY,
  ]);
  const domainId = domain.rows[0]?.id;
  if (domainId === undefined) {
    throw new Error("considerCapture: personal domain is not seeded");
  }

  const contract: MemoryCandidateContract = {
    proposedClass: "semantic",
    assertionKind: "user_declared",
    domainId: CAPTURE_DOMAIN_KEY,
    payload: {
      kind: "memory_note",
      statement: `${input.principalName} said: "${capturedText}"`,
      speaker: input.principalName,
      confidence: 1,
      metadata: {
        surface: CAPTURE_SURFACE,
        captureSource: CAPTURE_SOURCE,
        principalId: input.principalId,
        threadId: input.threadId ?? null,
        trigger,
        normalizedTextSha256,
      },
    },
    provenance: {
      sourceEventId,
      runId: null,
      model: null,
      promptVersion: CAPTURE_PROMPT_VERSION,
    },
    confidence: 1,
  };
  const candidateId = deterministicCandidateId(contract);

  const inserted = await db.query(INSERT_CANDIDATE_SQL, [
    candidateId,
    String(domainId),
    contract.proposedClass,
    contract.assertionKind,
    JSON.stringify(contract.payload),
    JSON.stringify(contract.provenance),
    forceReviewGateResult(now),
    now.toISOString(),
  ]);
  if (inserted.rows[0] === undefined) {
    // Deterministic-id conflict: exact redelivery — idempotent by construction.
    await audit(db, "imessage.capture.deduped", {
      kind: "deterministic-id",
      principalId: input.principalId,
      candidateId,
      sourceEventId,
    });
    return { captured: true, reply: CAPTURE_ALREADY_REPLY };
  }

  // memory.proposed — references only, idempotent on the candidate id
  // (same convention as the extraction lane).
  await acceptEvent(
    db,
    {
      type: "memory.proposed",
      schemaVersion: 1,
      source: "internal",
      externalId: `memory-candidate:${candidateId}`,
      occurredAt: now.toISOString(),
      domainId: CAPTURE_DOMAIN_KEY,
      sensitivity: "normal",
      payload: {
        candidateId,
        proposedClass: contract.proposedClass,
        assertionKind: contract.assertionKind,
        kind: "memory_note",
        confidence: 1,
        sourceEventId,
        model: null,
        promptVersion: CAPTURE_PROMPT_VERSION,
      },
      runId: null,
    },
    { now: () => now },
  );

  await audit(db, "imessage.capture.proposed", {
    principalId: input.principalId,
    candidateId,
    sourceEventId,
    threadId: input.threadId ?? null,
    trigger,
  });
  return { captured: true, reply: CAPTURE_ACK_REPLY };
}
