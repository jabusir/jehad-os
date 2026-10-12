// attention-liveness workflow tests (W1, hermetic — no database, no real
// kernel): @jehad/core is mocked with contract-shaped stubs, policy is
// injected, and the core seams (sweep/retry) are spy-counted. Pins: the
// cron registration, the kill switch (`attention.enabled !== false`),
// the 07:00–22:00 local-PT retry guard (DST-safe), and policy parsing.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attentionLivenessWorkflow,
  ATTENTION_LIVENESS_CRON,
  attentionPolicyOf,
  isAttentionRetryLocalHour,
  loadAttentionPolicy,
  localAttentionRetryHour,
  runAttentionLivenessTick,
} from "./attention-workflows.js";
import { livenessSweep, retryEligibleUndelivered } from "@jehad/core";

vi.mock("@jehad/core", async () => {
  const YAML = await import("yaml");
  return {
    // brief-workflows imports these at module scope — keep the module graph real.
    BRIEF_TIMEZONE: "America/Los_Angeles",
    renderMorningBrief: vi.fn(),
    renderEveningClose: vi.fn(),
    // attention-workflows' core seams (contract signatures).
    livenessSweep: vi.fn(async () => ({ checked: 0, resolved: 0 })),
    retryEligibleUndelivered: vi.fn(async () => 0),
    parsePolicyV1: (text: string) => YAML.parse(text),
  };
});

const sweepMock = vi.mocked(livenessSweep);
const retryMock = vi.mocked(retryEligibleUndelivered);

// A db executor the stubs never actually touch (the seams are mocked).
const stubDb = { query: async () => ({ rows: [] as unknown[] }) };

/** Fixed instants, DST-aware: June is PDT (UTC-7), January is PST (UTC-8). */
const AT_7AM_PT = new Date("2026-06-15T14:00:00.000Z"); // 07:00 PT — window opens
const AT_1PM_PT = new Date("2026-06-15T20:00:00.000Z"); // 13:00 PT — midday
const AT_1059PM_PT = new Date("2026-06-16T05:59:00.000Z"); // 22:59 PT Jun 15 — past close
const AT_1130PM_PT = new Date("2026-06-16T06:30:00.000Z"); // 23:30 PT Jun 15 — quiet
const AT_7AM_PST = new Date("2026-01-15T15:00:00.000Z"); // 07:00 PT in winter — DST proof

let policyDir: string;

beforeAll(async () => {
  policyDir = await mkdtemp(path.join(tmpdir(), "attention-policy-"));
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["POLICY_YAML_PATH"];
});

afterAll(async () => {
  await rm(policyDir, { recursive: true, force: true });
});

describe("attention-liveness registration", () => {
  it("is a scheduled workflow on the */5 cron", () => {
    expect(attentionLivenessWorkflow.kind).toBe("cron");
    expect(attentionLivenessWorkflow.name).toBe("attention-liveness");
    expect(attentionLivenessWorkflow.cron).toBe(ATTENTION_LIVENESS_CRON);
    expect(ATTENTION_LIVENESS_CRON).toBe("*/5 * * * *");
    expect(typeof attentionLivenessWorkflow.fn).toBe("function");
  });
});

describe("attentionPolicyOf (kill switch is `enabled !== false`)", () => {
  it("absent section ⇒ enabled (the contract-literal default)", () => {
    expect(attentionPolicyOf({})).toEqual({ enabled: true, cooldownMinutes: 60 });
    expect(attentionPolicyOf(null)).toEqual({ enabled: true, cooldownMinutes: 60 });
    expect(attentionPolicyOf(undefined)).toEqual({ enabled: true, cooldownMinutes: 60 });
  });

  it("enabled:false is the kill switch; cooldownMinutes parses (both spellings, invalid → default)", () => {
    expect(attentionPolicyOf({ attention: { enabled: false } })).toEqual({
      enabled: false,
      cooldownMinutes: 60,
    });
    expect(attentionPolicyOf({ attention: { cooldownMinutes: 45 } })).toEqual({
      enabled: true,
      cooldownMinutes: 45,
    });
    expect(attentionPolicyOf({ attention: { cooldown_minutes: 30 } })).toEqual({
      enabled: true,
      cooldownMinutes: 30,
    });
    expect(attentionPolicyOf({ attention: { cooldownMinutes: -1 } })).toEqual({
      enabled: true,
      cooldownMinutes: 60,
    });
  });
});

