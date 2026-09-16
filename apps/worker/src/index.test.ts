import { describe, expect, it } from "vitest";
import { main } from "./index.js";

describe("@jehad/worker", () => {
  it("exposes a stub main (M0 smoke)", () => {
    expect(typeof main).toBe("function");
  });
});
