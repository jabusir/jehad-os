import { describe, expect, it } from "vitest";

describe("@jehad/core", () => {
  it("exports the egress + domain-isolation surface", async () => {
    const mod = await import("./index.js");
    expect(Object.keys(mod).sort()).toEqual([
      "DomainBackendRegistry",
      "EgressDenialError",
      "EgressPolicyError",
      "LocalBackend",
      "ModelEgressPolicyRegistry",
      "UnknownDomainError",
      "defaultEgressPolicyPath",
      "egressGatedModelProvider",
      "loadDomainBackendRegistry",
      "loadEgressPolicyRegistry",
      "parseEgressPolicy",
    ]);
  });
});
