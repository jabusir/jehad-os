// Action registry (ADR-0018 §1.6; W1 contract) — hermetic. Fail-closed
// lookup, per-action argument validators, server-provided labels, and the
// no-endpoints invariant: no URL/endpoint field exists anywhere.

import { describe, expect, it } from "vitest";
import { ATTENTION_ACTION_REGISTRY, getActionDescriptor } from "./actions-registry.js";
import { ATTENTION_ACTION_KEYS } from "./types.js";

describe("attention action registry", () => {
  it("unknown key → null (fail-closed), never a guess", () => {
    expect(getActionDescriptor("attention.nope")).toBeNull();
    expect(getActionDescriptor("outcome.delete")).toBeNull();
    expect(getActionDescriptor("")).toBeNull();
  });

  it("covers exactly the contract keys with the contract kinds", () => {
    for (const key of ATTENTION_ACTION_KEYS) {
      expect(getActionDescriptor(key), key).not.toBeNull();
    }
    expect(ATTENTION_ACTION_REGISTRY["attention.resolve"].kind).toBe("resolve");
    expect(ATTENTION_ACTION_REGISTRY["attention.dismiss"].kind).toBe("dismiss");
    expect(ATTENTION_ACTION_REGISTRY["attention.snooze"].kind).toBe("snooze");
    expect(ATTENTION_ACTION_REGISTRY["attention.seen"].kind).toBe("seen");
    expect(ATTENTION_ACTION_REGISTRY["attention.feedback"].kind).toBe("feedback");
    expect(ATTENTION_ACTION_REGISTRY["outcome.open"].kind).toBe("link");
  });

  it("no URL/endpoint fields anywhere in the registry", () => {
    const serialized = JSON.stringify(ATTENTION_ACTION_REGISTRY);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toContain("url");
    expect(serialized).not.toContain("endpoint");
  });

  it("snooze args: positive finite minutes, or none (default applies)", () => {
    const descriptor = ATTENTION_ACTION_REGISTRY["attention.snooze"];
    expect(descriptor.validateArgs(undefined)).toBe(true);
    expect(descriptor.validateArgs({})).toBe(true);
    expect(descriptor.validateArgs({ minutes: 15 })).toBe(true);
    expect(descriptor.validateArgs({ minutes: 0 })).toBe(false);
    expect(descriptor.validateArgs({ minutes: -5 })).toBe(false);
    expect(descriptor.validateArgs({ minutes: "15" })).toBe(false);
    expect(descriptor.defaultArgs).toEqual({ minutes: 60 });
  });

  it("feedback args: verdict must be in the vocabulary", () => {
    const descriptor = ATTENTION_ACTION_REGISTRY["attention.feedback"];
    expect(descriptor.validateArgs({ verdict: "useful" })).toBe(true);
    expect(descriptor.validateArgs({ verdict: "noise" })).toBe(true);
    expect(descriptor.validateArgs({ verdict: "meh" })).toBe(false);
    expect(descriptor.validateArgs(undefined)).toBe(false);
    expect(descriptor.validateArgs({})).toBe(false);
  });

  it("outcome.open args: requires a non-empty ref (ids only — no URLs)", () => {
    const descriptor = ATTENTION_ACTION_REGISTRY["outcome.open"];
    expect(descriptor.validateArgs({ ref: "abc" })).toBe(true);
    expect(descriptor.validateArgs({ ref: "" })).toBe(false);
    expect(descriptor.validateArgs(undefined)).toBe(false);
    expect(descriptor.validateArgs({})).toBe(false);
  });

  it("labels are server-provided constants, never row-provided", () => {
    expect(ATTENTION_ACTION_REGISTRY["attention.resolve"].label()).toBe("Resolve");
    expect(ATTENTION_ACTION_REGISTRY["attention.snooze"].label({ minutes: 15 })).toBe("Snooze 15m");
    expect(ATTENTION_ACTION_REGISTRY["attention.snooze"].label()).toBe("Snooze 60m");
    expect(ATTENTION_ACTION_REGISTRY["outcome.open"].label({ ref: "abc" })).toBe("Open outcome");
    expect(ATTENTION_ACTION_REGISTRY["attention.feedback"].label({ verdict: "noise" })).toBe("Feedback: noise");
  });
});
