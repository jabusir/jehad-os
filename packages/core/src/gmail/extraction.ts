// Gmail deterministic extraction (Phase GMAIL Lane G2 —
// docs/plans/gmail-sensor-contracts.md §6/§7).
//
// DETERMINISTIC ONLY: zero model calls in v1 (§6.5). For allowlist senders
// (policy.extractSenders globs over the From address, §5.1) a bounded
// redacted subject (120 chars, §4.4) + textPlain (capped 2000 chars) run
// through regex extractors: currency amounts, due-date phrases (resolved
// SERVER-SIDE by the existing deterministic temporal normalizer — the
// extraction lane's civil-date engine; dates are never model math, §6.3),
// past-due markers. Typed fields out — free body text is NEVER an extractor
// output (§6.3): descriptions are composed from typed fields only.
//
// Landing (§6.4) mirrors the imessage capture seam exactly: deterministic
// candidate id (idempotent), assertionKind externally_sourced, status
// 'in_review' with a force_review gate_result (source adapter:gmail — no
// auto-canonization), memory.proposed event, content-free audits. Dedupe
// (§6.6): the deterministic id kills redelivery dupes; an identical
// (sender, amount, dueDate) triple within 72h is a noop;
// max_candidates_per_day caps the lane (breaches audited, content-free).
//
// PRIVACY (§7): bodies exist in-memory during sync ONLY; the subject is the
// single text field that survives — bounded, redacted, allowlist senders
// only. Nothing else from the body is persisted anywhere.

import { recordAudit, type SqlExecutor } from "../actions/audit.js";
import { acceptEvent, type EventStoreExecutor } from "../events/store.js";
import { deterministicCandidateId } from "../extraction/service.js";
import { normalizeTemporalExpression } from "../extraction/temporal/normalizer.js";
import type { MemoryCandidateContract, TemporalProvenance } from "../memory/candidate-contract.js";
import { redactContent } from "../imessage/redact.js";
import type { NormalizedGmailMessage } from "./sync.js";

/** The extraction input: the sync-normalized message (content-free metadata + bounded text). */
type GmailMessage = NormalizedGmailMessage;

/** Provenance promptVersion tag for the deterministic gmail extraction lane. */
export const GMAIL_EXTRACT_PROMPT_VERSION = "gmail-extract-v1";
/** §4.4/§6: subject survives ONLY bounded to 120 chars, after redaction. */
export const GMAIL_SUBJECT_LIMIT = 120;
/** §6: textPlain extraction surface cap (bodies are never persisted anyway). */
export const GMAIL_TEXT_PLAIN_LIMIT = 2000;
/** §6.6: identical (sender, amount, dueDate) inside this window = noop. */
export const GMAIL_EXTRACT_DEDUPE_WINDOW_MS = 72 * 60 * 60 * 1000;

// ------------------------------------------------------------- sender policy

/** Glob → anchored regex over a normalized (lowercased) From address. */
function senderGlobToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[^@\\s]+");
  return new RegExp(`^${escaped}$`);
}

/**
 * §5.1 sender policy: does the message's From address match any
 * extract_senders glob? Matching happens on the full normalized address
 * (so `billing@*`, `*@stripe.com`, and exact `billing@acme.com` all work).
 */
export function senderMatchesExtraction(
  message: Pick<GmailMessage, "from" | "fromDomain">,
  patterns: readonly string[],
): boolean {
  const address = normalizeFromAddress(message.from);
  if (address === null) return false;
  return patterns.some((pattern) => senderGlobToRegExp(pattern).test(address));
}

/** "Name <user@domain>" / "user@domain" → lowercase "user@domain"; null when unparseable. */
export function normalizeFromAddress(from: string | null): string | null {
  if (typeof from !== "string") return null;
  const angle = /<([^<>@\s]+@[^<>\s]+)>/.exec(from);
  const raw = angle !== null ? angle[1]! : from.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(raw)) return null;
  return raw.toLowerCase();
}

// ------------------------------------------------------------- extractors

