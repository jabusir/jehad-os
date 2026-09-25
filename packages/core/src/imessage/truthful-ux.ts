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

/** Rule (d) — the model never authors protocol: no invented command words. */
export const NO_INVENTED_COMMANDS_RULE =
  "Never invent commands, keywords, or reply instructions for the user (no \"reply 'X' to …\", \"respond with …\", \"say the word …\"). Reply instructions are appended by the system, quoting only what actually works.";

/** Rule (e) — a tool not running is not a source being down. */
export const NO_ACCESS_OVERCLAIM_RULE =
  "Never claim a source is unavailable, inaccessible, or disconnected just because no tool ran this turn. Only report disconnection when the SELF-BRIEF says so; otherwise answer from the data blocks present.";

/** The full W6(c) rule set, in splice order. Pinned by truthful-ux.test.ts. */
export const TRUTHFUL_UX_RULES: readonly string[] = Object.freeze([
  PERSISTENCE_TRUTH_RULE,
  COVERAGE_LIMIT_FIRST_RULE,
  SELF_MODEL_RULE,
  NO_INVENTED_COMMANDS_RULE,
  NO_ACCESS_OVERCLAIM_RULE,
]);

/**
 * Transcript fix (00:09): the answer model invented "Reply 'confirm' to
 * track them." — protocol vocabulary the deterministic parser never
 * accepted. The model converses; protocol is code-authored. This scrubber
 * is the TEETH behind rule (d): any reply-instruction sentence in model
 * prose is stripped before send. The system appends real offers (with
 * real verbs) separately.
 */
const MACHINERY_LINE_RE =
  /\b(?:reply|respond|answer|text|message)\s+(?:me\s+)?(?:back\s+)?(?:with\s+)?["'""''][^'""'']{1,40}["'""'']/i;
const MACHINERY_SAY_RE = /\bsay\s+["'""''][a-z][^'""'']{0,40}["'""'']\s*(?:to|if|when|and)\b/i;
/** Reset dogfood fix: protocol-state narration the system owns, not the model. */
const MACHINERY_AWAIT_RE =
  /\bawaiting your (?:yes|confirmation|approval)\b|\bconfirm (?:code|token)\b|\bthe system (?:should|will) prompt\b/i;

export function isMachinerySentence(sentence: string): boolean {
  const s = sentence.trim();
  if (s.length === 0) return false;
  return MACHINERY_LINE_RE.test(s) || MACHINERY_SAY_RE.test(s) || MACHINERY_AWAIT_RE.test(s);
}

export function stripMachineryLines(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const keptLines: string[] = [];
  for (const line of text.split(/\n/)) {
    // A long conversational line that merely CONTAINS a quoted word stays —
    // only short, instruction-shaped lines are protocol.
    if (line.trim().length > 160) {
      keptLines.push(line);
      continue;
    }
    const sentences = line.split(/(?<=[.!?])\s+/);
    const keptSentences = sentences.filter((sentence) => !isMachinerySentence(sentence));
    if (keptSentences.length > 0) keptLines.push(keptSentences.join(" "));
  }
  const out = keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // If the reply was ENTIRELY protocol, it was never conversation — say
  // something that claims nothing instead of reinstating the machinery.
  return out.length > 0 ? out : "Okay.";
}
