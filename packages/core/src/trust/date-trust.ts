/**
 * Date trust (owner directive 2026-09-17): a due date may autonomously drive
 * overdue logic ONLY when its provenance is trustworthy. Three tiers:
 *
 *  1. calendar-native — the expression was structured calendar time; trusted.
 *  2. normalized — a deterministic normalizer resolved a free-text
 *     expression with resolutionConfidence >= trust threshold (default 0.9);
 *     trusted only at/above the threshold.
 *  3. review — ambiguous, unsupported, contradictory, malformed, or absent
 *     (legacy rows): NEVER auto-flagged overdue.
 *
 * Assessment is total: it never throws on bad temporal data — unknown is
 * better than confidently wrong, so every failure mode lands in "review".
 * Absent temporal (null column value, or the column itself not yet migrated
 * — W6A) is "legacy" and follows the strictest applicable rule: not
 * calendar-native, not trusted.
 */

// The temporal block carries the TemporalProvenance shape from
// packages/core/src/memory/candidate-contract.ts (W6A) — assessed here as
// untyped JSON because legacy/pre-migration rows and malformed blocks must
// degrade gracefully, never throw.

/** resolutionMethod marking structured calendar time (trusted outright). */
export const CALENDAR_NATIVE_METHOD = "calendar-native";

/** Default minimum normalizer confidence for normalized dates (owner directive). */
export const DEFAULT_DATE_TRUST_THRESHOLD = 0.9;

export type DateTrustTier = "calendar-native" | "normalized" | "review" | "legacy";

export interface DueDateTrust {
  readonly tier: DateTrustTier;
  /** True only for calendar-native and threshold-passing normalized dates. */
  readonly trusted: boolean;
}

/** `ambiguous_due_date`: past-due but untrusted — surfaced for review, never auto-overdue. */
export const AMBIGUOUS_DUE_DATE = "ambiguous_due_date" as const;

function asRecord(temporal: unknown): Record<string, unknown> | null {
  let value = temporal;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Assesses whether a commitment's temporal provenance (the
 * TemporalProvenance JSON from the extraction contract, or null/undefined
 * for legacy rows) makes its due date trustworthy for overdue automation.
 * Pure and total — malformed input degrades to "review".
 */
export function assessDueDateTrust(
  temporal: unknown,
  trustThreshold: number = DEFAULT_DATE_TRUST_THRESHOLD,
): DueDateTrust {
  if (temporal === null || temporal === undefined) {
    return { tier: "legacy", trusted: false };
  }
  const block = asRecord(temporal);
  if (block === null) {
    return { tier: "review", trusted: false };
  }
  if (block.resolutionStatus !== "resolved") {
    // ambiguous | unsupported | none — and anything unrecognized.
    return { tier: "review", trusted: false };
  }
  // Resolved must carry a normalized date; a null normalizedTime is
  // contradictory → strictest rule.
  if (typeof block.normalizedTime !== "string" || block.normalizedTime.length === 0) {
    return { tier: "review", trusted: false };
  }
  if (block.resolutionMethod === CALENDAR_NATIVE_METHOD) {
    return { tier: "calendar-native", trusted: true };
  }
  const confidence = block.resolutionConfidence;
  if (typeof confidence === "number" && Number.isFinite(confidence) && confidence >= trustThreshold) {
    return { tier: "normalized", trusted: true };
  }
  return { tier: "review", trusted: false };
}
