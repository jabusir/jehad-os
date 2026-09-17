import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ActionProhibitedError,
  V1_AUTONOMY_POLICY,
  assertAllowedByCeiling,
  autonomyPolicyFromPolicyV1,
  defaultPolicyYamlPath,
  resolveAutonomyPolicy,
} from "./autonomy.js";
import { loadPolicyFile } from "../policy/ceiling.js";

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

describe("R8: policy.yaml is the ceiling's single source (ADR-0003)", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("the repo policy.yaml equals the hardcoded fallback (no silent drift)", async () => {
    const fromFile = autonomyPolicyFromPolicyV1(await loadPolicyFile(defaultPolicyYamlPath()));
    expect(fromFile.actions).toEqual(V1_AUTONOMY_POLICY.actions);
  });

  it("resolves the default policy.yaml without a warning", async () => {
    const warn = vi.fn();
    const policy = await resolveAutonomyPolicy(undefined, { warn });
    expect(policy.actions).toEqual(V1_AUTONOMY_POLICY.actions);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a missing file falls back to the hardcoded ceiling WITH a warning", async () => {
    const warn = vi.fn();
    const dir = await mkdtemp(path.join(tmpdir(), "jehad-nopolicy-"));
    dirs.push(dir);
    const policy = await resolveAutonomyPolicy(path.join(dir, "does-not-exist.yaml"), { warn });
    expect(policy.actions).toEqual(V1_AUTONOMY_POLICY.actions);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("falling back");
  });

  it("a malformed file throws fail-closed — never a silent fallback", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jehad-badpolicy-"));
    dirs.push(dir);
    const file = path.join(dir, "policy.yaml");
    await writeFile(file, "version: 1\nautonomy_ceiling:\n  read: super_allowed\n");
    const warn = vi.fn();
    await expect(resolveAutonomyPolicy(file, { warn })).rejects.toThrow(/invalid autonomy level/);
    expect(warn).not.toHaveBeenCalled();
  });
});
