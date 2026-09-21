// W5(c) — commitment transitions via conversational verbs (plan §7 W5(c);
// invariants §5-13/14, R6). The commitments state machine (open → met |
// renegotiated | missed) becomes live through THREE deterministic layers,
// zero model calls anywhere:
//
//   parseCommitmentVerb     — exact-match grammar over the inbound text
//   eligibleCommitments     — the open, domain-scoped, thread-relevant set
//   resolveCommitmentTarget — PURE sole/none/ambiguous/ref resolution
//   applyCommitmentTransition — guarded status write + event + audit
//
// Bare-verb law (invariant 14): `done`/`renegotiated`/`missed` mutate ONLY
// when exactly one eligible item exists; zero → honest none; multiple →
// require a `[ref]` or a clarifying question. Never guess.
//
// Refs: review-ref-STYLE codes (3-char Crockford base32, no I L O U — the
// 013 convention) DERIVED deterministically from the commitment id
// (sha256), not persisted tokens: review_refs.item_type is CHECK-bound to
// ('candidate','escalation') and minting commitment rows there needs a
// migration (reported; 016 precedent). A derived code names one eligible
// commitment for one reply — recomputed at resolution, so a stale code
// dies honestly as unknown.
//
// Provenance: transitions are user_declared — one append-only
// `commitment.transitioned` catalog event (payload carries the redacted
// note, capture.recorded precedent) + one content-free audit row (ids,
// statuses, verb — never note text). The task-spec feedback row
// (item_type='commitment', verdict=verb) is NOT written: 008/016 CHECK
// constraints do not admit it without a migration (reported deviation).

import { createHash } from "node:crypto";
import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { acceptEvent } from "../events/store.js";
import { LATEST_PAYLOAD_SCHEMA_VERSION } from "../events/catalog.js";
import { UUID_RE } from "../events/envelope.js";
import { redactContent } from "../imessage/redact.js";
import { toIsoOrNull, type QueryExecutor } from "../queries/executor.js";

/** Structural DB slice (pg.Pool / @jehad/db subset). */
export type CommitmentsDb = QueryExecutor & SqlExecutor;

export const COMMITMENTS_DOMAIN_KEY = "personal";

/** Audit actor for the verb write path (convention: service:<domain>). */
export const COMMITMENT_ACTOR = "system:commitments";

// ------------------------------------------------------------------ grammar

export type CommitmentVerb = "done" | "renegotiated" | "missed";

export interface ParsedCommitmentVerb {
  readonly verb: CommitmentVerb;
  /** Uppercase 3-char code from `[ABC]`; absent on bare verbs and notes. */
  readonly ref?: string;
  /** Free text after `:` / `—` / `-` (e.g. renegotiation terms). */
  readonly note?: string;
}

/**
 * Exact-match verb grammar. The verb must head the utterance (optionally
 * `mark (that|it) <verb>`); the remainder must be empty, a bracketed ref,
 * a note, or a ref + note. Anything else — including the pinned negatives
 * "done deal" and "missed you" — returns null and falls through to normal
 * conversation. Refs REQUIRE brackets (unlike review-commands' optional
 * brackets): a bare trailing word ("missed you") must never parse as a
 * ref. Shape-valid at parse; resolution dies honest on unknown codes.
 */
const VERB_HEAD_RE = /^(?:mark\s+(?:that\s+|it\s+)?)?(done|renegotiated|missed)\b(.*)$/i;
const REF_BRACKETED_RE = /^\[([0-9a-z]{3})\]$/i;
const REF_THEN_NOTE_RE = /^\[([0-9a-z]{3})\]\s*[:\u2014-]\s*(.+)$/i;
const NOTE_RE = /^[:\u2014-]\s*(.+)$/;

export function parseCommitmentVerb(text: string): ParsedCommitmentVerb | null {
  const match = VERB_HEAD_RE.exec(text.trim());
  if (match === null) return null;
  const verb = match[1]!.toLowerCase() as CommitmentVerb;
  let rest = match[2]!.trim();
  // Trailing sentence punctuation on the bare form ("done.", "missed!").
  rest = rest.replace(/[.!?]+$/, "").trim();
  if (rest.length === 0) return { verb };
  const refThenNote = REF_THEN_NOTE_RE.exec(rest);
  if (refThenNote !== null) {
    return { verb, ref: refThenNote[1]!.toUpperCase(), note: refThenNote[2]!.trim() };
  }
  const refOnly = REF_BRACKETED_RE.exec(rest);
  if (refOnly !== null) return { verb, ref: refOnly[1]!.toUpperCase() };
  const note = NOTE_RE.exec(rest);
  if (note !== null) return { verb, note: note[1]!.trim() };
  return null;
}

