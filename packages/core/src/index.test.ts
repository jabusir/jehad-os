import { describe, expect, it } from "vitest";

describe("@jehad/core", () => {
  it("module loads (M0 smoke; exports the policy engine since M4)", async () => {
    const mod = await import("./index.js");
    expect(Object.keys(mod).sort()).toEqual([
      "ACTION_TYPES",
      "AUTONOMY_LEVELS",
      "autonomyLevelFor",
      "decideAutonomy",
      "issueGrant",
      "loadPolicyFile",
      "parsePolicyV1",
      "revokeGrant",
      "revokeGrantsByDomain",
      "revokeGrantsForRun",
      "verifyGrant",
    ]);
  });
});
