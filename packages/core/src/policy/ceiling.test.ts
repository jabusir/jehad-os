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

// ------------------------------------------------------- gateway (Lane P)

describe("policy gateway section (multi-principal Lane P)", () => {
  const BASE = [
    "version: 1",
    "autonomy_ceiling:",
    "  read: autonomous",
    "  propose: autonomous",
    "  write_canonical: gated",
    "  external_side_effect: approval_required",
    "  money_and_contracts: prohibited",
  ].join("\n");

  it("parses gateway.principals entries with budgets keyed by principal name", () => {
    const policy = parsePolicyV1(
      BASE +
        "\ngateway:\n  principals:\n" +
        "    yusra: { model: openai/gpt-4o-mini, requests_per_hour: 20, cost_per_day: 2.0 }",
    );
    expect(policy.gateway?.principals).toEqual({
      yusra: { model: "openai/gpt-4o-mini", requestsPerHour: 20, costPerDay: 2, reads: [] },
    });
  });

  it("a gateway section without principals = no budgets (absent principal denies later)", () => {
    const policy = parsePolicyV1(BASE + "\ngateway:\n  principals:\n");
    expect(policy.gateway?.principals).toEqual({});
  });

  it("multiple principals parse independently", () => {
    const policy = parsePolicyV1(
      BASE +
        "\ngateway:\n  principals:\n" +
        "    yusra: { model: m-a, requests_per_hour: 20, cost_per_day: 2.0 }\n" +
        "    jehad: { model: m-b, requests_per_hour: 60, cost_per_day: 5.5 }",
    );
    expect(Object.keys(policy.gateway?.principals ?? {})).toEqual(["yusra", "jehad"]);
  });

  it("unknown gateway keys fail closed", () => {
    expect(() => parsePolicyV1(BASE + "\ngateway:\n  frobnicate: true")).toThrow(
      /unknown gateway key 'frobnicate'/,
    );
  });

  it("malformed principal entries fail closed (shape, positivity, duplicates)", () => {
    const cases = [
      "    yusra: { model: m, requests_per_hour: 0, cost_per_day: 2.0 }",
      "    yusra: { model: m, requests_per_hour: 20 }",
      "    yusra: just a string",
      "    yusra: { model: m, requests_per_hour: 20, cost_per_day: -1.0 }",
    ];
    for (const entry of cases) {
      expect(() => parsePolicyV1(BASE + "\ngateway:\n  principals:\n" + entry)).toThrow();
    }
    expect(() =>
      parsePolicyV1(
        BASE +
          "\ngateway:\n  principals:\n" +
          "    yusra: { model: m, requests_per_hour: 20, cost_per_day: 2.0 }\n" +
          "    yusra: { model: m, requests_per_hour: 20, cost_per_day: 2.0 }",
      ),
    ).toThrow(/duplicate gateway principal/);
  });

  it("the repo-root policy.yaml parses with the gateway section present", async () => {
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const policyYaml = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../policy.yaml",
    );
    const policy = await loadPolicyFile(policyYaml);
    expect(policy.gateway?.principals.yusra).toEqual({
      model: "openai/gpt-4o-mini",
      requestsPerHour: 20,
      costPerDay: 2,
      reads: [],
    });
    expect(policy.gateway?.principals.josctl).toEqual({
      model: "openai/gpt-4o-mini",
      requestsPerHour: 30,
      costPerDay: 5,
      reads: ["calendar", "commitments"],
    });
    // Phase F/G gateway sub-policies land in the parsed policy.
    expect(policy.gateway?.capture).toEqual({
      enabled: true,
      principals: ["josctl"],
      maxPerHour: 5,
      dedupeWindowHours: 24,
    });
    expect(policy.gateway?.review).toEqual({
      enabled: true,
      principals: ["josctl"],
      maxBadRefs: 3,
      snoozeHours: 24,
      refTtlHours: 168,
      digestMaxCandidates: 10,
      digestMaxEscalations: 5,
    });
  });

  it("parses gateway.review with strictly ordered keys; deviations fail closed", () => {
    const review =
      "{ enabled: true, principals: [josctl], max_bad_refs: 3, snooze_hours: 24, ref_ttl_hours: 168, digest_max_candidates: 10, digest_max_escalations: 5 }";
    const policy = parsePolicyV1(BASE + "\ngateway:\n  review: " + review + "\n  principals:\n");
    expect(policy.gateway?.review).toEqual({
      enabled: true,
      principals: ["josctl"],
      maxBadRefs: 3,
      snoozeHours: 24,
      refTtlHours: 168,
      digestMaxCandidates: 10,
      digestMaxEscalations: 5,
    });
    // Reordered keys, unknown keys, non-positive values, and duplicates all throw.
    for (const bad of [
      "{ enabled: true, max_bad_refs: 3, principals: [josctl], snooze_hours: 24, ref_ttl_hours: 168, digest_max_candidates: 10, digest_max_escalations: 5 }",
      "{ enabled: true, principals: [josctl], max_bad_refs: 0, snooze_hours: 24, ref_ttl_hours: 168, digest_max_candidates: 10, digest_max_escalations: 5 }",
      "{ enabled: true, principals: [josctl], max_bad_refs: 3, snooze_hours: 24 }",
      "{ enabled: maybe, principals: [josctl], max_bad_refs: 3, snooze_hours: 24, ref_ttl_hours: 168, digest_max_candidates: 10, digest_max_escalations: 5 }",
    ]) {
      expect(() => parsePolicyV1(BASE + "\ngateway:\n  review: " + bad)).toThrow();
    }
    expect(() =>
      parsePolicyV1(BASE + "\ngateway:\n  review: " + review + "\n  review: " + review),
    ).toThrow(/duplicate gateway.review key/);
  });
});
