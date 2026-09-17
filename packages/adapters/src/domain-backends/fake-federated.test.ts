// Fake federated backend — hermetic proof of the cleanup §3 invariant: only
// the policy-defined sanitized metadata projection (counts) ever crosses;
// titles/summaries/content never do.

import { describe, expect, it } from "vitest";
import { FakeFederatedBackend, type FakeFederatedReview } from "./fake-federated.js";

const REVIEWS: readonly FakeFederatedReview[] = [
  { title: "Confidential: Falcon launch-date decision", summary: "Proprietary details that must never cross the boundary.", pending: true },
  { title: "Confidential: vendor contract renewal", summary: "More proprietary content.", pending: true },
  { title: "Settled: office supplies", summary: "Nothing sensitive, but still remote content.", pending: false },
];

const CTX = { principalId: "test-principal", purpose: "attention" };

describe("FakeFederatedBackend", () => {
  const backend = new FakeFederatedBackend({ domainKey: "work-fed", reviews: REVIEWS });

  it("exports ONLY the sanitized counts projection for attention.counts", async () => {
    const result = await backend.query({ kind: "attention.counts" }, CTX);
    expect(result.rows).toEqual([{ pending_reviews: 2 }]);
  });

  it("unknown query kinds get nothing (deny by default)", async () => {
    expect((await backend.query({ kind: "events.recent" }, CTX)).rows).toEqual([]);
    expect((await backend.query({ kind: "attention.counts", params: { includeContent: true } }, CTX)).rows).toEqual([{ pending_reviews: 2 }]);
  });

  it("context exports the same counts projection for purpose=attention, nothing otherwise", async () => {
    expect((await backend.context({ purpose: "attention" }, CTX)).items).toEqual([{ pending_reviews: 2 }]);
    expect((await backend.context({ purpose: "arbitrary" }, CTX)).items).toEqual([]);
  });

  it("no content ever crosses any response path", async () => {
    const everything = JSON.stringify({
      query: await backend.query({ kind: "attention.counts" }, CTX),
      unknownQuery: await backend.query({ kind: "whatever" }, CTX),
      context: await backend.context({ purpose: "attention" }, CTX),
      otherContext: await backend.context({ purpose: "other" }, CTX),
      capabilities: await backend.capabilities(),
      health: await backend.health(),
    });
    expect(everything).not.toContain("Confidential");
    expect(everything).not.toContain("Falcon");
    expect(everything).not.toContain("title");
    expect(everything).not.toContain("summary");
    expect(everything).not.toContain("vendor");
  });

  it("declares federated mode, a capability, and health", async () => {
    expect(backend.mode).toBe("federated");
    expect(backend.id).toBe("federated:work-fed");
    expect(await backend.capabilities()).toEqual([{ name: "attention.counts", available: true }]);
    expect(await backend.health()).toEqual({ status: "healthy" });
  });
});
