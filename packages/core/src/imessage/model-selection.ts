// packages/core/src/imessage/model-selection.ts — pure pass-model
// resolution + deterministic answer-depth classification (W3).
//
// Model selection is data, not model judgment: pass overrides come from
// `gateway.passes` policy; anything unconfigured falls back to the
// principal's budgeted model. Escalation is retry-on-parse-failure ONLY:
// the route pass escalates to its fallback model when structured parsing
// of the route output fails — never on content. This module is pure and
// hermetic (no IO, no provider SDKs); the conversation lane owns wiring.
//
// W3 invariants (plan §5-1, §7 W3):
//   - Policy chooses models; models never choose models. The depth
//     classifier maps features → a TIER ENUM ONLY. No model id, provider
//     name, or route-output string beyond the fixed feature set can
//     influence the tier (adversarially pinned in model-selection.test.ts).
//   - Tier → model resolution is a pure lookup over policy + the
//     principal's model. DEEP falls back to STANDARD's resolution, never
//     straight to an unconfigured expensive default.

import type { GatewayPassesPolicy } from "../policy/ceiling.js";

/**
 * Resolves the per-pass model ids for one conversation model call:
 * pass override ?? principalModel; routeFallback is null when
 * unconfigured (no escalation model — the caller does not retry).
 * (Legacy single-answer resolution — the tiered path is
 * `answerModelForTier`; the orchestrator migrates at integration.)
 */
export function resolvePassModels(input: {
  principalModel: string;
  passes: GatewayPassesPolicy | null;
}): { route: string; answer: string; routeFallback: string | null } {
  return {
    route: input.passes?.route?.model ?? input.principalModel,
    answer: input.passes?.answer?.model ?? input.principalModel,
    routeFallback: input.passes?.route_fallback?.model ?? null,
  };
}

/**
 * Whether the route pass should escalate to its fallback model. True only
 * when structured parsing of the route output failed — content NEVER
 * triggers escalation (the route text is accepted verbatim as input and
 * unused by design, so refusal-ish or garbage-looking output that parsed
 * fine cannot burn a second model call).
 */
export function shouldEscalateRoute(parseFailed: boolean): boolean {
  return parseFailed;
}

// ------------------------------------------------------------ answer tiers

/** W3 answer-depth tiers (plan §7 W3 / §8). FAST/STANDARD/DEEP only —
 *  `answer_fallback` is a provider-failure retry model, not a depth. */
export type AnswerTier = "fast" | "standard" | "deep";

/** Features the depth classifier consumes. Every field is computed by
 *  deterministic caller code from the turn (user text length, parsed
 *  route tool set, DATA-block count) — never raw model output text. */
export interface AnswerDepthFeatures {
  /** Route-selected read tools (parsed route JSON `tools`/`tool` value;
   *  used ONLY for emptiness — route-emitted strings cannot name a tier,
   *  model, or provider through this field). */
  readonly tools: readonly string[];
  /** Character length of the principal's message. */
  readonly textLength: number;
  /** The message asks a question / seeks information (deterministic
   *  marker detection by the caller). */
  readonly questionMarkers: boolean;
  /** Number of DATA blocks assembled into the answer-pass context. */
  readonly dataBlocks: number;
  /** The message asks for synthesis/explanation (see
   *  `hasSynthesisMarkers`); optional for callers that have not wired
   *  marker detection yet — absent means "no synthesis markers". */
  readonly synthesisMarkers?: boolean;
}

/** Synthesis-class markers (plan §7 W3: "full 'what's going on' assembly,
 *  'why' chains, weekly reflection"). Word-boundary anchored so model-
 *  emitted prose can never smuggle a marker through a substring. */
const SYNTHESIS_MARKER_PATTERNS: readonly RegExp[] = [
  /\bwhat'?s going on\b/,
  /\bwhat'?s happening\b/,
  /\bwhats going on\b/,
  /\bwhere things stand\b/,
  /\bthe one thing\b/,
  /\bwhy\b/,
  /\bexplain\b/,
  /\bprioriti[sz]e\b/,
  /\bprioriti[sz]ation\b/,
  /\bwalk me through\b/,
  /\bhelp me understand\b/,
  /\bmake sense of\b/,
  /\btie(?:s|d)? (?:this|it) (?:to|together|back)\b/,
  /\bhow does (?:this|that) relate\b/,
  /\bsynthesi[sz]e\b/,
  /\bbreak (?:this|it) down\b/,
];

/** Deterministic synthesis-marker detection over the principal's text.
 *  Curly apostrophes are normalized; matching is case-folded. */
export function hasSynthesisMarkers(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  return SYNTHESIS_MARKER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function clampCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * Deterministic FAST/STANDARD/DEEP classification (W3). Pure: same
 * features → same tier, always. Rules, evaluated in order:
 *
 * 1. DEEP iff `synthesisMarkers` OR (`dataBlocks >= 2` AND
 *    `questionMarkers`) — a composite, multi-block question or an
 *    explicit synthesis/explanation ask needs the reasoning tier. DEEP
 *    dominates: a short "why?" is still a synthesis ask.
 * 2. FAST iff tools empty AND `textLength < 80` AND no question markers —
 *    acks and plain chat.
 * 3. STANDARD otherwise (default conversation turn).
 *
 * The classifier returns a tier ENUM ONLY — never a model id or provider
 * name (invariant: policy chooses models). Route output influences the
 * outcome solely through the `tools` feature's emptiness; no model-emitted
 * string can reach further than the fixed feature set.
 */
export function classifyAnswerDepth(features: AnswerDepthFeatures): AnswerTier {
  const questionMarkers = features.questionMarkers === true;
  const synthesisMarkers = features.synthesisMarkers === true;
  const dataBlocks = clampCount(features.dataBlocks);
  const textLength =
    Number.isFinite(features.textLength) && features.textLength >= 0
      ? features.textLength
      : Number.POSITIVE_INFINITY; // untrustworthy length → never FAST
  const toolsEmpty = features.tools.length === 0;

  if (synthesisMarkers || (dataBlocks >= 2 && questionMarkers)) return "deep";
  if (toolsEmpty && textLength < 80 && !questionMarkers) return "fast";
  return "standard";
}

/**
 * Tier → answer model resolution (W3). FAST/DEEP fall back per plan §7 W3;
 * STANDARD additionally honors the legacy `answer` override so existing
 * policy.yaml files keep their single-answer pin when tiers land:
 *
 *   fast     → answer_fast ?? principalModel
 *   standard → answer_standard ?? legacy answer ?? principalModel
 *   deep     → answer_deep ?? (standard's resolution)
 *
 * `answer_fallback` is NOT a tier — see `answerFallbackModel`.
 */
export function answerModelForTier(
  passes: GatewayPassesPolicy | null,
  principalModel: string,
  tier: AnswerTier,
): string {
  if (tier === "fast") {
    return passes?.answer_fast?.model ?? principalModel;
  }
  const standard =
    passes?.answer_standard?.model ?? passes?.answer?.model ?? principalModel;
  if (tier === "deep") {
    return passes?.answer_deep?.model ?? standard;
  }
  return standard;
}

/**
 * The answer-failure retry model (W3 `answer_fallback`): null when
 * unconfigured — the caller does not retry, mirroring routeFallback.
 */
export function answerFallbackModel(passes: GatewayPassesPolicy | null): string | null {
  return passes?.answer_fallback?.model ?? null;
}