// --------------------------------------------------------------- eligibility

export interface EligibleCommitment {
  readonly id: string;
  readonly direction: "owes_me" | "i_owe";
  readonly counterpartyText: string;
  readonly description: string;
  readonly dueAt: string | null;
  readonly confidence: number;
  readonly status: string;
  readonly domainKey: string;
}

export interface EligibilityOptions {
  /** Domain key; default "personal" (the verb surface's scope, fail-closed). */
  readonly domainId?: string;
  readonly now?: () => Date;
  /**
   * Thread-relevance hint (invariant 14): labels from the thread's
   * referent registry (interaction_threads.metadata.referents[].label —
   * the caller passes them; shape is plain strings). Non-empty ⇒ only
   * open commitments whose description/counterparty relate to a label
   * stay eligible. Empty/undefined ⇒ every open commitment in the domain.
   */
  readonly referentLabels?: readonly string[];
}

const ELIGIBLE_SQL = `
  SELECT c.id, c.direction, c.counterparty_text, c.description,
         c.due_at, c.confidence, c.status, dom.key AS domain_key
  FROM commitments c
  JOIN domains dom ON dom.id = c.domain_id
  WHERE c.status = 'open' AND dom.key = $1
  ORDER BY (c.due_at IS NULL) ASC, c.due_at ASC, c.id ASC
`;

