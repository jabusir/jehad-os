// Notification policy config tests (E4). Unit-only; the repo-root policy.yaml
// is the artifact under test for the shipped defaults, and the strict
// parsePolicyV1 extension must fail closed on every deviation.

import { describe, expect, it } from "vitest";
import { parsePolicyV1 } from "../policy/ceiling.js";
import {
  DEFAULT_NOTIFICATIONS_CONFIG,
  notificationsConfigFromPolicyV1,
} from "./config.js";

const BASE = `\
version: 1
autonomy_ceiling:
  read: autonomous
  propose: autonomous
  write_canonical: gated
  external_side_effect: approval_required
  money_and_contracts: prohibited
`;

const WITH_NOTIFICATIONS = `${BASE}\
notifications:
  autoApproveKinds: ["brief"]
  escalationMinUrgency: high
  defaultTtlMinutes: 240
`;

describe("notifications policy section (policy.yaml)", () => {
  it("parses the section; absent section yields defaults", () => {
    expect(parsePolicyV1(WITH_NOTIFICATIONS).notifications).toEqual({
      autoApproveKinds: ["brief"],
      escalationMinUrgency: "high",
      defaultTtlMinutes: 240,
    });
    expect(parsePolicyV1(BASE).notifications).toBeUndefined();
  });

  it("partial sections fill from defaults", () => {
    const parsed = parsePolicyV1(`${BASE}notifications:\n  escalationMinUrgency: critical\n`);
    expect(parsed.notifications).toEqual({
      autoApproveKinds: ["brief"],
      escalationMinUrgency: "critical",
      defaultTtlMinutes: 240,
    });
  });

  it("fails closed on structural deviations", () => {
    const cases = [
      `${BASE}notifications:\n  unknownKey: 1\n`,               // unknown key
      `${BASE}notifications:\n  autoApproveKinds: brief\n`,      // not a flow list
      `${BASE}notifications:\n  autoApproveKinds: ["brief"]\n  autoApproveKinds: ["brief"]\n`, // duplicate
      `${BASE}notifications:\n  autoApproveKinds: ["a", "a"]\n`, // duplicate entry
      `${BASE}notifications:\n  autoApproveKinds: []\n`,         // empty list
      `${BASE}notifications:\n  autoApproveKinds: [brief]\n`,    // unquoted entry
      `${BASE}notifications:\n  escalationMinUrgency: urgent\n`, // outside vocabulary
      `${BASE}notifications:\n  defaultTtlMinutes: 0\n`,         // non-positive
      `${BASE}notifications:\n  defaultTtlMinutes: soon\n`,      // non-numeric
      `${BASE}notifications: inline\n`,                          // section must be a mapping
      `${BASE}notifications:\n  escalationMinUrgency: high\nnotifications:\n  escalationMinUrgency: low\n`, // duplicate section
    ];
    for (const text of cases) {
      expect(() => parsePolicyV1(text), JSON.stringify(text)).toThrow();
    }
  });

  it("projects onto the config; unknown kinds drop out fail-safe", () => {
    const config = notificationsConfigFromPolicyV1(
      parsePolicyV1(`${BASE}notifications:\n  autoApproveKinds: ["brief", "nonsense"]\n`),
    );
    expect(config.autoApproveKinds).toEqual(["brief"]);
    expect(notificationsConfigFromPolicyV1(null)).toEqual(DEFAULT_NOTIFICATIONS_CONFIG);
  });

  it("the repo-root policy.yaml ships the documented notification keys", async () => {
    const { loadNotificationsConfig } = await import("./config.js");
    const config = await loadNotificationsConfig();
    expect(config).toEqual({
      autoApproveKinds: ["brief", "calendar-change", "calibration"],
      escalationMinUrgency: "high",
      defaultTtlMinutes: 240,
    });
  });

  it("calendar-change is a known kind; auto-approve survives the vocabulary drop-filter", () => {
    const config = notificationsConfigFromPolicyV1(
      parsePolicyV1(`${BASE}notifications:\n  autoApproveKinds: ["brief", "calendar-change"]\n`),
    );
    expect(config.autoApproveKinds).toEqual(["brief", "calendar-change"]);
  });
});
