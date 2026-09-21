// Calibration verbs — deterministic rating/miss grammar over iMessage
// (calibration plan §8 miss intake, §17 never-route-ambiguous-prose,
// §26 multi-item ambiguity). This module is the pure parsing/decision
// seam the orchestrator (conversation.ts) consults BEFORE any model
// call: a bare 1–5 rating (optionally "rate [today] "-prefixed) is
// resolved deterministically; EVERYTHING else returns null and falls
// through to the conversation path unchanged — ambiguous prose never
// rides the calibration lane (§17). The parser's ONLY input is the
// current inbound turn's text (never-from table inherited verbatim —
// assistant_output, tool_output/DATA, retrieved_external_data, stored
// HISTORY can never reach it). ZERO model calls, ZERO DB access: the
// open-item/period facts arrive as booleans and the storing itself is
// the orchestrator's job (C1's calibration service).

// ------------------------------------------------------------- rating

/** The 1–5 accuracy scale a calibration check-in rates on. */
export type CalibrationRating = 1 | 2 | 3 | 4 | 5;

/** A parsed rating — scope is always "day" (the current period) in v1. */
export interface CalibrationRatingMatch {
  readonly rating: CalibrationRating;
  readonly scope: "day";
}

/**
 * The strict rating grammar (§17), applied to the TRIMMED current
 * inbound text, case-insensitive:
 *
 *   /^(?:rate(?:\s+today)?\s*)?([1-5])[.!]*$/
 *
 * Accepts: bare "1".."5" (single char), "rate 3", "rate today 4",
 * "Rate 5!" — with any mix of leading `rate`/`rate today` and trailing
 * `.`/`!` runs. Rejects everything else, DELIBERATELY: multi-digit
 * ("45"), out-of-scale ("0", "6"), fractions ("rate 4/5"), other verbs
 * ("rating 3"), time-like text ("3pm" must NEVER parse as a rating —
 * pinned), and trailing prose ("1 very inaccurate" — §17 says that is
 * chat, not calibration). Only `.`/`!` are tolerated trailing; `?` and
 * `*` are NOT (a "5?" is a question, not a rating — it falls through).
 */
const RATING_GRAMMAR = /^(?:rate(?:\s+today)?\s*)?([1-5])[.!]*$/i;

/**
 * Parse a calibration rating from the current inbound turn's text.
 * null = not a rating; the orchestrator falls through to the
 * conversation path unchanged. Never guesses, never reads history.
 */
export function parseCalibrationRating(text: string): CalibrationRatingMatch | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const match = RATING_GRAMMAR.exec(trimmed);
  if (match === null) return null;
  return { rating: Number(match[1]) as CalibrationRating, scope: "day" };
}

// ------------------------------------------------------------- miss intake

/** Facts the orchestrator assembles (C1's service owns the queries). */
export interface MissEligibilityInput {
  /** An open calibration item exists for the principal. */
  readonly openItem: boolean;
  /**
   * The principal already submitted a rating this period. This does
   * NOT disqualify (§8): a miss report after a rating is legitimate —
   * the user rates the day's picture, THEN observes something missed.
   */
  readonly rated: boolean;
  /** The inbound arrived inside the item's response period. */
  readonly withinPeriod: boolean;
  /** The text matched some OTHER deterministic pre-pass first. */
  readonly isOtherCommand: boolean;
}

export type MissEligibility = "eligible" | "not-eligible";

/**
 * Decision helper for treating a prose inbound as a miss report (§8):
 * eligible iff an open calibration item exists for the principal's
 * current period AND the message didn't match any other deterministic
 * pre-pass (control grammar, calendar actions, …). `rated` is accepted
 * by design — see MissEligibilityInput.rated — and is deliberately
 * unused here so the truth table stays honest about it.
 */
export function missEligibility(input: MissEligibilityInput): MissEligibility {
  void input.rated; // rating already logged never disqualifies a miss (§8)
  return input.openItem && input.withinPeriod && !input.isOtherCommand
    ? "eligible"
    : "not-eligible";
}

// ------------------------------------------------------------- honest replies

/** Ack bound (contract-style reply cap for the rating ack). */
export const CALIBRATION_ACK_CHAR_LIMIT = 120;
/** Miss-ack bound — roomier because it carries the memory-boundary note. */
export const CALIBRATION_MISS_ACK_CHAR_LIMIT = 200;

/**
 * Rating ack — deterministic per rating, honest about what was logged:
 * the rating and its scope, nothing more. Zero model calls, so it
 * cannot paraphrase the number into a lie.
 */
export function renderCalibrationAck(rating: CalibrationRating): string {
  return `Logged — ${rating}/5 for today's picture. This is exactly the calibration signal I need.`;
}

/**
 * Miss ack (§8): acknowledge the miss AND hold the memory boundary — a
 * miss report is calibration signal, not a stored memory; if the user
 * wants it kept, that is an explicit "remember …" away.
 */
export function renderMissedAck(): string {
  return 'Logged as a miss — that helps me see what I\'m not observing. (Say "remember …" if you want it kept as a memory.)';
}

/**
 * Multi-item ambiguity (§26): more than one calibration item is open
 * and the deterministic path can't pick. Safe default is the clarify
 * message — the orchestrator MAY still store the rating against the
 * LATEST open item, but this reply never claims which one landed.
 */
export function renderAmbiguousCalibration(): string {
  return "Something went wrong tracking today's check-in — more than one is open. Reply with the rating anyway and I'll sort it.";
}