function normalizeLabel(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Pure thread-relevance predicate: a commitment matches a label when one
 * contains the other (case-insensitive, whitespace-collapsed) across
 * description + counterparty. Deliberately generous in BOTH directions —
 * a short referent label names a longer commitment and vice versa.
 */
export function matchesReferentLabels(
  item: Pick<EligibleCommitment, "description" | "counterpartyText">,
  labels: readonly string[],
): boolean {
  const normalized = labels.map(normalizeLabel).filter((l) => l.length > 0);
  if (normalized.length === 0) return true;
  const haystack = normalizeLabel(`${item.counterpartyText} ${item.description}`);
  const description = normalizeLabel(item.description);
  const counterparty = normalizeLabel(item.counterpartyText);
  return normalized.some(
    (label) =>
      haystack.includes(label) || label.includes(description) || (counterparty.length > 0 && label.includes(counterparty)),
  );
}

/** Open commitments eligible for a bare verb (status='open', domain-scoped). */
export async function eligibleCommitments(
  db: CommitmentsDb,
  opts: EligibilityOptions = {},
): Promise<readonly EligibleCommitment[]> {
  void opts.now; // accepted for signature symmetry; eligibility is time-free
  const result = await db.query(ELIGIBLE_SQL, [opts.domainId ?? COMMITMENTS_DOMAIN_KEY]);
  const items = result.rows.map((row) => ({
    id: String(row.id),
    direction: String(row.direction) as "owes_me" | "i_owe",
    counterpartyText: String(row.counterparty_text),
    description: String(row.description),
    dueAt: toIsoOrNull(row.due_at, "due_at"),
    confidence: Number(row.confidence),
    status: String(row.status),
    domainKey: String(row.domain_key),
  }));
  const labels = opts.referentLabels ?? [];
  return labels.length === 0 ? items : items.filter((item) => matchesReferentLabels(item, labels));
}

// ---------------------------------------------------------------- ref codes

/** Crockford base32 minus confusables (013 review-ref convention). */
export const COMMITMENT_REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const COMMITMENT_REF_LENGTH = 3;
const CODE_RE = new RegExp(`^[${COMMITMENT_REF_ALPHABET}]{${COMMITMENT_REF_LENGTH}}$`);

/**
 * Deterministic 3-char display code for one commitment (sha256-derived;
 * same alphabet/format as review refs). Stateless by design — see module
 * header. NOT authority-bearing outside the reply that rendered it.
 */
export function commitmentRefCode(id: string): string {
  const digest = createHash("sha256").update(`commitment:${id}`, "utf8").digest();
  const value = ((digest[0]! << 7) | (digest[1]! >>> 1)) & 0x7fff;
  return (
    COMMITMENT_REF_ALPHABET[(value >>> 10) & 31]! +
    COMMITMENT_REF_ALPHABET[(value >>> 5) & 31]! +
    COMMITMENT_REF_ALPHABET[value & 31]!
  );
}

// ----------------------------------------------------------------- resolver

export interface CommitmentCandidate {
  readonly id: string;
  readonly description: string;
  readonly direction: string;
  readonly counterpartyText: string;
  readonly ref: string;
}

export type CommitmentTargetResolution =
  | { readonly kind: "sole"; readonly id: string; readonly description: string }
  | { readonly kind: "ref"; readonly id: string; readonly description: string; readonly ref: string }
  | { readonly kind: "none" }
  | { readonly kind: "unknown_ref"; readonly ref: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly CommitmentCandidate[] };

function toCandidate(item: EligibleCommitment): CommitmentCandidate {
  return {
    id: item.id,
    description: item.description,
    direction: item.direction,
    counterpartyText: item.counterpartyText,
    ref: commitmentRefCode(item.id),
  };
}

/**
 * PURE (invariant 14): bare verb + sole eligible → apply; zero → honest
 * none; multiple → ambiguous (clarify); ref → the one eligible item whose
 * derived code matches. Unknown or off-alphabet refs resolve as
 * unknown_ref — never a guess. A code collision inside the eligible set
 * stays ambiguous (honest, not arbitrary).
 */
export function resolveCommitmentTarget(
  eligible: readonly EligibleCommitment[],
  ref?: string,
): CommitmentTargetResolution {
  if (ref !== undefined && ref !== null && String(ref).trim().length > 0) {
    const normalized = String(ref).trim().toUpperCase();
    if (!CODE_RE.test(normalized)) return { kind: "unknown_ref", ref: normalized };
    const matches = eligible.filter((item) => commitmentRefCode(item.id) === normalized);
    if (matches.length === 1) {
      return { kind: "ref", id: matches[0]!.id, description: matches[0]!.description, ref: normalized };
    }
    if (matches.length === 0) return { kind: "unknown_ref", ref: normalized };
    return { kind: "ambiguous", candidates: matches.map(toCandidate) };
  }
  if (eligible.length === 0) return { kind: "none" };
  if (eligible.length === 1) {
    return { kind: "sole", id: eligible[0]!.id, description: eligible[0]!.description };
  }
  return { kind: "ambiguous", candidates: eligible.map(toCandidate) };
}

// --------------------------------------------------------------- transition

export const VERB_TO_STATUS: Readonly<Record<CommitmentVerb, "met" | "renegotiated" | "missed">> = {
  done: "met",
  renegotiated: "renegotiated",
  missed: "missed",
};

/** Free-text note bound, applied BEFORE redaction (calibration convention). */
export const COMMITMENT_NOTE_LIMIT = 500;

export interface ApplyCommitmentTransitionInput {
  readonly commitmentId: string;
  readonly verb: CommitmentVerb;
  readonly note?: string | null;
  /** The principal whose statement declared the transition (user_declared). */
  readonly principalId: string;
  readonly now?: () => Date;
  readonly actor?: string;
}

export interface ApplyCommitmentTransitionResult {
  /** False = honest no-op (not found, or no longer open — never a guess). */
  readonly applied: boolean;
  readonly commitmentId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly reason: "not_found" | "not_open" | null;
  /** The commitment.transitioned event id; null when not applied. */
  readonly eventId: string | null;
  readonly noteRedacted: boolean;
}

const TRANSITION_SQL = `
  UPDATE commitments SET status = $2, updated_at = $3::timestamptz
  WHERE id = $1::uuid AND status = 'open'
  RETURNING id, status
`;

/**
 * Applies one guarded transition open → met|renegotiated|missed (verb
 * map). The UPDATE is a compare-and-set on status='open' — a replay, a
 * concurrent write, or a CLI-side resolution lands as applied=false with
 * an honest reason, never a second mutation. Side of consequence: one
 * append-only commitment.transitioned event (user_declared provenance,
 * redacted note) + one content-free audit row.
 */
export async function applyCommitmentTransition(
  db: CommitmentsDb,
  input: ApplyCommitmentTransitionInput,
): Promise<ApplyCommitmentTransitionResult> {
  if (!UUID_RE.test(input.commitmentId)) {
    throw new CommitmentTransitionError("commitmentId must be a uuid");
  }
  if (!UUID_RE.test(input.principalId)) {
    throw new CommitmentTransitionError("principalId must be a uuid");
  }
  const toStatus = VERB_TO_STATUS[input.verb];
  if (toStatus === undefined) {
    throw new CommitmentTransitionError(`verb must be done|renegotiated|missed, got '${String(input.verb)}'`);
  }
  const note = typeof input.note === "string" ? input.note.slice(0, COMMITMENT_NOTE_LIMIT) : null;
  const now = input.now?.() ?? new Date();
  const actor = input.actor ?? COMMITMENT_ACTOR;

  const updated = await db.query(TRANSITION_SQL, [
    input.commitmentId,
    toStatus,
    now.toISOString(),
  ]);
  if (updated.rows.length === 0) {
    const existing = await db.query(
      `SELECT c.id, c.status, dom.key AS domain_key
         FROM commitments c JOIN domains dom ON dom.id = c.domain_id
        WHERE c.id = $1::uuid`,
      [input.commitmentId],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      const result: ApplyCommitmentTransitionResult = {
        applied: false, commitmentId: input.commitmentId, fromStatus: "unknown",
        toStatus: "unknown", reason: "not_found", eventId: null, noteRedacted: false,
      };
      await transitionAudit(db, input, result, actor, now);
      return result;
    }
    const fromStatus = String(row.status);
    const result: ApplyCommitmentTransitionResult = {
      applied: false, commitmentId: input.commitmentId, fromStatus, toStatus: fromStatus,
      reason: "not_open", eventId: null, noteRedacted: false,
    };
    await transitionAudit(db, input, result, actor, now);
    return result;
  }

  const domainKey = await db.query(
    `SELECT dom.key AS domain_key, c.description
       FROM commitments c JOIN domains dom ON dom.id = c.domain_id
      WHERE c.id = $1::uuid`,
    [input.commitmentId],
  );
  const meta = domainKey.rows[0];
  const redactedNote = note === null ? null : redactContent(note);
  const accepted = await acceptEvent(
    db,
    {
      type: "commitment.transitioned",
      schemaVersion: LATEST_PAYLOAD_SCHEMA_VERSION,
      source: actor,
      externalId: `commitment:${input.commitmentId}:transition:${now.toISOString()}`,
      occurredAt: now.toISOString(),
      domainId: String(meta?.domain_key ?? COMMITMENTS_DOMAIN_KEY),
      sensitivity: "normal",
      payload: {
        commitmentId: input.commitmentId,
        verb: input.verb,
        fromStatus: "open",
        toStatus,
        provenance: "user_declared",
        declaredBy: input.principalId,
        ...(redactedNote !== null ? { note: redactedNote } : {}),
      },
      runId: null,
    },
    { now: () => now },
  );

  const result: ApplyCommitmentTransitionResult = {
    applied: true,
    commitmentId: input.commitmentId,
    fromStatus: "open",
    toStatus,
    reason: null,
    eventId: accepted.envelope.id,
    noteRedacted: note !== null && redactedNote !== note,
  };
  await transitionAudit(db, input, result, actor, now);
  return result;
}

export class CommitmentTransitionError extends Error {
  readonly code = "COMMITMENT_TRANSITION_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "CommitmentTransitionError";
  }
}

