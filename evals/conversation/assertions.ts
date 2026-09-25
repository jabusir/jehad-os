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

// §22 (intelligence-reset §22.15 runner extension, build item 4): pure
// observation shapes + expectation checks for the single-author path. The
// runner captures these per turn; scenario yaml pins them via
// ledger_contains / rounds_at_least / rounds_at_most / intent_is.

/** One operation/resolution ledger entry a turn produced, normalized to
 * {opType, status} (e.g. {opType: "task_batch", status: "parked"} — the
 * §22.2/§22.3 terminal-outcome vocabulary: applied|parked|queued|failed,
 * plus rejected for structurally refused requests). Empty on the legacy
 * path, which has no typed ledger. */
export interface LedgerEntryObservation {
  readonly opType: string;
  readonly status: string;
}

/** `ledger_contains` pin: the final turn's ledger must carry an entry with
 * exactly this opType AND status (executed, failed, and rejected entries
 * are all pinning targets — §22.9 verifies against the same ledger). */
export interface LedgerContainsPin {
  readonly opType: string;
  readonly status: string;
}

function renderLedger(ledger: readonly LedgerEntryObservation[]): string {
  return `[${ledger.map((entry) => `${entry.opType}:${entry.status}`).join(", ")}]`;
}

/** ledger_contains: every pin must match at least one ledger entry. */
export function ledgerContainsFailures(
  pins: readonly LedgerContainsPin[],
  ledger: readonly LedgerEntryObservation[],
): string[] {
  const failures: string[] = [];
  for (const pin of pins) {
    const present = ledger.some(
      (entry) => entry.opType === pin.opType && entry.status === pin.status,
    );
    if (!present) {
      failures.push(
        `ledger_contains: no "${pin.opType}" entry with status "${pin.status}" (ledger: ${renderLedger(ledger)})`,
      );
    }
  }
  return failures;
}

/** rounds_at_least / rounds_at_most: bound the final turn's cognitive round
 * count (§22.5 caps at 3; G1's sparse variant pins ≥2). 0 on legacy. */
export function roundsBoundFailures(
  rounds: number,
  bounds: { readonly atLeast?: number; readonly atMost?: number },
): string[] {
  const failures: string[] = [];
  if (bounds.atLeast !== undefined && rounds < bounds.atLeast) {
    failures.push(`rounds_at_least: expected at least ${bounds.atLeast} cognitive round(s), got ${rounds}`);
  }
  if (bounds.atMost !== undefined && rounds > bounds.atMost) {
    failures.push(`rounds_at_most: expected at most ${bounds.atMost} cognitive round(s), got ${rounds}`);
  }
  return failures;
}

/** intent_is: the final turn's structured intent (§22.2 owner correction 5 —
 * the durable audit enum, never the ephemeral interpretation) must equal the
 * pinned member. null on legacy / absent envelopes. */
export function intentIsFailure(expected: string, intent: string | null): string | null {
  if (intent === expected) return null;
  const got = intent === null ? "null (no intent observed)" : `"${intent}"`;
  return `intent_is: expected "${expected}", got ${got}`;
}
