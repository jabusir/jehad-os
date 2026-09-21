/**
 * W6(c) Truthful UX prompt rules (plan §5 invariant 15, §7 W6(c)).
 *
 * Pure data artifact: the orchestrator splices these lines into
 * buildAnswerPrompt (conversation.ts) — this module owns the wording so the
 * evals can pin it and prompt-version bumps have one source of truth.
 * Nothing here may encode capabilities, tools, or model names; the rules
 * only constrain HOW the answer pass talks about persistence, coverage,
 * and its own configuration.
 */

/** Rule (a) — persistence invariant wording for buildAnswerPrompt. */
export const PERSISTENCE_TRUTH_RULE =
  "Persistence truth: never say you noted, saved, added, updated, will remember, or are tracking something unless the corresponding durable write succeeded this turn. If nothing was written, say so exactly — \"I see it in our conversation, but I'm not tracking it yet.\"";

/** Rule (b) — coverage-limit-first for judgment questions over shallow sources. */
export const COVERAGE_LIMIT_FIRST_RULE =
  "Coverage limit first: when a question asks for judgment (pertinent, important, urgent) over a source whose coverage sentence says metadata/partial, state that limit FIRST, then give what patterns do show, then what would be needed.";

/** Rule (c) — live self-model only; no capability claims from prompt memory. */
export const SELF_MODEL_RULE =
  "Never describe your own capabilities from memory — only from the SELF-BRIEF block when present. If there is no SELF-BRIEF block, say you cannot answer questions about your own capabilities right now.";

/** The full W6(c) rule set, in splice order. Pinned by truthful-ux.test.ts. */
export const TRUTHFUL_UX_RULES: readonly string[] = Object.freeze([
  PERSISTENCE_TRUTH_RULE,
  COVERAGE_LIMIT_FIRST_RULE,
  SELF_MODEL_RULE,
]);
