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

// ------------------------------------------- explicit correction intake §9

/**
 * A structured day-state correction (quality fix 2026-09-23 §9): explicit
 * mismatch feedback like "you missed X", "I skipped the 3pm thing",
 * "I did them in a different order". Small fixed taxonomy — deliberately
 * NOT a generic behavior classifier; every pattern below requires a
 * first-person correction or a direct "you missed/your picture" address
 * so ordinary chat ("I skipped leg day" gossip) never rides this lane.
 */
export type CalibrationCorrectionCategory =
  | "planned_not_observed"
  | "observed_but_missing"
  | "wrong_sequence"
  | "wrong_priority"
  | "wrong_completion_state"
  | "source_coverage_gap"
  | "overclaim";

export interface CalibrationCorrectionMatch {
  readonly category: CalibrationCorrectionCategory;
}

/**
 * Ordered most-specific-first; first match wins. Order-priority:
 * sequence/priority/completion claims are more specific than the broad
 * planned-not-observed denial, and "you missed" (observed gap) is the
 * canonical correction the daily check invites.
 */
const CORRECTION_GRAMMARS: readonly {
  readonly category: CalibrationCorrectionCategory;
  readonly re: RegExp;
}[] = [
  { category: "wrong_sequence", re: /\b(?:in |the )?(?:a )?different order|out of order|wrong order|didn'?t follow the (?:calendar )?order|sequence was (?:wrong|off)/i },
  { category: "wrong_priority", re: /\b(?:the )?(?:biggest|most important|main) (?:thing|part) was|what (?:actually )?mattered was|priority was (?:wrong|off)/i },
  { category: "source_coverage_gap", re: /\byour (?:picture|info|data|sources) (?:is |are )?(?:wrong|incomplete|missing)|you can'?t see\b|not connected/i },
  { category: "observed_but_missing", re: /\byou missed\b|you don'?t (?:know|mention|have)|left out|didn'?t show up (?:in|on) your|your picture (?:missed|left)|\bi did (?:this|that|it) instead\b|\bi (?:did|worked on|spent) .+ instead\b/i },
  { category: "wrong_completion_state", re: /\b(?:wasn'?t|isn'?t|not) (?:actually )?(?:done|finished|complete[dt]?)|i didn'?t finish|still in progress|incomplete\b/i },
  { category: "overclaim", re: /\bthat didn'?t happen|i (?:never|didn'?t) (?:do|did|complete|completed|work on|finish)\b|you claimed/i },
  { category: "planned_not_observed", re: /\bi (?:didn'?t|did not|never) (?:do|attend|go to|make it to)|\bi skipped\b|\bskipped the\b|\bnothing (?:after|before) \d/i },
];

/**
 * Parse an explicit calibration correction from the current inbound turn's
 * text (trimmed). null = not a correction — the orchestrator falls through
 * unchanged. Never reads history, never guesses: every pattern matches the
 * CURRENT text only (never-from table inherited from the rating parser).
 */
export function parseCalibrationCorrection(text: string): CalibrationCorrectionMatch | null {
  const trimmed = text.trim();
  if (trimmed.length < 8) return null;
  for (const grammar of CORRECTION_GRAMMARS) {
    if (grammar.re.test(trimmed)) return { category: grammar.category };
  }
  return null;
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

/**
 * Correction ack (§8/§9): acknowledge the structured correction, hold the
 * memory boundary exactly like the miss ack — the correction improves the
 * reconstructed day first; it never becomes semantic memory implicitly.
 */
export function renderCorrectionAck(): string {
  return 'Correction logged for today\'s picture — that\'s exactly what keeps my world model honest. (Say "remember …" if you want it kept as a memory.)';
}

// ------------------------------------------ skipped-occurrence time helpers

/** A local wall-clock reference parsed out of a skip correction ("3pm"). */
export interface SkippedTimeRef {
  readonly hour: number;
  readonly minute: number;
}

const TIME_REF_RE = /\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

/**
 * Extract an explicit local wall-clock time ("the 3pm thing", "at 12:30")
 * from a skip correction. null when no unambiguous time is present —
 * 24h-style bare numbers ("the 15 thing") deliberately do NOT parse (too
 * collision-prone with counts); am/pm or H:MM forms only.
 */
export function parseSkippedTimeRef(text: string): SkippedTimeRef | null {
  const match = TIME_REF_RE.exec(text.trim());
  if (match === null) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = match[3]!.toLowerCase() === "pm";
  if (pm && hour !== 12) hour += 12;
  if (!pm && hour === 12) hour = 0;
  return { hour, minute };
}

/**
 * True when the event's start instant lands at the referenced LOCAL
 * wall-clock time (owner timezone supplied by the caller — this module
 * stays free of config imports). Deterministic exact match: "3pm" means
 * the 3:00 PM event, not "somewhere in the afternoon".
 */
export function eventStartsAtLocalTime(
  startIso: string,
  time: SkippedTimeRef,
  timeZone: string,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(new Date(startIso));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour === time.hour && minute === time.minute;
}