describe("local retry window guard ([07:00, 22:00) America/Los_Angeles)", () => {
  it("boundary + off-window instants", () => {
    expect(localAttentionRetryHour(AT_7AM_PT)).toBe(7);
    expect(isAttentionRetryLocalHour(AT_7AM_PT)).toBe(true); // 07:00 PT — opens
    expect(isAttentionRetryLocalHour(AT_1PM_PT)).toBe(true); // 13:00 PT
    expect(isAttentionRetryLocalHour(AT_1059PM_PT)).toBe(false); // 22:59 PT — past 22:00
    expect(isAttentionRetryLocalHour(AT_1130PM_PT)).toBe(false); // 23:30 PT
    expect(isAttentionRetryLocalHour(AT_7AM_PST)).toBe(true); // winter 07:00 PT — DST-safe
  });
});

describe("runAttentionLivenessTick", () => {
  it("kill switch (attention.enabled=false) skips every step", async () => {
    const result = await runAttentionLivenessTick(stubDb, {
      now: AT_1PM_PT,
      policy: { enabled: false, cooldownMinutes: 60 },
    });
    expect(result).toEqual({ status: "disabled" });
    expect(sweepMock).not.toHaveBeenCalled();
    expect(retryMock).not.toHaveBeenCalled();
  });

  it("inside the window: sweep runs, retry runs with the policy cooldown, counts flow through", async () => {
    sweepMock.mockResolvedValueOnce({ checked: 3, resolved: 1 });
    retryMock.mockResolvedValueOnce(2);
    const result = await runAttentionLivenessTick(stubDb, {
      now: AT_1PM_PT,
      policy: { enabled: true, cooldownMinutes: 45 },
    });
    expect(result).toEqual({
      status: "completed",
      skippedWindow: false,
      sweep: { checked: 3, resolved: 1 },
      retried: 2,
    });
    expect(sweepMock).toHaveBeenCalledTimes(1);
    expect(sweepMock).toHaveBeenCalledWith(stubDb, { now: AT_1PM_PT });
    expect(retryMock).toHaveBeenCalledTimes(1);
    expect(retryMock).toHaveBeenCalledWith(stubDb, {
      now: AT_1PM_PT,
      config: { cooldownMinutes: 45 },
    });
  });

  it("outside the window: sweep still runs, retry is a clean no-op", async () => {
    const result = await runAttentionLivenessTick(stubDb, {
      now: AT_1130PM_PT,
      policy: { enabled: true, cooldownMinutes: 60 },
    });
    expect(result.status).toBe("completed");
    expect(result.skippedWindow).toBe(true);
    expect(result.retried).toBe(0);
    expect(sweepMock).toHaveBeenCalledTimes(1);
    expect(retryMock).not.toHaveBeenCalled();
  });

  it("policy defaults apply when none is injected (loader consulted)", async () => {
    const fixture = path.join(policyDir, "policy.yaml");
    await writeFile(
      fixture,
      ["version: 1", "attention:", "  enabled: false", "  cooldownMinutes: 15", ""].join("\n"),
      "utf8",
    );
    process.env["POLICY_YAML_PATH"] = fixture;
    const result = await runAttentionLivenessTick(stubDb, { now: AT_1PM_PT });
    expect(result).toEqual({ status: "disabled" });
    expect(sweepMock).not.toHaveBeenCalled();
    // And the loader itself surfaces the section for direct callers.
    expect(await loadAttentionPolicy()).toEqual({ enabled: false, cooldownMinutes: 15 });
  });
});
