/**
 * W6(c) persistence-truth eval helpers (plan §5 invariant 15, §7 W6(c)).
 *
 * PERSISTENCE_CLAIM_RE recognizes the reply phrasings the invariant forbids
 * unless a durable mutation succeeded the same turn ("I've noted…",
 * "I have saved…", "I'll remember…", "I'm tracking…"). Shared by the
 * conversation runner (`no_persistence_claim_without_write` expectation)
 * and reusable by any future behavioral eval that needs the same pin.
 *
 * Deliberately narrow: negations ("I'm not tracking it yet") and honest
 * absence wording must NOT match — the regex anchors on the claim verb
 * directly following the pronoun, so an intervening "not" breaks the match.
 */

/** Persistence-claim phrasings forbidden without a same-turn durable write. */
export const PERSISTENCE_CLAIM_RE =
  /(i'?ve|i have) (noted|saved|added|updated)|i'?ll remember|i'?m tracking/i;

/** Returns the offending claim phrase, or null when the text is clean. */
export function persistenceClaimIn(text: string): string | null {
  const match = PERSISTENCE_CLAIM_RE.exec(text);
  return match === null ? null : match[0];
}
