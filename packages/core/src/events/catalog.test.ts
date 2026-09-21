import { describe, expect, it } from "vitest";
import { EVENT_CATALOG_V1, isCatalogV1EventTypeName } from "./catalog.js";

describe("event catalog v1", () => {
  it("contains the 17 plan §8 types in plan order, plus the 3 additive E3 calendar types, the additive GMAIL type, and the additive W5(c) commitment-transition type", () => {
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
      "calendar.event.created",
      "calendar.event.updated",
      "calendar.event.cancelled",
      "gmail.message.received",
      "commitment.transitioned",
    ]);
    expect(EVENT_CATALOG_V1.length).toBe(22);
  });

  it("accepts catalog names and rejects everything else", () => {
    expect(isCatalogV1EventTypeName("capture.recorded")).toBe(true);
    expect(isCatalogV1EventTypeName("brief.generated")).toBe(true);
    // E3 additive calendar types are first-class catalog v1 members.
    expect(isCatalogV1EventTypeName("calendar.event.created")).toBe(true);
    expect(isCatalogV1EventTypeName("calendar.event.updated")).toBe(true);
    expect(isCatalogV1EventTypeName("calendar.event.cancelled")).toBe(true);
    // GMAIL additive type is a first-class catalog v1 member.
    expect(isCatalogV1EventTypeName("gmail.message.received")).toBe(true);
    // W5(c) additive commitment-transition type is a first-class member.
    expect(isCatalogV1EventTypeName("commitment.transitioned")).toBe(true);
    // Other Directive §6 sources still arrive later — not v1.
    expect(isCatalogV1EventTypeName("email.received")).toBe(false);
    expect(isCatalogV1EventTypeName("github.pr_opened")).toBe(false);
    expect(isCatalogV1EventTypeName("calendar.event.deleted")).toBe(false);
    expect(isCatalogV1EventTypeName("")).toBe(false);
    expect(isCatalogV1EventTypeName(undefined)).toBe(false);
    expect(isCatalogV1EventTypeName(1)).toBe(false);
  });
});