/** First `$X` amount in cents (deterministic: first match wins); null when none. */
export function extractAmountCents(text: string): number | null {
  const m = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/.exec(text);
  if (m === null) return null;
  const value = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * Deterministic US slash-date pre-step ("10/01/2026", "10/1/26") → ISO
 * YYYY-MM-DD, so the temporal normalizer (which has no slash-date rule)
 * still resolves bill-mail dates server-side. Two-digit years roll forward
 * within 50 years of the anchor. Invalid civil dates yield null.
 */
export function slashDateToIso(text: string, anchorYear: number): string | null {
  const m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(text);
  if (m === null) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (m[3]!.length === 2) {
    const pivot = (anchorYear + 50) % 100;
    year = year <= pivot ? anchorYear - (anchorYear % 100) + year : anchorYear - (anchorYear % 100) - 100 + year;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface DuePhrase {
  /** Verbatim expression handed to the deterministic normalizer. */
  readonly expression: string;
  readonly kind: "due-by" | "due-on" | "past-due";
}

/**
 * Pay-by phrases (§6.3), typed out: "due by DATE", "pay $X by DATE",
 * "due DATE", "past due". Extraction is regex-only; RESOLUTION is the
 * normalizer's (never a guess — ambiguous stays ambiguous).
 */
function findDuePhrases(text: string): DuePhrase[] {
  const phrases: DuePhrase[] = [];
  // "due by DATE", "pay $X by DATE", "submit before DATE" — a bounded gap
  // between verb and preposition keeps "$120.00" inside "pay $120.00 by"
  // (periods included; the gap never crosses a newline or semicolon).
  const by = /\b(?:due|pay(?:ment)?|submit|remit)\b[^;\n]{0,40}?\b(?:by|before|until|on)\s+([A-Za-z0-9,/.\- ]{3,32}?)(?=[.,;:!)\n]|$)/gi;
  for (const m of text.matchAll(by)) {
    const expression = m[1]!.trim();
    if (expression.length > 0) phrases.push({ expression, kind: "due-by" });
  }
  const dueOn = /\bdue\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\d{4}-\d{2}-\d{2})/i;
  const on = dueOn.exec(text);
  if (on !== null) phrases.push({ expression: on[1]!.trim(), kind: "due-on" });
  if (/\bpast[ -]due\b/i.test(text)) phrases.push({ expression: "past due", kind: "past-due" });
  return phrases;
}

/** One deterministic extraction output — typed fields only (§6.3). */
export interface GmailCommitmentExtraction {
  readonly kind: "commitment";
  /** fromDomain (§6.3 counterparty). */
  readonly counterparty: string;
  readonly amountCents: number | null;
  readonly currency: "USD";
  /** Resolved ISO date (YYYY-MM-DD) or null (ambiguous/unsupported). */
  readonly dueDate: string | null;
  readonly pastDue: boolean;
  /** Bounded + redacted subject — the ONLY surviving text field (§4.4/§7.3). */
  readonly subject: string;
  /** Deterministic temporal block (raw expression + server-side resolution). */
  readonly temporal: TemporalProvenance;
}

export interface ExtractCandidatesOptions {
  /** Extraction allowlist globs (§5.1); absent/empty → no candidates ever. */
  readonly extractSenders?: readonly string[];
  /** Anchor timezone for date resolution (extraction lane convention). */
  readonly anchorTimezone?: string;
}

export interface GmailExtractionResult {
  /** 0 or 1 commitment candidate per message (deterministic-first, v1). */
  readonly candidates: readonly GmailCommitmentExtraction[];
  /** True when the sender matched the extraction allowlist. */
  readonly senderAllowlisted: boolean;
}

/**
 * Deterministic extraction for one message (§6). NON-allowlist senders get
 * zero candidates — they contribute content-free metadata events only
 * (test matrix §13.6). Pure: same input + anchor → same output.
 */
export function extractCandidates(
  message: GmailMessage,
  opts: ExtractCandidatesOptions = {},
): GmailExtractionResult {
  const patterns = opts.extractSenders ?? [];
  if (!senderMatchesExtraction(message, patterns)) {
    return { candidates: [], senderAllowlisted: false };
  }

  const subject = boundedSubject(message.subject);
  const body = (message.textPlain ?? "").slice(0, GMAIL_TEXT_PLAIN_LIMIT);
  const surface = `${subject}\n${body}`;

  const amountCents = extractAmountCents(surface);
  const phrases = findDuePhrases(surface);
  // Anchor: the message's internalDate (server-side only); a missing/
  // unparsable internalDate anchors at the epoch — deterministic, and
  // Gmail essentially always supplies internalDate.
  const anchorTime = message.internalDateIso ?? "1970-01-01T00:00:00.000Z";
  const anchorTimezone = opts.anchorTimezone ?? "UTC";

  let temporal: TemporalProvenance | null = null;
  let pastDue = false;
  for (const phrase of phrases) {
    if (phrase.kind === "past-due") {
      pastDue = true;
      continue;
    }
    if (temporal !== null) continue;
    // Slash dates: convert to ISO first so the normalizer resolves them.
    const slashIso = slashDateToIso(phrase.expression, new Date(anchorTime).getUTCFullYear());    const expression = slashIso !== null
      ? phrase.expression.replace(/\b\d{1,2}\/\d{1,2}\/(\d{2}|\d{4})\b/, slashIso)
      : phrase.expression;
    const resolved = normalizeTemporalExpression({ expression, anchorTime, anchorTimezone });
    // §7.3 defense: the temporal block's raw expression is bounded (32) and
    // redacted before it can ride into the candidate payload.
    const sanitized =
      resolved.rawExpression === null
        ? resolved
        : { ...resolved, rawExpression: redactContent(resolved.rawExpression.slice(0, 32)) };
    if (sanitized.resolutionStatus === "resolved" && sanitized.normalizedTime !== null) {
      temporal = sanitized;
    } else if (sanitized.resolutionStatus === "ambiguous" && temporal === null) {
      temporal = sanitized; // keep ambiguity honestly; a later phrase may resolve
    }
  }

  // §6 trigger set ("due by DATE", "pay $X by DATE", "amount due $X",
  // "past due"): a resolved due date, a past-due marker, or an explicit
  // amount-due phrase. A bare "$5" with no due language is NOT a trigger.
  const amountDuePhrase = /\b(?:amount|balance|total)\s+(?:due|payable)\b/i.test(surface);
  if (temporal?.resolutionStatus !== "resolved" && !pastDue && !amountDuePhrase) {
    return { candidates: [], senderAllowlisted: true };
  }

  const candidate: GmailCommitmentExtraction = {
    kind: "commitment",
    counterparty: message.fromDomain ?? "unknown",
    amountCents,
    currency: "USD",
    dueDate: temporal?.normalizedTime ?? null,
    pastDue,
    subject,
    temporal: temporal ?? normalizeTemporalExpression({ expression: null, anchorTime, anchorTimezone }),
  };
  return { candidates: [candidate], senderAllowlisted: true };
}

/** §4.4: 120-char bound, redacted, never null (untitled → ""). */
function boundedSubject(subject: string | null): string {
  return redactContent((subject ?? "").slice(0, GMAIL_SUBJECT_LIMIT));
}

// ------------------------------------------------------------- landing

/** Commitment candidate payload — mirrors the extraction lane's shape (M5B). */
export interface GmailCommitmentCandidatePayload {
  readonly kind: "commitment";
  readonly direction: null;
  readonly counterpartyText: string;
  /** Typed-field composite ONLY — free body text never lands (§6.3). */
  readonly description: string;
  readonly temporal: TemporalProvenance;
  readonly commitmentState: "active";
  readonly confidence: number;
  /** Gmail-bounded extras (typed, §6.3). */
  readonly amount: { readonly cents: number | null; readonly currency: "USD" } | null;
  readonly pastDue: boolean;
  readonly subject: string;
  readonly metadata: {
    readonly gmailSource: string;
    readonly messageId: string;
    readonly threadId: string;
    readonly fromDomain: string | null;
    readonly senderSha256: string | null;
  };
}

/** Description from typed fields only (hostile content cannot ride through). */
export function commitmentDescription(extraction: GmailCommitmentExtraction): string {
  const amount = extraction.amountCents === null
    ? null
    : `$${(extraction.amountCents / 100).toFixed(2)}`;
  const due = extraction.dueDate ?? (extraction.pastDue ? "past due" : "an unresolved date");
  const amountPart = amount === null ? "" : ` of ${amount}`;
  return `Bill from ${extraction.counterparty}${amountPart}, due ${due}`.replace(/\s+/g, " ").trim();
}

const INSERT_GMAIL_CANDIDATE_SQL = `
  INSERT INTO memory_candidates
    (id, domain_id, proposed_class, assertion_kind, payload, provenance,
     gate_result, status, created_at, updated_at)
  VALUES ($1, $2::uuid, 'commitment', 'externally_sourced', $3::jsonb, $4::jsonb,
          $5::jsonb, 'in_review', $6::timestamptz, $6::timestamptz)
  ON CONFLICT (id) DO NOTHING
  RETURNING id
`;

/** ESCALATE-style force-review marker: gmail candidates ALWAYS queue (§6.4). */
function forceReviewGateResult(now: Date): string {
  return JSON.stringify({
    version: 1,
    action: "in_review",
    gate: null,
    reason: "force_review_source",
    message:
      "Gmail extraction candidates always route to review; no auto-canonization (gmail-sensor §6.4).",
    forceReview: { source: "adapter:gmail", decidedAt: now.toISOString() },
    write: null,
    review: null,
  });
}

export interface LandGmailCandidatesOptions {
  readonly now: Date;
  readonly actor?: string;
  /** §6.6 daily cap; absent → unlimited (tests/small callers). */
  readonly maxCandidatesPerDay?: number | null;
  readonly anchorTimezone?: string;
}

export interface LandedGmailCandidate {
  readonly candidateId: string;
  /** False when the deterministic id already existed (redelivery no-op). */
  readonly inserted: boolean;
  readonly memoryProposedEventId: string | null;
  /** Why nothing landed (dedupe/cap) — ids/counts only. */
  readonly skippedReason?: "duplicate-triple" | "daily-cap";
}

const GMAIL_EXTRACT_ACTOR = "system:gmail-sync";

function extractAudit(
  db: SqlExecutor,
  action: string,
  outputs: Record<string, unknown>,
  actor: string,
): Promise<void> {
  return recordAudit(db, {
    actor,
    action,
    reversible: true,
    outputsRef: JSON.stringify(outputs),
  });
}

/** UTC-day start of `now` (the §6.6 cap window). */
function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

async function gmailCandidatesToday(db: SqlExecutor, dayStart: string): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS n FROM memory_candidates
      WHERE payload->'metadata'->>'gmailSource' = 'adapter:gmail'
        AND created_at >= $1::timestamptz`,
    [dayStart],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function duplicateTripleCandidate(
  db: SqlExecutor,
  message: GmailMessage,
  extraction: GmailCommitmentExtraction,
  windowStart: string,
): Promise<string | null> {
  const result = await db.query(
    `SELECT id FROM memory_candidates
      WHERE payload->'metadata'->>'gmailSource' = 'adapter:gmail'
        AND payload->'metadata'->>'senderSha256' = $1
        AND (payload->'amount'->>'cents') = $2
        AND (payload->>'dueDate') = $3
        AND created_at >= $4::timestamptz
      LIMIT 1`,
    [
      message.senderSha256 ?? "",
      extraction.amountCents === null ? null : String(extraction.amountCents),
      extraction.dueDate ?? "",
      windowStart,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? null : String(row.id);
}

/**
 * Lands extracted candidates through the EXISTING pipeline seams (§6.4):
 * deterministic id (redelivery-idempotent), status 'in_review' with the
 * force_review gate marker, memory.proposed event (refs only), audit.
 * §6.6 dedupe: identical (sender, amount, dueDate) within 72h = noop;
 * maxCandidatesPerDay caps the lane per UTC day.
 */
export async function landGmailCandidates(
  db: EventStoreExecutor,
  message: GmailMessage,
  extraction: GmailCommitmentExtraction,
  sourceEventId: string,
  opts: LandGmailCandidatesOptions,
): Promise<LandedGmailCandidate> {
  const actor = opts.actor ?? GMAIL_EXTRACT_ACTOR;

  if (opts.maxCandidatesPerDay != null && opts.maxCandidatesPerDay > 0) {
    const today = await gmailCandidatesToday(db, utcDayStart(opts.now));
    if (today >= opts.maxCandidatesPerDay) {
      await extractAudit(db, "gmail.extract.capped", {
        candidatesToday: today,
        cap: opts.maxCandidatesPerDay,
      }, actor);
      return { candidateId: "", inserted: false, memoryProposedEventId: null, skippedReason: "daily-cap" };
    }
  }

  const dedupeWindowStart = new Date(opts.now.getTime() - GMAIL_EXTRACT_DEDUPE_WINDOW_MS).toISOString();
  const dupe = await duplicateTripleCandidate(db, message, extraction, dedupeWindowStart);
  if (dupe !== null) {
    await extractAudit(db, "gmail.extract.deduped", {
      kind: "triple-72h",
      candidateId: dupe,
    }, actor);
    return { candidateId: dupe, inserted: false, memoryProposedEventId: null, skippedReason: "duplicate-triple" };
  }

  const domain = await db.query(`SELECT id FROM domains WHERE key = $1`, ["personal"]);
  const domainId = domain.rows[0]?.id;
  if (domainId === undefined) {
    throw new Error("landGmailCandidates: personal domain is not seeded");
  }

  const payload: GmailCommitmentCandidatePayload = {
    kind: "commitment",
    direction: null,
    counterpartyText: extraction.counterparty,
    description: commitmentDescription(extraction),
    temporal: extraction.temporal,
    commitmentState: "active",
    confidence: 1,
    amount: { cents: extraction.amountCents, currency: extraction.currency },
    pastDue: extraction.pastDue,
    subject: extraction.subject,
    metadata: {
      gmailSource: "adapter:gmail",
      messageId: message.id,
      threadId: message.threadId,
      fromDomain: message.fromDomain,
      senderSha256: message.senderSha256,
    },
  };
  const contract: MemoryCandidateContract = {
    proposedClass: "commitment",
    assertionKind: "externally_sourced",
    domainId: "personal",
    payload: {
      ...payload,
      dueDate: extraction.dueDate,
    },
    provenance: {
      sourceEventId,
      runId: null,
      model: null,
      promptVersion: GMAIL_EXTRACT_PROMPT_VERSION,
    },
    confidence: 1,
  };
  const candidateId = deterministicCandidateId(contract);

  const inserted = await db.query(INSERT_GMAIL_CANDIDATE_SQL, [
    candidateId,
    String(domainId),
    JSON.stringify(contract.payload),
    JSON.stringify(contract.provenance),
    forceReviewGateResult(opts.now),
    opts.now.toISOString(),
  ]);
  if (inserted.rows[0] === undefined) {
    // Deterministic-id conflict: exact redelivery — idempotent by construction.
    await extractAudit(db, "gmail.extract.deduped", {
      kind: "deterministic-id",
      candidateId,
      sourceEventId,
    }, actor);
    return { candidateId, inserted: false, memoryProposedEventId: null };
  }

  // memory.proposed — references only, never subject/body (§7.3).
  const accepted = await acceptEvent(db, {
    type: "memory.proposed",
    schemaVersion: 1,
    source: "internal",
    externalId: `memory-candidate:${candidateId}`,
    occurredAt: opts.now.toISOString(),
    domainId: "personal",
    sensitivity: "sensitive",
    payload: {
      candidateId,
      proposedClass: "commitment",
      assertionKind: "externally_sourced",
      kind: "commitment",
      counterparty: extraction.counterparty,
      amountCents: extraction.amountCents,
      dueDate: extraction.dueDate,
      pastDue: extraction.pastDue,
      confidence: 1,
      sourceEventId,
      model: null,
      promptVersion: GMAIL_EXTRACT_PROMPT_VERSION,
    },
    runId: null,
  }, { now: () => opts.now });

  await extractAudit(db, "gmail.extract.proposed", {
    candidateId,
    sourceEventId,
    messageId: message.id,
    hasAmount: extraction.amountCents !== null,
    dueDate: extraction.dueDate,
  }, actor);
  return { candidateId, inserted: true, memoryProposedEventId: accepted.envelope.id };
}
