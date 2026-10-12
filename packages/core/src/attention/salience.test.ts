// Salience truth table (ADR-0018 §1.7; W1 contract) — hermetic: every Date
// is pinned, no wall-clock reads. Hand-checked against the 2026 calendar:
// America/Los_Angeles is PDT (UTC-7) until the 2026-11-01 fall-back, then
// PST (UTC-8). Quiet window is [22:00, next-day 07:00) owner-local.

import { describe, expect, it } from "vitest";
import { decideDelivery } from "./salience.js";

const BUSINESS = new Date("2026-09-21T17:00:00.000Z"); // Mon 10:00 PDT
const QUIET_2200 = new Date("2026-09-22T05:00:00.000Z"); // 22:00 PDT
const QUIET_0330 = new Date("2026-09-22T10:30:00.000Z"); // 03:30 PDT
const BOUNDARY_0700 = new Date("2026-09-22T14:00:00.000Z"); // 07:00 PDT — not quiet
const QUIET_0659 = new Date("2026-09-22T13:59:00.000Z"); // 06:59 PDT — quiet
const DST_2159 = new Date("2026-11-02T05:00:00.000Z"); // 21:59 PST — not quiet
const DST_2200 = new Date("2026-11-02T06:00:00.000Z"); // 22:00 PST — quiet

function input(overrides: Partial<Parameters<typeof decideDelivery>[0]> = {}): Parameters<typeof decideDelivery>[0] {
  return {
    level: "inbox",
    safetyClass: "none",
    state: "open",
    snoozedUntil: null,
    lastDeliveredAt: null,
    newChangeFingerprint: null,
    storedChangeFingerprint: null,
    cooldownMinutes: 60,
    now: BUSINESS,
    ...overrides,
  };
}

const minutesAgo = (from: Date, n: number): Date => new Date(from.getTime() - n * 60_000);
const minutesAhead = (from: Date, n: number): Date => new Date(from.getTime() + n * 60_000);

describe("decideDelivery — the ladder", () => {
  it("clean open item during business hours delivers", () => {
    expect(decideDelivery(input())).toEqual({ deliver: true, deferReason: null });
  });

  it("quiet hours defer inbox/digest (never drop): 22:00, 03:30, 06:59 quiet; 07:00 boundary is not", () => {
    expect(decideDelivery(input({ now: QUIET_2200 }))).toEqual({ deliver: false, deferReason: "quiet_hours" });
    expect(decideDelivery(input({ now: QUIET_0330 }))).toEqual({ deliver: false, deferReason: "quiet_hours" });
    expect(decideDelivery(input({ now: QUIET_0659 }))).toEqual({ deliver: false, deferReason: "quiet_hours" });
    expect(decideDelivery(input({ now: BOUNDARY_0700 }))).toEqual({ deliver: true, deferReason: null });
    expect(decideDelivery(input({ level: "digest", now: QUIET_0330 })).deliver).toBe(false);
  });

  it("quiet hours are computed in America/Los_Angeles, not UTC (DST-correct)", () => {
    // 06:00Z is "daytime" in naive UTC terms but 22:00 PST after fall-back.
    expect(decideDelivery(input({ now: DST_2200 })).deferReason).toBe("quiet_hours");
    expect(decideDelivery(input({ now: DST_2159 })).deferReason).toBeNull();
  });

  it("interrupt bypasses quiet hours", () => {
    expect(decideDelivery(input({ level: "interrupt", now: QUIET_0330 }))).toEqual({ deliver: true, deferReason: null });
  });

  it("safety class bypasses quiet hours AND cooldown AND snooze", () => {
    const safety = { safetyClass: "water" } as const;
    expect(decideDelivery(input({ ...safety, now: QUIET_0330 }))).toEqual({ deliver: true, deferReason: null });
    expect(
      decideDelivery(input({ ...safety, lastDeliveredAt: minutesAgo(BUSINESS, 1) })),
    ).toEqual({ deliver: true, deferReason: null });
    expect(
      decideDelivery(input({ ...safety, state: "snoozed", snoozedUntil: minutesAhead(BUSINESS, 60) })),
    ).toEqual({ deliver: true, deferReason: null });
    expect(
      decideDelivery(input({ safetyClass: "security", now: QUIET_0330, lastDeliveredAt: minutesAgo(QUIET_0330, 2) })).deliver,
    ).toBe(true);
  });

  it("snoozed with a future snoozedUntil defers; expired or missing fails open", () => {
    expect(
      decideDelivery(input({ state: "snoozed", snoozedUntil: minutesAhead(BUSINESS, 30) })),
    ).toEqual({ deliver: false, deferReason: "snoozed" });
    // Expired snooze fails open → deliver (never a lost issue).
    expect(
      decideDelivery(input({ state: "snoozed", snoozedUntil: minutesAgo(BUSINESS, 1) })),
    ).toEqual({ deliver: true, deferReason: null });
    // Missing snoozedUntil on a snoozed row is bad data — fail open.
    expect(decideDelivery(input({ state: "snoozed", snoozedUntil: null }))).toEqual({ deliver: true, deferReason: null });
  });

  it("cooldown suppresses re-delivery within the window; elapsed ≥ cooldown delivers; null fails open", () => {
    expect(
      decideDelivery(input({ lastDeliveredAt: minutesAgo(BUSINESS, 10) })),
    ).toEqual({ deliver: false, deferReason: "cooldown" });
    expect(
      decideDelivery(input({ lastDeliveredAt: minutesAgo(BUSINESS, 60) })),
    ).toEqual({ deliver: true, deferReason: null });
    expect(
      decideDelivery(input({ lastDeliveredAt: null })),
    ).toEqual({ deliver: true, deferReason: null });
  });

  it("unchanged fingerprint defers; differing or null on either side fails open", () => {
    expect(
      decideDelivery(input({ newChangeFingerprint: "occ-1", storedChangeFingerprint: "occ-1" })),
    ).toEqual({ deliver: false, deferReason: "unchanged" });
    expect(
      decideDelivery(input({ newChangeFingerprint: "occ-2", storedChangeFingerprint: "occ-1" })),
    ).toEqual({ deliver: true, deferReason: null });
    expect(
      decideDelivery(input({ newChangeFingerprint: null, storedChangeFingerprint: "occ-1" })),
    ).toEqual({ deliver: true, deferReason: null });
    expect(
      decideDelivery(input({ newChangeFingerprint: "occ-1", storedChangeFingerprint: null })),
    ).toEqual({ deliver: true, deferReason: null });
  });

  it("gate order: snoozed beats quiet hours, quiet hours beat cooldown, cooldown beats unchanged", () => {
    expect(
      decideDelivery(input({ state: "snoozed", snoozedUntil: minutesAhead(QUIET_0330, 30), now: QUIET_0330 })),
    ).toEqual({ deliver: false, deferReason: "snoozed" });
    expect(
      decideDelivery(input({ now: QUIET_0330, lastDeliveredAt: minutesAgo(QUIET_0330, 5) })),
    ).toEqual({ deliver: false, deferReason: "quiet_hours" });
    expect(
      decideDelivery(input({
        lastDeliveredAt: minutesAgo(BUSINESS, 5),
        newChangeFingerprint: "same",
        storedChangeFingerprint: "same",
      })),
    ).toEqual({ deliver: false, deferReason: "cooldown" });
  });
});
