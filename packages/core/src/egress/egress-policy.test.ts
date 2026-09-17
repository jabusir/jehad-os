// Egress policy tests (ADR-0012; plan §9; T12). Hermetic except for reading
// the repo-root egress-policy.yaml — that file is the artifact under test.

import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@jehad/adapters";
import type { SqlExecutor } from "../policy/grants.js";
import {
  EgressDenialError,
  EgressPolicyError,
  ModelEgressPolicyRegistry,
  egressGatedModelProvider,
  loadEgressPolicyRegistry,
  parseEgressPolicy,
  type EgressPolicyRule,
} from "./index.js";

describe("v1 egress-policy.yaml (repo root)", () => {
  it("loads and builds a registry", async () => {
    const registry = await loadEgressPolicyRegistry();
    expect(registry.rules.map((r) => r.id).sort()).toEqual([
      "finance-sensitive",
      "personal-normal",
      "secret-never",
      "work-remote-employer",
    ]);
  });

  it("personal.normal + openrouter → allowed (plan §9 starter posture)", async () => {
    const registry = await loadEgressPolicyRegistry();
    expect(registry.check({ domainId: "personal", sensitivity: "normal", provider: "openrouter" })).toEqual({
      allowed: true,
      ruleId: "personal-normal",
      requireRedaction: false,
    });
  });

  it("finance.sensitive + openrouter (unauthorized) → DENIED with auditable reason", async () => {
    const registry = await loadEgressPolicyRegistry();
    const decision = registry.check({ domainId: "finance", sensitivity: "sensitive", provider: "openrouter" });
    expect(decision).toMatchObject({ allowed: false, reason: "provider_not_allowed", ruleId: "finance-sensitive" });

    try {
      registry.assertAllowed({ domainId: "finance", sensitivity: "sensitive", provider: "openrouter", model: "some-model" });
      expect.unreachable("assertAllowed must throw on denial");
    } catch (err) {
      expect(err).toBeInstanceOf(EgressDenialError);
      const denial = err as EgressDenialError;
      expect(denial.audit).toMatchObject({
        code: "egress.denied",
        reason: "provider_not_allowed",
        ruleId: "finance-sensitive",
        request: { domainId: "finance", sensitivity: "sensitive", provider: "openrouter", model: "some-model" },
      });
      expect(denial.audit.message).toContain("openrouter");
    }
  });

  it("work.remote-employer + personal provider (openrouter) → DENIED (T15)", async () => {
    const registry = await loadEgressPolicyRegistry();
    const decision = registry.check({ domainId: "work", sensitivity: "sensitive", provider: "openrouter" });
    expect(decision).toMatchObject({ allowed: false, reason: "provider_not_allowed", ruleId: "work-remote-employer" });
  });

  it("secret sensitivity → never in model context, any domain, any provider", async () => {
    const registry = await loadEgressPolicyRegistry();
    for (const provider of ["openrouter", "anthropic", "employer-approved"]) {
      for (const domainId of ["personal", "finance", "work"]) {
        expect(registry.check({ domainId, sensitivity: "secret", provider })).toMatchObject({
          allowed: false,
          reason: "secret_never_in_model_context",
        });
      }
    }
  });

  it("unknown domain/sensitivity combination → denied by default (no matching rule)", async () => {
    const registry = await loadEgressPolicyRegistry();
    expect(registry.check({ domainId: "research", sensitivity: "sensitive", provider: "openrouter" })).toMatchObject({
      allowed: false,
      reason: "no_matching_rule",
    });
  });
});

