import { describe, expect, it } from "vitest";

describe("@jehad/adapters", () => {
  it("module loads (M0 smoke)", async () => {
    const mod = await import("./index.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});
