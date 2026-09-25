// Control-plane reliability wave, goal 1 — the canonical repo-policy
// loader's unit contract: ONE path resolution (src/ and dist/ depth),
// POLICY_YAML_PATH override, fail-closed parse, loud failure state, and
// 60s TTL last-good retention.

import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRepoPolicyCache, repoPolicyPath, loadRepoPolicy } from "./repo-policy.js";

const REPO_ROOT_POLICY = new URL("../../../../policy.yaml", import.meta.url).pathname;
const FIXTURE = new URL("../imessage/cognitive-test.policy.yaml", import.meta.url).pathname;

afterEach(() => {
  delete process.env.POLICY_YAML_PATH;
  resetRepoPolicyCache();
  vi.useRealTimers();
});

describe("repoPolicyPath (goal 1: one canonical resolution)", () => {
  it("resolves the REPO ROOT policy.yaml — never packages/policy.yaml (the §24 F1 off-by-one)", () => {
    const path = repoPolicyPath();
    expect(path).toBe(REPO_ROOT_POLICY);
    expect(path.endsWith("/policy.yaml")).toBe(true);
    expect(path.endsWith("/packages/policy.yaml")).toBe(false);
    // The resolved file actually exists in this checkout.
    expect(existsSync(path)).toBe(true);
  });

  it("POLICY_YAML_PATH overrides (the test/staging fixture seam)", () => {
    process.env.POLICY_YAML_PATH = FIXTURE;
    expect(repoPolicyPath()).toBe(FIXTURE);
  });
});

describe("loadRepoPolicy", () => {
  it("parses the real repo policy: routing, passes, principals, personas all present", async () => {
    const state = await loadRepoPolicy();
    expect(state.lastAttemptFailed).toBe(false);
    expect(state.policy).not.toBeNull();
    // The live pins the cognitive turn depends on (checked dynamically so
    // this test never drifts from policy.yaml edits).
    expect(["single", "legacy"]).toContain(state.policy!.gateway?.routing ?? null);
    expect(state.policy!.gateway?.passes?.route?.model).toMatch(/^[a-z]+\/[a-z0-9.\-]+$/);
    expect(state.policy!.gateway?.passes?.answer_standard?.model).toMatch(/^[a-z]+\/[a-z0-9.\-]+$/);
    expect(Object.keys(state.policy!.gateway?.principals ?? {}).length).toBeGreaterThan(0);
    expect(state.policy!.personas?.enabled).toBe(true);
  });

  it("POLICY_YAML_PATH fixture loads through the same implementation", async () => {
    process.env.POLICY_YAML_PATH = FIXTURE;
    const state = await loadRepoPolicy();
    expect(state.policy?.gateway?.routing).toBe("single");
    expect(state.policy?.gateway?.principals["josctl"]).toBeDefined();
  });

  it("a MISSING expected policy is a loud failure — never a silent null that pretends to be config", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      process.env.POLICY_YAML_PATH = "/nonexistent/definitely/not/here/policy.yaml";
      const state = await loadRepoPolicy();
      expect(state.policy).toBeNull();
      expect(state.lastAttemptFailed).toBe(true);
      expect(state.lastError).toContain("ENOENT");
      // LOUD: the stderr marker a dogfooder can grep in service logs.
      expect(errors.some((line) => line.includes("[repo-policy] load failed"))).toBe(true);
    } finally {
      console.error = original;
    }
  });

  it("an INVALID (unparseable) policy is a loud failure too (fail-closed parse)", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      process.env.POLICY_YAML_PATH = new URL("../imessage/redact.ts", import.meta.url).pathname;
      const state = await loadRepoPolicy();
      expect(state.policy).toBeNull();
      expect(state.lastAttemptFailed).toBe(true);
    } finally {
      console.error = original;
    }
  });

  it("last-good retention: a transient failure after a good load keeps the good policy, flagged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    process.env.POLICY_YAML_PATH = FIXTURE;
    const good = await loadRepoPolicy();
    expect(good.policy?.gateway?.routing).toBe("single");
    // TTL expires; the next attempt fails (file gone) — last good holds,
    // loudly flagged so callers can audit the degradation.
    vi.setSystemTime(new Date("2026-09-25T12:01:30Z"));
    const original = console.error;
    console.error = () => {};
    try {
      process.env.POLICY_YAML_PATH = "/nonexistent/policy.yaml";
      const degraded = await loadRepoPolicy();
      expect(degraded.policy?.gateway?.routing).toBe("single");
      expect(degraded.lastAttemptFailed).toBe(true);
    } finally {
      console.error = original;
    }
  });
});
