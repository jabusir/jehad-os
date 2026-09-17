import { describe, expect, it } from "vitest";

describe("@jehad/core", () => {
  it("module loads and exports all Wave-2 lanes (events, policy, actions, egress, domains)", async () => {
    const mod = await import("./index.js");
    // events (M2)
    expect(mod.EVENT_CATALOG_V1).toBeDefined();
    expect(mod.acceptEvent).toBeDefined();
    expect(mod.idempotencyKeyFor).toBeDefined();
    // policy (M4A)
    expect(mod.issueGrant).toBeDefined();
    expect(mod.verifyGrant).toBeDefined();
    expect(mod.decideAutonomy).toBeDefined();
    expect(mod.V1_AUTONOMY_POLICY.actions.money_and_contracts).toBe("prohibited");
    // actions (M4B)
    expect(mod.ActionService).toBeDefined();
    // egress + domains (M4C)
    expect(mod.ModelEgressPolicyRegistry).toBeDefined();
    expect(mod.egressGatedModelProvider).toBeDefined();
    expect(mod.DomainBackendRegistry).toBeDefined();
    expect(mod.LocalBackend).toBeDefined();
  });
});
