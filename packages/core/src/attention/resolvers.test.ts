// Liveness resolver defaults (ADR-0018 §4; W1 contract) — hermetic.
// system → live always; unregistered sourceType → unknown (never closes);
// registration is idempotent (re-register replaces).

import { describe, expect, it } from "vitest";
import type { AttentionItemRow } from "./types.js";
import { registerAttentionResolver, resolveLiveness } from "./resolvers.js";

const NOOP_DB = { query: async () => ({ rows: [] }) };

function item(sourceType: AttentionItemRow["sourceType"], sourceObjectId = "obj-1"): AttentionItemRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    principalId: "00000000-0000-4000-8000-000000000002",
    sourceType,
    sourceObjectId,
    fingerprint: "fp",
    kind: "watch.match",
    state: "open",
    level: "inbox",
    safetyClass: "none",
    title: "t",
    summary: "s",
    whyItMatters: null,
    evidenceRefs: [],
    actions: [],
    occurrences: 1,
    changeFingerprint: null,
    firstRaisedAt: new Date(0),
    updatedAt: new Date(0),
    seenAt: null,
    snoozedUntil: null,
    snoozeCount: 0,
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    lastDeliveredAt: null,
    deliveryAttempts: 0,
    lastDeliveryAttemptAt: null,
  };
}

describe("attention liveness resolvers", () => {
  it("system items are always live (owner ack / cancelled close them, never the sweep)", async () => {
    expect(await resolveLiveness(NOOP_DB, item("system"), new Date(0))).toBe("live");
  });

  it("an unregistered sourceType resolves unknown — unknown never closes", async () => {
    expect(await resolveLiveness(NOOP_DB, item("outcome"), new Date(0))).toBe("unknown");
  });

  it("registration is idempotent: the latest resolver for a sourceType wins", async () => {
    registerAttentionResolver("watch", async () => "live");
    expect(await resolveLiveness(NOOP_DB, item("watch"), new Date(0))).toBe("live");
    registerAttentionResolver("watch", async () => "gone");
    expect(await resolveLiveness(NOOP_DB, item("watch"), new Date(0))).toBe("gone");
    registerAttentionResolver("watch", async () => "gone");
    expect(await resolveLiveness(NOOP_DB, item("watch"), new Date(0))).toBe("gone");
  });

  it("the resolver receives the db executor, the row, and the pinned now", async () => {
    let seen: { db: unknown; item: unknown; now: unknown } | null = null;
    registerAttentionResolver("watch", async (db, row, now) => {
      seen = { db, item: row.sourceObjectId, now };
      return "unknown";
    });
    const now = new Date(1234);
    await resolveLiveness(NOOP_DB, item("watch", "probe"), now);
    expect(seen).toEqual({ db: NOOP_DB, item: "probe", now });
  });
});
