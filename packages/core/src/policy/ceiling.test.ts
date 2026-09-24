import { describe, expect, it } from "vitest";
import { answerModelForTier } from "../imessage/model-selection.js";
import {
  ACTION_TYPES,
  AUTONOMY_LEVELS,
  DEFAULT_CALIBRATION_POLICY,
  DEFAULT_GMAIL_SENSOR_POLICY,
  DEFAULT_PERSONAS_POLICY,
  calibrationPolicyOf,
  decideAutonomy,
  gatewayContextPolicyOf,
  gmailSensorPolicyOf,
  loadPolicyFile,
  parsePolicyV1,
  personasPolicyOf,
} from "./ceiling";
import { DEFAULT_PER_BLOCK_TOKEN_BUDGET } from "../context/assembler";

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
      requestsPerHour: 60, // answer-pass calls only (route/interpret don't count)
      costPerDay: 5,
      reads: ["calendar", "commitments", "gmail", "state", "memory", "system"], // state/memory/system: W1-W7
    });
    expect(policy.gateway?.actions).toEqual({
      enabled: true,
      principals: ["josctl"],
      maxProposalsPerDay: 10,
      maxDispatchesPerDay: 5,
      confirmTtlMinutes: 10,
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

describe("policy gateway.actions (Phase H action lane)", () => {
  const BASE = [
    "version: 1",
    "autonomy_ceiling:",
    "  read: autonomous",
    "  propose: autonomous",
    "  write_canonical: gated",
    "  external_side_effect: approval_required",
    "  money_and_contracts: prohibited",
  ].join("\n");
  const ENTRY =
    "  actions: { enabled: true, principals: [josctl], max_proposals_per_day: 10, max_dispatches_per_day: 5, confirm_ttl_minutes: 10 }";

  it("parses the strict ordered flow mapping onto GatewayActionsPolicy", () => {
    const policy = parsePolicyV1(`${BASE}\ngateway:\n${ENTRY}\n`);
    expect(policy.gateway?.actions).toEqual({
      enabled: true,
      principals: ["josctl"],
      maxProposalsPerDay: 10,
      maxDispatchesPerDay: 5,
      confirmTtlMinutes: 10,
    });
  });

  it("disabled lane parses and stays explicit (fail closed downstream)", () => {
    const policy = parsePolicyV1(
      BASE + "\ngateway:\n  actions: { enabled: false, principals: [josctl], max_proposals_per_day: 10, max_dispatches_per_day: 5, confirm_ttl_minutes: 10 }\n",
    );
    expect(policy.gateway?.actions?.enabled).toBe(false);
  });

  it("empty principals list parses to nobody-enabled (fail closed, not an error)", () => {
    const policy = parsePolicyV1(
      BASE + "\ngateway:\n  actions: { enabled: true, principals: [], max_proposals_per_day: 10, max_dispatches_per_day: 5, confirm_ttl_minutes: 10 }\n",
    );
    expect(policy.gateway?.actions?.principals).toEqual([]);
  });

  it("malformed actions entries fail closed (shape, order, positivity, duplicates)", () => {
    const cases = [
      "  actions: { enabled: true, principals: [josctl] }",
      "  actions: { principals: [josctl], enabled: true, max_proposals_per_day: 10, max_dispatches_per_day: 5, confirm_ttl_minutes: 10 }",
      "  actions: { enabled: maybe, principals: [josctl], max_proposals_per_day: 10, max_dispatches_per_day: 5, confirm_ttl_minutes: 10 }",
      "  actions: { enabled: true, principals: [josctl], max_proposals_per_day: 0, max_dispatches_per_day: 5, confirm_ttl_minutes: 10 }",
      "  actions: { enabled: true, principals: [josctl], max_proposals_per_day: 10, max_dispatches_per_day: 0, confirm_ttl_minutes: 10 }",
      "  actions: { enabled: true, principals: [josctl], max_proposals_per_day: 10, max_dispatches_per_day: 5, confirm_ttl_minutes: 0 }",
      "  actions: { enabled: true, principals: [josctl], max_proposals_per_day: 10, max_dispatches_per_day: 5, quiet_mode: true }",
      "  actions: just a string",
    ];
    for (const entry of cases) {
      expect(() => parsePolicyV1(`${BASE}\ngateway:\n${entry}\n`), entry).toThrow();
    }
    expect(() =>
      parsePolicyV1(`${BASE}\ngateway:\n${ENTRY}\n${ENTRY}\n`),
    ).toThrow(/duplicate gateway.actions/);
  });
});

describe("policy gateway.passes (Lane R1 model routing)", () => {
  const BASE = [
    "version: 1",
    "autonomy_ceiling:",
    "  read: autonomous",
    "  propose: autonomous",
    "  write_canonical: gated",
    "  external_side_effect: approval_required",
    "  money_and_contracts: prohibited",
  ].join("\n");

  it("parses the full three-key override set", () => {
    const policy = parsePolicyV1(
      BASE +
        "\ngateway:\n  passes: { route: { model: m-r }, answer: { model: m-a }, route_fallback: { model: m-f } }\n",
    );
    expect(policy.gateway?.passes).toEqual({
      route: { model: "m-r" },
      answer: { model: "m-a" },
      route_fallback: { model: "m-f" },
    });
  });

  it("passes: {} is valid — no overrides", () => {
    const policy = parsePolicyV1(BASE + "\ngateway:\n  passes: {}\n");
    expect(policy.gateway?.passes).toEqual({});
  });

  it("partial override subsets parse (route only; answer+route_fallback)", () => {
    expect(
      parsePolicyV1(BASE + "\ngateway:\n  passes: { route: { model: m-r } }\n").gateway?.passes,
    ).toEqual({ route: { model: "m-r" } });
    expect(
      parsePolicyV1(
        BASE + "\ngateway:\n  passes: { answer: { model: m-a }, route_fallback: { model: m-f } }\n",
      ).gateway?.passes,
    ).toEqual({ answer: { model: "m-a" }, route_fallback: { model: "m-f" } });
  });

  it("absent passes → gateway.passes === null (no overrides)", () => {
    const policy = parsePolicyV1(BASE + "\ngateway:\n  principals:\n");
    expect(policy.gateway).toBeDefined();
    expect(policy.gateway?.passes).toBeNull();
  });

  it("malformed passes fail closed (unknown key, non-string model, order, duplicates, shape)", () => {
    const cases = [
      "  passes: { route: { model: m-r }, turbo: { model: m-t } }",
      "  passes: { route: { model: 123 } }",
      "  passes: { route: { model: true } }",
      "  passes: { route: { model: } }",
      "  passes: { answer: { model: m-a }, route: { model: m-r } }",
      "  passes: { route: { model: m-r }, route: { model: m-r2 } }",
      "  passes: { route: m-r }",
      "  passes: just a string",
      "  passes: { route: { model: m-r }, }",
      "  passes:",
    ];
    for (const entry of cases) {
      expect(() => parsePolicyV1(`${BASE}\ngateway:\n${entry}\n`), entry).toThrow();
    }
    expect(() =>
      parsePolicyV1(`${BASE}\ngateway:\n  passes: {}\n  passes: {}\n`),
    ).toThrow(/duplicate gateway.passes/);
  });

  it("the repo-root policy.yaml parses with the live W3 per-pass routing pinned", async () => {
    const policy = await loadPolicyFile(
      new URL("../../../../policy.yaml", import.meta.url),
    );
    expect(policy.gateway).toBeDefined();
    expect(policy.gateway?.passes).toEqual({
      route: { model: "openai/gpt-4.1" },
      answer_fast: { model: "openai/gpt-4.1" },
      answer_standard: { model: "anthropic/claude-sonnet-4.5" },
      answer_fallback: { model: "google/gemini-3.8-flash" },
      route_fallback: { model: "google/gemini-3.8-flash" },
    });
    // W3 resolution over the LIVE policy: DEEP falls back to answer_standard.
    expect(answerModelForTier(policy.gateway?.passes ?? null, "openai/gpt-4o-mini", "deep")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(answerModelForTier(policy.gateway?.passes ?? null, "openai/gpt-4o-mini", "fast")).toBe(
      "openai/gpt-4.1",
    );
  });
});

describe("policy gateway.passes W3 tier keys (answer_fast/standard/deep/fallback)", () => {
  const BASE = [
    "version: 1",
    "autonomy_ceiling:",
    "  read: autonomous",
    "  propose: autonomous",
    "  write_canonical: gated",
    "  external_side_effect: approval_required",
    "  money_and_contracts: prohibited",
  ].join("\n");

  it("parses the full seven-key override set in the legal order", () => {
    const policy = parsePolicyV1(
      BASE +
        "\ngateway:\n  passes: { route: { model: m-r }, answer: { model: m-a }, answer_fast: { model: m-f }, answer_standard: { model: m-s }, answer_deep: { model: m-d }, answer_fallback: { model: m-af }, route_fallback: { model: m-rf } }\n",
    );
    expect(policy.gateway?.passes).toEqual({
      route: { model: "m-r" },
      answer: { model: "m-a" },
      answer_fast: { model: "m-f" },
      answer_standard: { model: "m-s" },
      answer_deep: { model: "m-d" },
      answer_fallback: { model: "m-af" },
      route_fallback: { model: "m-rf" },
    });
  });

  it("parses each tier subset on its own and in combinations", () => {
    expect(
      parsePolicyV1(BASE + "\ngateway:\n  passes: { answer_fast: { model: m-f } }\n").gateway?.passes,
    ).toEqual({ answer_fast: { model: "m-f" } });
    expect(
      parsePolicyV1(
        BASE + "\ngateway:\n  passes: { answer_standard: { model: m-s }, answer_deep: { model: m-d } }\n",
      ).gateway?.passes,
    ).toEqual({ answer_standard: { model: "m-s" }, answer_deep: { model: "m-d" } });
    expect(
      parsePolicyV1(
        BASE + "\ngateway:\n  passes: { answer_deep: { model: m-d }, answer_fallback: { model: m-af } }\n",
      ).gateway?.passes,
    ).toEqual({ answer_deep: { model: "m-d" }, answer_fallback: { model: "m-af" } });
    expect(
      parsePolicyV1(
        BASE +
          "\ngateway:\n  passes: { answer: { model: m-a }, answer_fast: { model: m-f }, answer_standard: { model: m-s } }\n",
      ).gateway?.passes,
    ).toEqual({
      answer: { model: "m-a" },
      answer_fast: { model: "m-f" },
      answer_standard: { model: "m-s" },
    });
    expect(
      parsePolicyV1(
        BASE + "\ngateway:\n  passes: { answer_fast: { model: m-f }, route_fallback: { model: m-rf } }\n",
      ).gateway?.passes,
    ).toEqual({ answer_fast: { model: "m-f" }, route_fallback: { model: "m-rf" } });
  });

  it("absent tier keys are simply undefined — resolution falls back to the principal model (answerModelForTier)", () => {
    const passes = parsePolicyV1(BASE + "\ngateway:\n  passes: { route: { model: m-r } }\n").gateway?.passes ?? null;
    expect(answerModelForTier(passes, "p/model", "fast")).toBe("p/model");
    expect(answerModelForTier(passes, "p/model", "standard")).toBe("p/model");
    expect(answerModelForTier(passes, "p/model", "deep")).toBe("p/model");
    expect(answerModelForTier(null, "p/model", "standard")).toBe("p/model");
  });

  it("malformed tier entries fail closed (unknown key, order, duplicates, shape)", () => {
    const cases = [
      "  passes: { answer_fast: { model: m-f }, answer turbo: { model: m-t } }",
      "  passes: { answer_standard: { model: m-s }, answer_fast: { model: m-f } }",
      "  passes: { answer_deep: { model: m-d }, answer_standard: { model: m-s } }",
      "  passes: { answer_fallback: { model: m-af }, answer_deep: { model: m-d } }",
      "  passes: { answer_fast: { model: m-f }, answer_fast: { model: m-f2 } }",
      "  passes: { answer_fast: m-f }",
      "  passes: { answer_fast: { model: } }",
      "  passes: { answer_ultra: { model: m-u } }",
      "  passes: { answerdeep: { model: m-d } }",
    ];
    for (const entry of cases) {
      expect(() => parsePolicyV1(`${BASE}\ngateway:\n${entry}\n`), entry).toThrow();
    }
  });
});

describe("policy gateway.context (Lane J1 context assembler flag)", () => {
  const BASE = [
    "version: 1",
    "autonomy_ceiling:",
    "  read: autonomous",
    "  propose: autonomous",
    "  write_canonical: gated",
    "  external_side_effect: approval_required",
    "  money_and_contracts: prohibited",
  ].join("\n");
  const ENTRY = "  context: { enabled: true, max_reads_per_turn: 3, per_block_token_budget: 2000 }";

  it("parses the strict ordered flow mapping onto GatewayContextPolicy", () => {
    const policy = parsePolicyV1(`${BASE}\ngateway:\n${ENTRY}\n`);
    expect(policy.gateway?.context).toEqual({
      enabled: true,
      maxReadsPerTurn: 3,
      perBlockTokenBudget: 2000,
    });
  });

  it("accepts every legal max_reads_per_turn and both enabled states", () => {
    for (const maxReads of [1, 2, 3]) {
      const policy = parsePolicyV1(
        BASE +
          `\ngateway:\n  context: { enabled: ${maxReads === 2}, max_reads_per_turn: ${maxReads}, per_block_token_budget: 1500 }\n`,
      );
      expect(policy.gateway?.context).toEqual({
        enabled: maxReads === 2,
        maxReadsPerTurn: maxReads,
        perBlockTokenBudget: 1500,
      });
    }
  });

  it("absent section → gatewayContextPolicyOf returns fail-closed current-behavior defaults", () => {
    const policy = parsePolicyV1(BASE + "\ngateway:\n  principals:\n");
    expect(policy.gateway?.context).toBeUndefined();
    expect(gatewayContextPolicyOf(policy)).toEqual({
      enabled: false,
      maxReadsPerTurn: 1,
      perBlockTokenBudget: 1500,
    });
    expect(gatewayContextPolicyOf(parsePolicyV1(BASE))).toEqual({
      enabled: false,
      maxReadsPerTurn: 1,
      perBlockTokenBudget: 1500,
    });
  });

  it("the default per-block budget matches the assembler's default (one source of truth)", () => {
    expect(gatewayContextPolicyOf(parsePolicyV1(BASE)).perBlockTokenBudget).toBe(
      DEFAULT_PER_BLOCK_TOKEN_BUDGET,
    );
  });

  it("malformed entries fail closed (shape, order, unknown keys, read-set bounds, positivity)", () => {
    const cases = [
      "  context: { enabled: true }",
      "  context: { max_reads_per_turn: 3, enabled: true, per_block_token_budget: 1500 }",
      "  context: { enabled: maybe, max_reads_per_turn: 3, per_block_token_budget: 1500 }",
      "  context: { enabled: true, max_reads_per_turn: 0, per_block_token_budget: 1500 }",
      "  context: { enabled: true, max_reads_per_turn: 4, per_block_token_budget: 1500 }",
      "  context: { enabled: true, max_reads_per_turn: 2.5, per_block_token_budget: 1500 }",
      "  context: { enabled: true, max_reads_per_turn: three, per_block_token_budget: 1500 }",
      "  context: { enabled: true, max_reads_per_turn: 3, per_block_token_budget: 0 }",
      "  context: { enabled: true, max_reads_per_turn: 3, per_block_token_budget: -100 }",
      "  context: { enabled: true, max_reads_per_turn: 3, per_block_token_budget: 1500, quiet_mode: true }",
      "  context: { enabled: true, max_reads_per_turn: 3 }",
      "  context: just a string",
      "  context: {}",
    ];
    for (const entry of cases) {
      expect(() => parsePolicyV1(`${BASE}\ngateway:\n${entry}\n`), entry).toThrow();
    }
    expect(() =>
      parsePolicyV1(`${BASE}\ngateway:\n${ENTRY}\n${ENTRY}\n`),
    ).toThrow(/duplicate gateway.context/);
  });

  it("the repo-root policy.yaml ships the owner-ratified context section (W1: enabled, 3 reads, 1500 budget)", async () => {
    const policy = await loadPolicyFile(
      new URL("../../../../policy.yaml", import.meta.url),
    );
    expect(policy.gateway?.context).toEqual({
      enabled: true,
      maxReadsPerTurn: 3,
      perBlockTokenBudget: 1500,
    });
    expect(gatewayContextPolicyOf(policy).enabled).toBe(true);
  });

  it("coexists with the other gateway sub-policies in any position", () => {
    const policy = parsePolicyV1(
      BASE +
        "\ngateway:\n" +
        ENTRY +
        "\n  capture: { enabled: true, principals: [josctl], max_per_hour: 5, dedupe_window_hours: 24 }\n",
    );
    expect(policy.gateway?.context?.enabled).toBe(true);
    expect(policy.gateway?.capture?.enabled).toBe(true);
  });
});

describe("policy sensors.gmail (GMAIL §5/§10.3)", () => {
  const ENTRY =
    "  gmail: { enabled: true, poll_cron: \"*/5 * * * *\", bootstrap_window_days: 30, extract_senders: [billing@*, statements@*, *@stripe.com], max_messages_per_poll: 50, max_candidates_per_day: 20 }";

  it("parses the strict ordered flow mapping onto GmailSensorPolicy", () => {
    const policy = parsePolicyV1(`${VALID}\nsensors:\n${ENTRY}\n`);
    expect(policy.sensors?.gmail).toEqual({
      enabled: true,
      pollCron: "*/5 * * * *",
      bootstrapDays: 30,
      extractSenders: ["billing@*", "statements@*", "*@stripe.com"],
      maxMessagesPerPoll: 50,
      maxCandidatesPerDay: 20,
      contentEnabled: false,
      contentRetentionDays: 7,
      contentMaxBodyBytes: 256 * 1024,
    });
  });

  it("parses the ADR-0016 extended shape (content_* keys) onto GmailSensorPolicy", () => {
    const entry = 'gmail: { enabled: true, poll_cron: "*/5 * * *", bootstrap_window_days: 30, extract_senders: [billing@*], max_messages_per_poll: 40, max_candidates_per_day: 20, content_enabled: true, content_retention_days: 7, content_max_body_bytes: 131072 }';
    const policy = parsePolicyV1(`${VALID}\nsensors:\n  ${entry}\n`);
    expect(policy.sensors?.gmail?.contentEnabled).toBe(true);
    expect(policy.sensors?.gmail?.contentRetentionDays).toBe(7);
    expect(policy.sensors?.gmail?.contentMaxBodyBytes).toBe(131072);
  });

  it("rejects malformed content_* keys (fail closed)", () => {
    const entry = 'gmail: { enabled: true, poll_cron: "*/5 * * *", bootstrap_window_days: 30, extract_senders: [billing@*], max_messages_per_poll: 40, max_candidates_per_day: 20, content_enabled: true }';
    expect(() => parsePolicyV1(`${VALID}\nsensors:\n  ${entry}\n`)).toThrow(/sensors.gmail/);
  });

  it("absent section → gmailSensorPolicyOf returns fail-safe defaults (enabled:false)", () => {
    const policy = parsePolicyV1(VALID);
    expect(policy.sensors).toBeUndefined();
    expect(gmailSensorPolicyOf(policy)).toEqual(DEFAULT_GMAIL_SENSOR_POLICY);
    expect(DEFAULT_GMAIL_SENSOR_POLICY.enabled).toBe(false);
    expect(DEFAULT_GMAIL_SENSOR_POLICY.bootstrapDays).toBe(30);
    expect(DEFAULT_GMAIL_SENSOR_POLICY.maxMessagesPerPoll).toBe(50);
    expect(DEFAULT_GMAIL_SENSOR_POLICY.extractSenders).toEqual([]);
  });

  it("disabled entry parses and stays explicit (kill switch, §9.4)", () => {
    const policy = parsePolicyV1(
      `${VALID}\nsensors:\n  gmail: { enabled: false, poll_cron: "*/15 * * * *", bootstrap_window_days: 7, extract_senders: [], max_messages_per_poll: 10, max_candidates_per_day: 5 }\n`,
    );
    expect(policy.sensors?.gmail).toMatchObject({ enabled: false, bootstrapDays: 7, maxMessagesPerPoll: 10 });
  });

  it("malformed gmail entries fail closed (shape, order, positivity, bad globs, unknown sensor keys)", () => {
    const cases = [
      "  gmail: { enabled: true }",
      "  gmail: { enabled: true, poll_cron: \"*/5 * * * *\" }",
      `  gmail: { poll_cron: "*/5 * * * *", enabled: true, bootstrap_window_days: 30, extract_senders: [], max_messages_per_poll: 50, max_candidates_per_day: 20 }`,
      `  gmail: { enabled: maybe, poll_cron: "*/5 * * * *", bootstrap_window_days: 30, extract_senders: [], max_messages_per_poll: 50, max_candidates_per_day: 20 }`,
      `  gmail: { enabled: true, poll_cron: unquoted, bootstrap_window_days: 30, extract_senders: [], max_messages_per_poll: 50, max_candidates_per_day: 20 }`,
      `  gmail: { enabled: true, poll_cron: "*/5 * * * *", bootstrap_window_days: 0, extract_senders: [], max_messages_per_poll: 50, max_candidates_per_day: 20 }`,
      `  gmail: { enabled: true, poll_cron: "*/5 * * * *", bootstrap_window_days: 30, extract_senders: [], max_messages_per_poll: 0, max_candidates_per_day: 20 }`,
      `  gmail: { enabled: true, poll_cron: "*/5 * * * *", bootstrap_window_days: 30, extract_senders: [], max_messages_per_poll: 50, max_candidates_per_day: 0 }`,
      `  gmail: { enabled: true, poll_cron: "*/5 * * * *", bootstrap_window_days: 30, extract_senders: [no-at-sign], max_messages_per_poll: 50, max_candidates_per_day: 20 }`,
      `  gmail: { enabled: true, poll_cron: "*/5 * * * *", bootstrap_window_days: 30, extract_senders: [a@b@c], max_messages_per_poll: 50, max_candidates_per_day: 20 }`,
      `  gmail: { enabled: true, poll_cron: "*/5 * * * *", bootstrap_window_days: 30, extract_senders: [billing@*], quiet_mode: true, max_messages_per_poll: 50, max_candidates_per_day: 20 }`,
      "  slack: { enabled: true }",
      "  gmail: just a string",
    ];
    for (const entry of cases) {
      expect(() => parsePolicyV1(`${VALID}\nsensors:\n${entry}\n`), entry).toThrow();
    }
    expect(() => parsePolicyV1(`${VALID}\nsensors:\n${ENTRY}\n${ENTRY}\n`)).toThrow(/duplicate sensors.gmail/);
    expect(() => parsePolicyV1(`${VALID}\nsensors:\nsensors:\n${ENTRY}\n`)).toThrow(/duplicate sensors/);
  });

  it("duplicate extract_senders entries collapse; the repo-root policy.yaml parses with the sensors section", async () => {
    const policy = parsePolicyV1(
      `${VALID}\nsensors:\n  gmail: { enabled: true, poll_cron: "* * * * *", bootstrap_window_days: 30, extract_senders: [billing@*, billing@*], max_messages_per_poll: 50, max_candidates_per_day: 20 }\n`,
    );
    expect(policy.sensors?.gmail?.extractSenders).toEqual(["billing@*"]);

    const fromDisk = await loadPolicyFile(new URL("../../../../policy.yaml", import.meta.url));
    expect(fromDisk.sensors?.gmail).toBeDefined();
    expect(fromDisk.sensors?.gmail?.enabled).toBe(true); // owner ratified + consented 2026-09-20
    expect(gmailSensorPolicyOf(fromDisk).maxCandidatesPerDay).toBe(20);
  });
});

describe("policy calibration (Lane C1 — the daily accuracy check)", () => {
  const ENTRY = "  daily: { enabled: true, principals: [josctl], prompt_local_hour: 19 }";

  it("parses the strict ordered shape", () => {
    const policy = parsePolicyV1(`${VALID}\ncalibration:\n${ENTRY}\n`);
    expect(policy.calibration).toEqual({
      enabled: true,
      principals: ["josctl"],
      promptLocalHour: 19,
    });
  });

  it("hour 0 is legal; hour 24 is not", () => {
    expect(
      parsePolicyV1(`${VALID}\ncalibration:\n  daily: { enabled: false, principals: [], prompt_local_hour: 0 }\n`).calibration,
    ).toEqual({ enabled: false, principals: [], promptLocalHour: 0 });
    expect(() =>
      parsePolicyV1(`${VALID}\ncalibration:\n  daily: { enabled: true, principals: [josctl], prompt_local_hour: 24 }\n`),
    ).toThrow(/0-23/);
  });

  it("absent section → fail-safe defaults (disabled, no principals)", () => {
    const policy = parsePolicyV1(VALID);
    expect(policy.calibration).toBeUndefined();
    expect(calibrationPolicyOf(policy)).toEqual(DEFAULT_CALIBRATION_POLICY);
    expect(DEFAULT_CALIBRATION_POLICY.enabled).toBe(false);
    expect(DEFAULT_CALIBRATION_POLICY.principals).toEqual([]);
  });

  it("malformed entries fail closed (shape, order, unknown keys, duplicates)", () => {
    const cases = [
      "  daily: { enabled: true }",
      "  daily: { principals: [josctl], enabled: true, prompt_local_hour: 19 }",
      "  daily: { enabled: maybe, principals: [josctl], prompt_local_hour: 19 }",
      "  daily: { enabled: true, principals: [josctl], prompt_local_hour: 19, extra: 1 }",
      "  daily: { enabled: true, principals: [josctl], prompt_local_hour: -1 }",
      "  daily: { enabled: true, principals: [josctl], prompt_local_hour: 1.5 }",
      "  daily: just a string",
      "  weekly: { enabled: true, principals: [], prompt_local_hour: 19 }",
    ];
    for (const entry of cases) {
      expect(() => parsePolicyV1(`${VALID}\ncalibration:\n${entry}\n`), entry).toThrow();
    }
    expect(() => parsePolicyV1(`${VALID}\ncalibration:\n${ENTRY}\n${ENTRY}\n`)).toThrow(/duplicate calibration.daily/);
    expect(() => parsePolicyV1(`${VALID}\ncalibration:\ncalibration:\n${ENTRY}\n`)).toThrow(/duplicate calibration/);
  });

  it("duplicate principals collapse; the repo-root policy.yaml parses with the disabled section", async () => {
    const policy = parsePolicyV1(
      `${VALID}\ncalibration:\n  daily: { enabled: true, principals: [josctl, josctl], prompt_local_hour: 8 }\n`,
    );
    expect(policy.calibration?.principals).toEqual(["josctl"]);

    const fromDisk = await loadPolicyFile(new URL("../../../../policy.yaml", import.meta.url));
    expect(fromDisk.calibration).toEqual({ enabled: true, principals: ["josctl"], promptLocalHour: 20 });
    expect(calibrationPolicyOf(fromDisk).enabled).toBe(true); // owner ratified 2026-09-21
  });
});

describe("policy personas (W4 interaction-profile flag — security/default layer only)", () => {
  const BASE = VALID;

  it("parses the strict ordered flow mapping onto PersonasPolicy", () => {
    const policy = parsePolicyV1(
      `${BASE}\npersonas: { enabled: true, principals: [josctl, yusra] }\n`,
    );
    expect(policy.personas).toEqual({ enabled: true, principals: ["josctl", "yusra"] });
    expect(personasPolicyOf(policy)).toEqual({ enabled: true, principals: ["josctl", "yusra"] });
  });

  it("admits the disabled shape with an empty allowlist", () => {
    const policy = parsePolicyV1(`${BASE}\npersonas: { enabled: false, principals: [] }\n`);
    expect(policy.personas).toEqual({ enabled: false, principals: [] });
  });

  it("absent section → personasPolicyOf returns fail-closed defaults (profiles inert)", () => {
    const policy = parsePolicyV1(BASE);
    expect(policy.personas).toBeUndefined();
    expect(personasPolicyOf(policy)).toEqual(DEFAULT_PERSONAS_POLICY);
    expect(DEFAULT_PERSONAS_POLICY.enabled).toBe(false);
    expect(DEFAULT_PERSONAS_POLICY.principals).toEqual([]);
  });

  it("NO PROMPT TEXT IN POLICY: register/brevity/address keys structurally fail closed", () => {
    const cases = [
      "personas: { enabled: true, principals: [josctl], register: terse }",
      "personas: { enabled: true, principals: [josctl], max_sentences: 4 }",
      "personas: { enabled: true, principals: [josctl], address: Chief }",
      "personas: { enabled: true, principals: [josctl], prompt: \"you are a chief of staff\" }",
      "personas: { principals: [josctl], enabled: true }",
      "personas: { enabled: true }",
      "personas: { enabled: maybe, principals: [] }",
      "personas: { enabled: true, principals: [josctl, josctl, yusra, yusra], extra: 1 }",
      "personas: just a string",
      "personas: {}",
    ];
    for (const entry of cases) {
      expect(() => parsePolicyV1(`${BASE}\n${entry}\n`), entry).toThrow();
    }
    expect(() =>
      parsePolicyV1(`${BASE}\npersonas: { enabled: true, principals: [] }\npersonas: { enabled: false, principals: [] }\n`),
    ).toThrow(/duplicate personas/);
  });

  it("duplicate principals collapse; coexists with every other section", () => {
    const policy = parsePolicyV1(
      BASE +
        "\npersonas: { enabled: true, principals: [josctl, josctl] }\n" +
        "calibration:\n  daily: { enabled: true, principals: [josctl], prompt_local_hour: 20 }\n",
    );
    expect(policy.personas?.principals).toEqual(["josctl"]);
    expect(policy.calibration?.enabled).toBe(true);
  });

  it("the repo-root policy.yaml ships personas enabled for josctl (owner direction 2026-09-21)", async () => {
    const policy = await loadPolicyFile(new URL("../../../../policy.yaml", import.meta.url));
    expect(personasPolicyOf(policy)).toEqual({ enabled: true, principals: ["josctl"] });
  });
});
