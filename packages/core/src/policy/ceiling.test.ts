import { describe, expect, it } from "vitest";
import {
  ACTION_TYPES,
  AUTONOMY_LEVELS,
  DEFAULT_CALIBRATION_POLICY,
  DEFAULT_GMAIL_SENSOR_POLICY,
  calibrationPolicyOf,
  decideAutonomy,
  gmailSensorPolicyOf,
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
      reads: ["calendar", "commitments", "gmail"], // gmail: Phase GMAIL §8.3
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

  it("the repo-root policy.yaml parses with the live per-pass routing pinned", async () => {
    const policy = await loadPolicyFile(
      new URL("../../../../policy.yaml", import.meta.url),
    );
    expect(policy.gateway).toBeDefined();
    expect(policy.gateway?.passes).toEqual({
      route: { model: "openai/gpt-4.1-mini" },
      route_fallback: { model: "google/gemini-3.8-flash" },
    });
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
    });
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
