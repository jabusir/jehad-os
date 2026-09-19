// paired.ts tests — the heartbeat-config module where the paired-handle
// cache and the ONE shared handle normalizer live (multi-principal
// contract; see the module doc in src/paired.ts for the normalization
// rules being pinned here).

import { describe, expect, it } from "vitest";
import { normalizeHandle, parsePairedHandlesBody, PairedHandleCache } from "../src/paired.js";

describe("normalizeHandle (shared by server list + chat.db handles)", () => {
  it("phones: strips formatting, keeps digits, forces the + prefix", () => {
    expect(normalizeHandle("+15550000001")).toBe("+15550000001");
    expect(normalizeHandle("15550000001")).toBe("+15550000001");
    expect(normalizeHandle("+1 (555) 000-0001")).toBe("+15550000001");
    expect(normalizeHandle("+1.555.000.0001")).toBe("+15550000001");
    expect(normalizeHandle(" +15550000001 ")).toBe("+15550000001");
  });

  it("emails: trim + lowercase only", () => {
    expect(normalizeHandle("Yusra@ICLOUD.com")).toBe("yusra@icloud.com");
    expect(normalizeHandle("  Yusra@ICLOUD.com ")).toBe("yusra@icloud.com");
  });

  it("deliberately does NOT pad country codes (bare 10-digit local form stays distinct)", () => {
    expect(normalizeHandle("5550000001")).not.toBe(normalizeHandle("+15550000001"));
  });

  it("blank → empty string (never matches anything)", () => {
    expect(normalizeHandle("")).toBe("");
    expect(normalizeHandle("   ")).toBe("");
  });
});

describe("parsePairedHandlesBody", () => {
  it("valid body → the handle list (empty list is valid: no principals paired)", () => {
    expect(parsePairedHandlesBody({ paired_handles: [] })).toEqual({ ok: true, handles: [] });
    expect(parsePairedHandlesBody({ paired_handles: ["+15550000001"] })).toEqual({
      ok: true,
      handles: ["+15550000001"],
    });
  });

  it("absent body (204 old server) → absent", () => {
    expect(parsePairedHandlesBody(null)).toEqual({ ok: false, reason: "absent" });
    expect(parsePairedHandlesBody(undefined)).toEqual({ ok: false, reason: "absent" });
  });

  it("wrong shapes → invalid (fail closed)", () => {
    expect(parsePairedHandlesBody({})).toEqual({ ok: false, reason: "invalid" });
    expect(parsePairedHandlesBody({ paired_handles: "x" })).toEqual({ ok: false, reason: "invalid" });
    expect(parsePairedHandlesBody({ paired_handles: [123] })).toEqual({ ok: false, reason: "invalid" });
    expect(parsePairedHandlesBody({ paired_handles: [""] })).toEqual({ ok: false, reason: "invalid" });
    expect(parsePairedHandlesBody("nope")).toEqual({ ok: false, reason: "invalid" });
    expect(parsePairedHandlesBody([{ paired_handles: [] }])).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("PairedHandleCache", () => {
  it("matches chat.db formatting variants against canonical server handles", () => {
    const cache = new PairedHandleCache();
    cache.refresh(["+15550000001", "yusra@icloud.com"]);
    expect(cache.has("+1 (555) 000-0001")).toBe(true);
    expect(cache.has("15550000001")).toBe(true);
    expect(cache.has("Yusra@ICLOUD.com")).toBe(true);
    expect(cache.has("+15550000002")).toBe(false);
    expect(cache.has("5550000001")).toBe(false);
  });

  it("null/empty handles never match", () => {
    const cache = new PairedHandleCache();
    cache.refresh(["+15550000001"]);
    expect(cache.has(null)).toBe(false);
    expect(cache.has("")).toBe(false);
  });

  it("refresh replaces the cache wholesale (unpairing takes effect)", () => {
    const cache = new PairedHandleCache();
    cache.refresh(["+15550000001"]);
    expect(cache.has("+15550000001")).toBe(true);
    cache.refresh([]);
    expect(cache.has("+15550000001")).toBe(false);
    expect(cache.size).toBe(0);
  });
});
