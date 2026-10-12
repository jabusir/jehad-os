// Attention salience (ADR-0018 §1.7): the deterministic delivery ladder.
// Pure — no DB, no I/O, no wall-clock reads; `now` is a parameter so the
// worker owns the clock and tests pin exact Dates (reminders/lifecycle
// precedent).
//
// The ladder (W1 contract): snoozed → quiet hours → cooldown → unchanged →
// deliver. Every gate FAILS OPEN on missing data (null snoozedUntil, null
// lastDeliveredAt, null fingerprints all deliver) — the durable item bounds
// the worst case at one duplicate push, never a lost issue. Safety-class
// items (security/water/safety) bypass quiet hours AND cooldown AND snooze;
// `interrupt` bypasses quiet hours. Quiet hours are wall-clock in
// America/Los_Angeles (BRIEF_TIMEZONE, DST-safe via Intl).

import { BRIEF_TIMEZONE } from "../briefs/timezone.js";
import {
  ATTENTION_QUIET_HOURS,
  type AttentionLevel,
  type AttentionSafetyClass,
  type AttentionState,
  type SalienceDecision,
} from "./types.js";

const QUIET_TZ_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: BRIEF_TIMEZONE,
  hour: "numeric",
  hour12: false,
});

/** Owner-local hour (0-23) of an instant in BRIEF_TIMEZONE (DST-correct). */
function localHour(instant: Date): number {
  // hourCycle quirk: some engines render midnight as 24 (reminders precedent).
  return Number(QUIET_TZ_FORMATTER.format(instant)) % 24;
}

function isQuietHours(now: Date): boolean {
  const hour = localHour(now);
  return hour >= ATTENTION_QUIET_HOURS.startHour || hour < ATTENTION_QUIET_HOURS.endHour;
}

export interface DecideDeliveryInput {
  readonly level: AttentionLevel;
  readonly safetyClass: AttentionSafetyClass;
  readonly state: AttentionState;
  readonly snoozedUntil: Date | null;
  readonly lastDeliveredAt: Date | null;
  readonly newChangeFingerprint: string | null;
  readonly storedChangeFingerprint: string | null;
  readonly cooldownMinutes: number;
  readonly now: Date;
}

/**
 * One salience decision, evaluated top-to-bottom; the FIRST satisfied gate
 * defers (its reason wins). Level-rise re-delivery is decided by the caller
 * (the contract input carries a single level, so the stored-level comparison
 * happens in the service and ORs with this result).
 */
export function decideDelivery(input: DecideDeliveryInput): SalienceDecision {
  const bypassesAllGates = input.safetyClass !== "none";

  // 1. Snooze is explicit owner state: blocks delivery until it expires —
  //    except safety (ADR-0018 §1.7). A past/missing snoozedUntil fails open.
  if (
    !bypassesAllGates &&
    input.state === "snoozed" &&
    input.snoozedUntil !== null &&
    input.snoozedUntil.getTime() > input.now.getTime()
  ) {
    return { deliver: false, deferReason: "snoozed" };
  }

  // 2. Quiet hours defer (never drop) inbox/digest; interrupt and safety
  //    push through.
  if (!bypassesAllGates && input.level !== "interrupt" && isQuietHours(input.now)) {
    return { deliver: false, deferReason: "quiet_hours" };
  }

  // 3. Cooldown suppresses re-delivery, not bumps; null lastDeliveredAt
  //    (never delivered) fails open.
  if (!bypassesAllGates && input.lastDeliveredAt !== null) {
    const elapsedMs = input.now.getTime() - input.lastDeliveredAt.getTime();
    if (elapsedMs < input.cooldownMinutes * 60_000) {
      return { deliver: false, deferReason: "cooldown" };
    }
  }

  // 4. Unchanged occurrence identity → no news. Either side null fails open
  //    (a producer that cannot fingerprint must not be silently swallowed).
  if (
    input.newChangeFingerprint !== null &&
    input.storedChangeFingerprint !== null &&
    input.newChangeFingerprint === input.storedChangeFingerprint
  ) {
    return { deliver: false, deferReason: "unchanged" };
  }

  return { deliver: true, deferReason: null };
}
