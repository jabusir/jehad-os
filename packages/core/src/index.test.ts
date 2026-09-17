import { describe, expect, it } from "vitest";

describe("@jehad/core", () => {
  it("module loads (smoke) and exports the action lane", async () => {
    const mod = await import("./index.js");
    expect(mod.ActionService).toBeDefined();
    expect(mod.V1_AUTONOMY_POLICY.actions.money_and_contracts).toBe("prohibited");
  });
});
