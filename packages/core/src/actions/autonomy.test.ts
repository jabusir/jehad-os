import { describe, expect, it } from "vitest";
import {
  ActionProhibitedError,
  V1_AUTONOMY_POLICY,
  assertAllowedByCeiling,
} from "./autonomy.js";

describe("v1 autonomy ceiling", () => {
  it("ships exactly the five plan §9 levels", () => {
    expect(V1_AUTONOMY_POLICY.actions).toEqual({
      read: "autonomous",
      propose: "autonomous",
      write_canonical: "gated",
      external_side_effect: "approval_required",
      money_and_contracts: "prohibited",
    });
  });

  it("rejects only prohibited action types", () => {
    expect(() => assertAllowedByCeiling(V1_AUTONOMY_POLICY, "money_and_contracts")).toThrow(
      ActionProhibitedError,
    );
    for (const actionType of [
      "read",
      "propose",
      "write_canonical",
      "external_side_effect",
    ] as const) {
      expect(() => assertAllowedByCeiling(V1_AUTONOMY_POLICY, actionType)).not.toThrow();
    }
  });

  it("honors a policy override (policy.yaml shape from M4A)", () => {
    const policy = {
      actions: {
        ...V1_AUTONOMY_POLICY.actions,
        read: "prohibited",
        money_and_contracts: "prohibited",
      },
    };
    expect(() => assertAllowedByCeiling(policy, "read")).toThrow(ActionProhibitedError);
  });
});
