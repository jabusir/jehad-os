// Fake opaque backend — hermetic proof of the cleanup §3 strictest posture:
// zero domain-content export by default. Existence/health/capability only;
// NEVER any count, title, summary, or decision metadata — no semantic
// payload crosses, period.

import { describe, expect, it } from "vitest";
import { FakeOpaqueBackend } from "./fake-opaque.js";

const INTERNAL_STATE = {
  project: "Project Falcon",
  pending_reviews: 3,
  decision: { title: "Q4 roadmap", summary: "employer-confidential", deadline: "2026-10-01" },
} as const;

const CTX = { principalId: "test-principal", purpose: "attention" };

describe("FakeOpaqueBackend", () => {
  const backend = new FakeOpaqueBackend({ domainKey: "employer-x", internalState: INTERNAL_STATE });

  it("query returns nothing for every kind", async () => {
    for (const kind of ["attention.counts", "events.recent", "anything.else"]) {
      expect(await backend.query({ kind }, CTX)).toEqual({ rows: [] });
    }
  });

  it("context returns nothing for every purpose", async () => {
    expect(await backend.context({ purpose: "attention" }, CTX)).toEqual({ items: [] });
    expect(await backend.context({ purpose: "other" }, CTX)).toEqual({ items: [] });
  });

  it("the only signals are existence/health/capability", async () => {
    expect(backend.mode).toBe("opaque");
    expect(backend.id).toBe("opaque:employer-x");
    expect(await backend.capabilities()).toEqual([{ name: "domain.exists", available: true }]);
    expect(await backend.health()).toEqual({ status: "healthy" });
  });

  it("no semantic payload crosses any response path — not even counts", async () => {
    // the remote side holds real content...
    expect(backend.snapshotInternalState()).toEqual(INTERNAL_STATE);
    // ...but everything the boundary can emit is content-free:
    const everything = JSON.stringify({
      query: await backend.query({ kind: "attention.counts" }, CTX),
      context: await backend.context({ purpose: "attention" }, CTX),
      capabilities: await backend.capabilities(),
      health: await backend.health(),
    });
    for (const forbidden of ["Falcon", "pending_reviews", "roadmap", "summary", "deadline", "decision", "3"]) {
      expect(everything).not.toContain(forbidden);
    }
  });
});
