import { describe, expect, it } from "vitest";
import { EVENT_CATALOG_V1, isCatalogV1EventTypeName } from "./catalog.js";

describe("event catalog v1", () => {
  it("contains exactly the 17 plan §8 types, in plan order", () => {
    expect([...EVENT_CATALOG_V1]).toEqual([
      "capture.recorded",
      "commitment.detected",
      "commitment.due",
      "commitment.overdue",
      "decision.recorded",
      "assumption.changed",
      "memory.proposed",
      "memory.promoted",
      "run.started",
      "run.completed",
      "run.failed",
      "verification.failed",
      "escalation.raised",
      "escalation.resolved",
      "grant.issued",
      "grant.revoked",
      "brief.generated",
    ]);
    expect(EVENT_CATALOG_V1.length).toBe(17);
  });

  it("accepts catalog names and rejects everything else", () => {
    expect(isCatalogV1EventTypeName("capture.recorded")).toBe(true);
    expect(isCatalogV1EventTypeName("brief.generated")).toBe(true);
    // Directive §6 examples arrive with their sources in Phase 2+ (E3) — not v1.
    expect(isCatalogV1EventTypeName("email.received")).toBe(false);
    expect(isCatalogV1EventTypeName("github.pr_opened")).toBe(false);
    expect(isCatalogV1EventTypeName("")).toBe(false);
    expect(isCatalogV1EventTypeName(undefined)).toBe(false);
    expect(isCatalogV1EventTypeName(1)).toBe(false);
  });
});
