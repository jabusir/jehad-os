// W6-fix / Wave SV1+SV2: the send-time claim audit (docs/plans/feedback-and-self-verification.md).
//
// Research consensus (Reflexion, CRITIC, Anthropic agents): self-correction is
// only real when grounded in a verifier. Our ground truth is Postgres — one
// query from every reply. This module audits MODEL-PROSE replies against it
// before send:
//   protocol/state claims → deterministic verify → mismatch = strip + truthful
//   replacement (no retry; the DB is authoritative)
//   substantive content claims (v1: waiting-entity relations) → mismatch =
//   exactly ONE revise pass (caller-driven), then re-audit, then safe fallback.
// Deterministic replies never reach this gate — they are true by construction.

import type { QueryExecutor } from "../queries/executor.js";
import type { SelfBriefData } from "../queries/system-self-brief.js";

export interface TurnWriteFacts {
  commitmentsCreated: number;
  remindersCreated: number;
}

export interface OpenCounterparty {
  readonly name: string;
  readonly openCount: number;
}

export interface ClaimAuditFacts {
  readonly writes: TurnWriteFacts;
  /** A pending proposal exists on the thread (the offer stands). */
  readonly pendingProposal: boolean;
  readonly pendingProposalLabel: string | null;
  readonly brief: Pick<SelfBriefData, "sources"> | null;
  /** Open commitments grouped by counterparty (content-claim grounding). */
  readonly openCounterparties: readonly OpenCounterparty[];
}

export type ClaimRemediation = "deterministic_replace" | "model_revision" | "safe_fallback";

export interface ClaimFinding {
  readonly claim_type: "persistence_write" | "future_write" | "negative_pending" | "negative_access" | "waiting_relation";
  readonly original_claim: string;
  readonly verification_basis: string;
  readonly remediation: ClaimRemediation;
  readonly revision_attempted?: boolean;
  readonly revision_passed?: boolean;
}

export interface ClaimAuditResult {
  /** Text after protocol strip/replace (content mismatches still included). */
  readonly text: string;
  readonly protocolFindings: readonly ClaimFinding[];
  /** Content (waiting-relation) mismatches the caller may revise once. */
  readonly contentMismatch: {
    readonly finding: ClaimFinding;
    readonly entity: string;
  } | null;
}