describe("code invariants (hold even against misconfigured policy)", () => {
  it("secret is denied even when a catch-all rule would allow everything", () => {
    const registry = new ModelEgressPolicyRegistry([
      {
        id: "catch-all",
        domainId: "*",
        sensitivity: "*",
        allowedProviders: ["openrouter"],
        allowRemote: true,
        requireRedaction: false,
      },
    ]);
    expect(registry.check({ domainId: "personal", sensitivity: "secret", provider: "openrouter" })).toMatchObject({
      allowed: false,
      reason: "secret_never_in_model_context",
    });
    expect(registry.check({ domainId: "personal", sensitivity: "normal", provider: "openrouter" }).allowed).toBe(true);
  });

  it("most-specific rule wins over wildcards", () => {
    const registry = new ModelEgressPolicyRegistry([
      { id: "any-any", domainId: "*", sensitivity: "*", allowedProviders: ["openrouter"], allowRemote: true, requireRedaction: false },
      { id: "finance-sensitive", domainId: "finance", sensitivity: "sensitive", allowedProviders: [], allowRemote: false, requireRedaction: true },
    ]);
    expect(registry.check({ domainId: "finance", sensitivity: "sensitive", provider: "openrouter" })).toMatchObject({
      allowed: false,
      ruleId: "finance-sensitive",
    });
    expect(registry.check({ domainId: "research", sensitivity: "normal", provider: "openrouter" })).toMatchObject({
      allowed: true,
      ruleId: "any-any",
    });
  });

  it("allowedModels is fail-closed: wrong model denied, missing model denied", () => {
    const registry = new ModelEgressPolicyRegistry([
      {
        id: "model-constrained",
        domainId: "personal",
        sensitivity: "normal",
        allowedProviders: ["openrouter"],
        allowedModels: ["trusted-model"],
        allowRemote: false,
        requireRedaction: false,
      },
    ]);
    const base = { domainId: "personal", sensitivity: "normal", provider: "openrouter" } as const;
    expect(registry.check({ ...base, model: "other-model" })).toMatchObject({ allowed: false, reason: "model_not_allowed" });
    expect(registry.check({ ...base })).toMatchObject({ allowed: false, reason: "model_required_by_policy" });
    expect(registry.check({ ...base, model: "trusted-model" }).allowed).toBe(true);
  });

  it("non-local storage mode + allowRemote=false → denied (remote content never transits personal providers, T15)", () => {
    const registry = new ModelEgressPolicyRegistry([
      { id: "personal-normal", domainId: "personal", sensitivity: "normal", allowedProviders: ["openrouter"], allowRemote: false, requireRedaction: false },
    ]);
    const decision = registry.check({ domainId: "personal", sensitivity: "normal", provider: "openrouter", storageMode: "opaque" });
    expect(decision).toMatchObject({ allowed: false, reason: "remote_content_forbidden" });
    expect(registry.check({ domainId: "personal", sensitivity: "normal", provider: "openrouter", storageMode: "local" }).allowed).toBe(true);
  });
});

