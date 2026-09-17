import { describe, expect, it } from "vitest";

describe("@jehad/adapters", () => {
  it("ports module loads (M0 smoke — ports are type-only, so no runtime keys)", async () => {
    const mod = await import("./index.js");
    expect(mod).toBeDefined();
  });
});
