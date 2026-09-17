import { describe, expect, it } from "vitest";

describe("@jehad/core", () => {
  it("module loads and exports the M4 lanes (policy, actions)", async () => {
    const mod = await import("./index.js");
    expect(mod.issueGrant).toBeDefined();
    expect(mod.verifyGrant).toBeDefined();
    expect(mod.decideAutonomy).toBeDefined();
    expect(mod.ActionService).toBeDefined();
    expect(mod.V1_AUTONOMY_POLICY.actions.money_and_contracts).toBe("prohibited");
  });
});