/** Content-free audit (ids/statuses/verb — never note text). */
async function transitionAudit(
  db: CommitmentsDb,
  input: ApplyCommitmentTransitionInput,
  result: ApplyCommitmentTransitionResult,
  actor: string,
  now: Date,
): Promise<void> {
  return recordAudit(db, {
    actor,
    action: "commitment.transition",
    reversible: true,
    outputsRef: JSON.stringify({
      commitmentId: input.commitmentId,
      verb: input.verb,
      provenance: "user_declared",
      principalId: input.principalId,
      applied: result.applied,
      fromStatus: result.fromStatus,
      toStatus: result.toStatus,
      ...(result.reason !== null ? { reason: result.reason } : {}),
      ...(result.eventId !== null ? { eventId: result.eventId } : {}),
      notePresent: typeof input.note === "string" && input.note.length > 0,
      noteRedacted: result.noteRedacted,
      at: now.toISOString(),
    }),
  });
}

// ------------------------------------------------------------------ replies

/** How many ambiguous candidates a reply lists before "…and N more". */
export const CLARIFY_CANDIDATE_LIMIT = 5;

/**
 * Deterministic replies (pure). sole/ref confirm what changed; none is the
 * honest zero; ambiguous clarifies with derived codes; unknown_ref never
 * guesses. Wording follows the review-commands reply register.
 */
export function renderCommitmentVerbReply(
  resolution: CommitmentTargetResolution,
  verb: CommitmentVerb,
): string {
  if (resolution.kind === "none") return "Nothing open matches that.";
  if (resolution.kind === "unknown_ref") {
    return "Unknown ref — nothing changed. Reply with a ref from the list I sent.";
  }
  if (resolution.kind === "ambiguous") {
    const lines = ["Which one? Reply with its ref:"];
    for (const c of resolution.candidates.slice(0, CLARIFY_CANDIDATE_LIMIT)) {
      lines.push(`- [${c.ref}] ${c.description} (${c.direction} ${c.counterpartyText})`);
    }
    if (resolution.candidates.length > CLARIFY_CANDIDATE_LIMIT) {
      lines.push(`- …and ${resolution.candidates.length - CLARIFY_CANDIDATE_LIMIT} more`);
    }
    return lines.join("\n");
  }
  return `Marked: ${resolution.description} — ${verb}.`;
}
