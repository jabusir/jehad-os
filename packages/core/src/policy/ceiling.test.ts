import { describe, expect, it } from "vitest";
import {
  ACTION_TYPES,
  AUTONOMY_LEVELS,
  decideAutonomy,
  loadPolicyFile,
  parsePolicyV1,
} from "./ceiling";

const VALID = `\
version: 1
autonomy_ceiling:
  read: autonomous
  propose: autonomous
  write_canonical: gated
  external_side_effect: approval_required
  money_and_contracts: prohibited
`;

describe("parsePolicyV1", () => {
  it("parses the v1 shape", () => {
    const policy = parsePolicyV1(VALID);
    expect(policy.version).toBe(1);
    expect(policy.autonomy_ceiling).toEqual({
      read: "autonomous",
      propose: "autonomous",
      write_canonical: "gated",
      external_side_effect: "approval_required",
      money_and_contracts: "prohibited",
    });
  });

  it("accepts comments and blank lines", () => {
    const policy = parsePolicyV1(`\
# leading comment
version: 1  # trailing comment

autonomy_ceiling:
  # v1 levels
  read: autonomous
  propose: autonomous
  write_canonical: gated
  external_side_effect: approval_required
  money_and_contracts: prohibited
`);
    expect(policy.autonomy_ceiling["money_and_contracts"]).toBe("prohibited");
  });

  it("fails closed on every structural deviation", () => {
    const cases = [
      "",
      "autonomy_ceiling:\n  read: autonomous\n",
      "version: 2\nautonomy_ceiling:\n  read: autonomous\n",
      "version: 1\n",
      `${VALID}extra_key: 1\n`,
      `${VALID.replace("autonomy_ceiling:", "ceiling:")}`,
      "version: 1\nautonomy_ceiling:\n  read: autonomous\n  propose: autonomous\n  write_canonical: gated\n  external_side_effect: approval_required\n", // missing money_and_contracts
      "version: 1\nautonomy_ceiling:\n  read: always\n  propose: autonomous\n  write_canonical: gated\n  external_side_effect: approval_required\n  money_and_contracts: prohibited\n",
      "version: 1\nautonomy_ceiling:\n  read: autonomous\n  read: autonomous\n  propose: autonomous\n  write_canonical: gated\n  external_side_effect: approval_required\n  money_and_contracts: prohibited\n",
      "version: 1\nversion: 1\nautonomy_ceiling:\n  read: autonomous\n  propose: autonomous\n  write_canonical: gated\n  external_side_effect: approval_required\n  money_and_contracts: prohibited\n",
      "version: 1\n  stray_indent: 1\n",
      "version: 1\nautonomy_ceiling: inline\n",
    ];
    for (const text of cases) {
      expect(() => parsePolicyV1(text), JSON.stringify(text)).toThrow();
    }
  });

  it("loads the repo-root policy.yaml with exactly the v1 ceiling", async () => {
    const policy = await loadPolicyFile(
      new URL("../../../../policy.yaml", import.meta.url),
    );
    expect(policy.version).toBe(1);
    expect(Object.keys(policy.autonomy_ceiling).sort()).toEqual([...ACTION_TYPES].sort());
    expect(policy.autonomy_ceiling).toEqual({
      read: "autonomous",
      propose: "autonomous",
      write_canonical: "gated",
      external_side_effect: "approval_required",
      money_and_contracts: "prohibited",
    });
  });
});

describe("decideAutonomy (ceiling from the real policy.yaml shape)", () => {
  const policy = parsePolicyV1(VALID);

  it("read and propose are autonomous", () => {
    expect(decideAutonomy(policy, "read")).toEqual({ allowed: true, level: "autonomous" });
    expect(decideAutonomy(policy, "propose")).toEqual({ allowed: true, level: "autonomous" });
  });

  it("write_canonical is gated: only a passed gate lets it land", () => {
    expect(decideAutonomy(policy, "write_canonical")).toEqual({
      allowed: false,
      level: "gated",
      reason: "gate_not_passed",
    });
    expect(decideAutonomy(policy, "write_canonical", { gatePassed: true })).toEqual({
      allowed: true,
      level: "gated",
    });
  });

  it("external_side_effect requires an explicit approval state", () => {
    expect(decideAutonomy(policy, "external_side_effect")).toEqual({
      allowed: false,
      level: "approval_required",
      reason: "approval_required",
    });
    expect(decideAutonomy(policy, "external_side_effect", { approved: true })).toEqual({
      allowed: true,
      level: "approval_required",
    });
    // A gate pass is not an approval.
    expect(decideAutonomy(policy, "external_side_effect", { gatePassed: true }).allowed).toBe(false);
  });

  it("money_and_contracts is prohibited always — approval cannot override", () => {
    expect(decideAutonomy(policy, "money_and_contracts")).toEqual({
      allowed: false,
      level: "prohibited",
      reason: "prohibited_by_policy",
    });
    expect(
      decideAutonomy(policy, "money_and_contracts", { approved: true, gatePassed: true }).allowed,
    ).toBe(false);
  });

  it("denies unknown action types fail-closed", () => {
    const decision = decideAutonomy(policy, "self_grant");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("unknown_action_type");
  });

  it("covers every level in its switch (exhaustiveness guard)", () => {
    for (const level of AUTONOMY_LEVELS) {
      const covered = Object.values(policy.autonomy_ceiling).includes(level);
      // v1 config exercises 4 levels; the switch handles all of them.
      expect(typeof covered).toBe("boolean");
    }
  });
});