const DONE_WRITE_RE =
  /\b(?:i\s+)?(?:just\s+|already\s+)?(?:have\s+|'ve\s+)?(?:tracked|captured|saved|logged|recorded|noted|completed|marked|updated|added)\b/i;
const SCHEDULED_WRITE_RE = /\b(?:i\s+)?(?:just\s+|already\s+)?(?:have\s+|'ve\s+)?(?:scheduled|booked|created|wrote)\b/i;
const AM_TRACKING_RE = /\b(?:i'?m|i am)\s+(?:now\s+)?(?:tracking|logging|recording)\b/i;
const FUTURE_WRITE_RE =
  /\b(?:i'?ll|i will|i'?m going to|going to|let me)\s+(?:track|capture|save|log|add|schedule|create|remember|note|record|bookmark)\b/i;
const NEGATIVE_PENDING_RE =
  /\bnothing(?:'s| is)?\s+(?:waiting|pending|awaiting)|\bno\s+(?:commitments?|tasks?|reminders?|to-?dos?)\s+(?:are|is)?\s*(?:open|waiting|pending|outstanding)\b/i;
const NEGATIVE_ACCESS_RE =
  /\b(?:can'?t|cannot|don'?t|do not|unable to)\s+(?:reach|access|pull|query|connect to)\s+(?:your\s+)?(calendar|gmail|inbox|emails?|memory)\b/i;
const QUESTION_RE = /\?\s*$/;
/** "nothing was captured" is a NEGATIVE statement, not a write claim — a
 *  negator in the sentence vetoes the write-claim classes. */
const NEGATION_RE =
  /\b(?:no|not|never|nothing|none|wasn'?t|was not|isn'?t|is not|didn'?t|did not|haven'?t|have not|won'?t|will not|can'?t|cannot)\b/i;
const WAITING_RELATION_RE =
  /\b(?:waiting on|waiting for|blocked on|blocked by|holding (?:up|this)|is waiting)\b/i;

function totalWrites(writes: TurnWriteFacts): number {
  return writes.commitmentsCreated + writes.remindersCreated;
}

export function auditReplyClaims(replyText: string, facts: ClaimAuditFacts): ClaimAuditResult {
  const lines = replyText.split(/\n/);
  const keptLines: string[] = [];
  const protocolFindings: ClaimFinding[] = [];
  let contentMismatch: ClaimAuditResult["contentMismatch"] = null;
  const writesTotal = totalWrites(facts.writes);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length > 240 || QUESTION_RE.test(trimmed)) {
      keptLines.push(line);
      continue;
    }
    let lineStruck = false;

    const pending = facts.pendingProposal;
    const accessSentence = trimmed.match(NEGATIVE_ACCESS_RE);
    if (accessSentence !== null) {
      const source = accessSentence[1]!.toLowerCase();
      const status =
        source === "calendar" ? facts.brief?.sources.calendar : facts.brief?.sources.gmail;
      if (status === "read") {
        protocolFindings.push({
          claim_type: "negative_access",
          original_claim: trimmed,
          verification_basis: `self-brief sources.${source} = read`,
          remediation: "deterministic_replace",
        });
        lineStruck = true;
      }
    }

    if (!lineStruck && NEGATIVE_PENDING_RE.test(trimmed) && pending) {
      protocolFindings.push({
        claim_type: "negative_pending",
        original_claim: trimmed,
        verification_basis: "interaction_threads.metadata.pendingProposal exists",
        remediation: "deterministic_replace",
      });
      lineStruck = true;
    }

    const negated = NEGATION_RE.test(trimmed);
    if (!lineStruck && !negated && (DONE_WRITE_RE.test(trimmed) || AM_TRACKING_RE.test(trimmed))) {
      if (writesTotal === 0) {
        protocolFindings.push({
          claim_type: "persistence_write",
          original_claim: trimmed,
          verification_basis: "zero rows written this turn",
          remediation: "deterministic_replace",
        });
        lineStruck = true;
      }
    }

    if (!lineStruck && SCHEDULED_WRITE_RE.test(trimmed) && !pending && facts.writes.remindersCreated === 0) {
      protocolFindings.push({
        claim_type: "persistence_write",
        original_claim: trimmed,
        verification_basis: "no calendar proposal or reminder artifact this turn",
        remediation: "deterministic_replace",
      });
      lineStruck = true;
    }

    if (!lineStruck && !negated && FUTURE_WRITE_RE.test(trimmed) && !pending && writesTotal === 0) {
      protocolFindings.push({
        claim_type: "future_write",
        original_claim: trimmed,
        verification_basis: "no pending proposal and zero rows written this turn",
        remediation: "deterministic_replace",
      });
      lineStruck = true;
    }

    // SV2 v1: waiting-relation claims about known counterparties must have an
    // open commitment to stand on.
    if (!lineStruck && contentMismatch === null && WAITING_RELATION_RE.test(trimmed)) {
      for (const cp of facts.openCounterparties) {
        if (cp.openCount > 0) continue;
        const nameToken = cp.name.split(/\s+/)[0] ?? cp.name;
        if (nameToken.length >= 3 && new RegExp(`\\b${escapeRe(nameToken)}\\b`, "i").test(trimmed)) {
          contentMismatch = {
            finding: {
              claim_type: "waiting_relation",
              original_claim: trimmed,
              verification_basis: `${cp.name} has 0 open commitments`,
              remediation: "model_revision",
            },
            entity: cp.name,
          };
          break;
        }
      }
    }

    if (!lineStruck) keptLines.push(line);
  }

  let text = keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (protocolFindings.length > 0) {
    const replacement = truthfulReplacement(facts);
    text = text.length > 0 ? `${text}\n\n${replacement}` : replacement;
  }
  return { text, protocolFindings, contentMismatch };
}

/** The action-oriented truthful line — the DB says what IS, the copy says
 *  what to do next. */
export function truthfulReplacement(facts: ClaimAuditFacts): string {
  if (facts.pendingProposal) {
    const label = facts.pendingProposalLabel ?? "proposal";
    return `Correction — that isn't done yet. Your ${label} is awaiting your yes: reply "track them" to apply it.`;
  }
  return "Correction — nothing has been written yet. I won't claim work that didn't happen; tell me to go ahead and I'll do it for real.";
}

/** Deterministic safe rendering when the revise pass fails its own re-audit. */
export function safeFallbackRendering(entity: string, facts: ClaimAuditFacts): string {
  const matches = facts.openCounterparties.filter((c) => c.openCount > 0);
  if (matches.length === 0) {
    return `Grounded answer: I have no open commitments involving ${entity}. I can't verify the rest of that answer, so I won't guess.`;
  }
  const lines = matches
    .slice(0, 4)
    .map((c) => `- ${c.name}: ${c.openCount} open`)
    .join("\n");
  return `Grounded answer — open commitments on record:\n${lines}\nI can't verify the rest of that answer, so I won't guess.`;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** DB facts for the audit, gathered at send time (turnStart = the turn's now). */
export async function collectClaimAuditFacts(
  db: QueryExecutor,
  opts: {
    readonly principalName: string;
    readonly turnStart: Date;
    readonly pendingProposal: boolean;
    readonly pendingProposalLabel: string | null;
    readonly brief: Pick<SelfBriefData, "sources"> | null;
    readonly windowMinutes?: number;
  },
): Promise<ClaimAuditFacts> {
  const windowStart = new Date(
    opts.turnStart.getTime() - (opts.windowMinutes ?? 5) * 60_000,
  ).toISOString();
  const [commitments, reminders, counterparties] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS n FROM commitments WHERE created_at >= $1::timestamptz`,
      [windowStart],
    ),
    db.query(
      `SELECT count(*)::int AS n FROM reminders
         WHERE principal = $1 AND created_at >= $2::timestamptz`,
      [opts.principalName, windowStart],
    ),
    db.query(
      `SELECT counterparty_text AS name, count(*)::int AS n
         FROM commitments WHERE status = 'open'
         GROUP BY counterparty_text ORDER BY count(*) DESC LIMIT 12`,
    ),
  ]);
  return {
    writes: {
      commitmentsCreated: Number(commitments.rows[0]?.n ?? 0),
      remindersCreated: Number(reminders.rows[0]?.n ?? 0),
    },
    pendingProposal: opts.pendingProposal,
    pendingProposalLabel: opts.pendingProposalLabel,
    brief: opts.brief,
    openCounterparties: counterparties.rows.map((r) => ({
      name: String(r.name),
      openCount: Number(r.n),
    })),
  };
}