describe("pre-dispatch enforcement (egressGatedModelProvider)", () => {
  const dispatched: ModelRequest[] = [];
  const recordingProvider: ModelProvider = {
    id: "recording",
    async complete(request: ModelRequest) {
      dispatched.push(request);
      return { text: "ok" };
    },
  };

  /** Fake domains table: key → storage mode; missing key = unknown domain. */
  function domainsDb(modes: Readonly<Record<string, string>>): SqlExecutor {
    return {
      async query(_text: string, values?: readonly unknown[]) {
        const key = String(values?.[0] ?? "");
        const mode = modes[key];
        return { rows: mode === undefined ? [] : [{ storage_mode: mode }] };
      },
    };
  }

  it("denied request raises before dispatch — provider is never invoked", async () => {
    const registry = await loadEgressPolicyRegistry();
    const gated = egressGatedModelProvider(recordingProvider, registry, domainsDb({ personal: "local" }));
    await expect(
      gated.complete({ domainId: "finance", sensitivity: "sensitive", provider: "recording", model: "m", prompt: "p" }),
    ).rejects.toBeInstanceOf(EgressDenialError);
    expect(dispatched).toHaveLength(0);
  });

  it("allowed request is dispatched exactly once", async () => {
    const registry = await loadEgressPolicyRegistry();
    const db = domainsDb({ personal: "local", finance: "local" });
    const gated = egressGatedModelProvider(
      { id: "openrouter", async complete(request: ModelRequest) { dispatched.push(request); return { text: "ok" }; } },
      registry,
      db,
    );
    const result = await gated.complete({ domainId: "personal", sensitivity: "normal", provider: "openrouter", model: "m", prompt: "p" });
    expect(result.text).toBe("ok");
    expect(dispatched).toHaveLength(1);
  });

  it("R5: a request naming a different provider throws and never dispatches", async () => {
    const registry = await loadEgressPolicyRegistry();
    const db = domainsDb({ personal: "local" });
    const gated = egressGatedModelProvider(recordingProvider, registry, db);
    const before = dispatched.length;
    await expect(
      gated.complete({ domainId: "personal", sensitivity: "normal", provider: "not-recording", model: "m", prompt: "p" }),
    ).rejects.toBeInstanceOf(EgressPolicyError);
    expect(dispatched).toHaveLength(before);
  });

  it("R1: non-local storage mode is resolved from the db and denied under allowRemote=false — no caller opt-out", async () => {
    const registry = new ModelEgressPolicyRegistry([
      { id: "personal-normal", domainId: "personal", sensitivity: "normal", allowedProviders: ["openrouter"], allowRemote: false, requireRedaction: false },
    ]);
    const gated = egressGatedModelProvider(
      { id: "openrouter", async complete(request: ModelRequest) { dispatched.push(request); return { text: "ok" }; } },
      registry,
      domainsDb({ personal: "opaque" }),
    );
    // The request itself carries NO storageMode — the gated provider must
    // resolve it. Before R1 this call was ALLOWED (fail-open).
    const before = dispatched.length;
    await expect(
      gated.complete({ domainId: "personal", sensitivity: "normal", provider: "openrouter", model: "m", prompt: "p" }),
    ).rejects.toMatchObject({ name: "EgressDenialError", audit: { reason: "remote_content_forbidden" } });
    expect(dispatched).toHaveLength(before);
  });

  it("R1: unknown domain denies fail-closed with an auditable reason", async () => {
    const registry = await loadEgressPolicyRegistry();
    const gated = egressGatedModelProvider(recordingProvider, registry, domainsDb({}));
    const before = dispatched.length;
    const denial = gated.complete({ domainId: "ghost", sensitivity: "normal", provider: "recording", model: "m", prompt: "p" });
    await expect(denial).rejects.toBeInstanceOf(EgressDenialError);
    await expect(denial).rejects.toMatchObject({ audit: { reason: "unknown_domain" } });
    expect(dispatched).toHaveLength(before);
  });

  it("R1: a garbage storage_mode row is a configuration error, never a silent pass", async () => {
    const registry = await loadEgressPolicyRegistry();
    const gated = egressGatedModelProvider(recordingProvider, registry, domainsDb({ personal: "localish" }));
    await expect(
      gated.complete({ domainId: "personal", sensitivity: "normal", provider: "recording", model: "m", prompt: "p" }),
    ).rejects.toBeInstanceOf(EgressPolicyError);
  });
});

describe("policy loading fails closed", () => {
  const validRule: EgressPolicyRule = {
    id: "r",
    domainId: "personal",
    sensitivity: "normal",
    allowedProviders: ["openrouter"],
    allowRemote: false,
    requireRedaction: false,
  };

  it("rejects wrong version", () => {
    expect(() => parseEgressPolicy("version: 2\nrules: []\n")).toThrow(EgressPolicyError);
  });

  it("rejects unknown rule keys (typos must not weaken policy)", () => {
    const yaml = [
      "version: 1",
      "rules:",
      "  - id: r",
      "    domainId: personal",
      "    sensitivity: normal",
      "    allowedProviders: [openrouter]",
      "    allowRemte: false",
      "    requireRedaction: false",
    ].join("\n");
    expect(() => parseEgressPolicy(yaml)).toThrow(/unknown key "allowRemte"/);
  });

  it("rejects invalid sensitivity vocabulary", () => {
    const yaml = [
      "version: 1",
      "rules:",
      "  - id: r",
      "    domainId: personal",
      "    sensitivity: ultra",
      "    allowedProviders: [openrouter]",
      "    allowRemote: false",
      "    requireRedaction: false",
    ].join("\n");
    expect(() => parseEgressPolicy(yaml)).toThrow(/sensitivity/);
  });

  it("rejects missing required fields", () => {
    const yaml = ["version: 1", "rules:", "  - id: r", "    domainId: personal", "    sensitivity: normal", "    allowRemote: false", "    requireRedaction: false"].join("\n");
    expect(() => parseEgressPolicy(yaml)).toThrow(/allowedProviders/);
  });

  it("registry rejects duplicate rule ids and malformed rules", () => {
    expect(() => new ModelEgressPolicyRegistry([validRule, validRule])).toThrow(/unique/);
    expect(() => new ModelEgressPolicyRegistry([{ ...validRule, allowRemote: "yes" as unknown as boolean }])).toThrow(/allowRemote/);
  });
});
