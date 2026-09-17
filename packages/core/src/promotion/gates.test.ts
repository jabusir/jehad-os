// Hermetic gate-pipeline tests: evaluateGates is pure (all DB facts and the
// egress decision are injected), so the full five-gate matrix — including
// the T14 claim-vs-fact truth semantics — is covered with no database and
// no model. The ModelEgressPolicyRegistry is itself pure policy data.

import { describe, expect, it } from "vitest";
import { ModelEgressPolicyRegistry } from "../egress/index.js";
import type { EgressDecision } from "../egress/index.js";
import type { ProposedClass } from "../memory/candidate-contract.js";
import {
  DEFAULT_PROMOTION_GATE_CONFIG,
  PromotionConfigError,
  validatePromotionGateConfig,
  type PromotionGateConfig,
} from "./config.js";
import {
  classifySensitivity,
  evaluateGates,
  type GateCandidate,
  type GateDomain,
  type GateEvaluationInput,
} from "./gates.js";

const ALLOWED: EgressDecision = { allowed: true, ruleId: "test-rule", requireRedaction: false };

const UUID = "018f1e2c-3d4b-7a5e-9f6a-1b2c3d4e5f60";

function makeCandidate(overrides: Partial<GateCandidate> = {}): GateCandidate {
  return {
    id: "c1",
    proposedClass: "semantic",
    assertionKind: "model_inferred",
    payload: { statement: "Company X has 3M customers" },
    provenance: { sourceEventId: UUID, runId: null, model: "test-model", promptVersion: "p1" },
    confidence: 0.9,
    ...overrides,
  };
}

function makeDomain(overrides: Partial<GateDomain> = {}): GateDomain {
  return { key: "personal", storageMode: "local", sensitivity: "normal", retentionClass: "default", ...overrides };
}

function makeInput(overrides: Partial<GateEvaluationInput> = {}): GateEvaluationInput {
  return {
    candidate: makeCandidate(),
    domain: makeDomain(),
    sourceEventExists: true,
    egress: ALLOWED,
    existingConflict: null,
    ...overrides,
  };
}

const CONFIG = DEFAULT_PROMOTION_GATE_CONFIG;

describe("gate 1 — provenance attached", () => {
  it.each([
    ["provenance object missing", { provenance: null }],
    ["sourceEventId missing", { provenance: { sourceEventId: null, runId: null, model: null, promptVersion: null } }],
    ["sourceEventId not a uuid", { provenance: { sourceEventId: "not-a-uuid", runId: null, model: null, promptVersion: null } }],
    ["runId wrong type", { provenance: { sourceEventId: UUID, runId: 42 as unknown as string, model: null, promptVersion: null } }],
  ])("rejects when %s", (_label, candidateOverrides) => {
    const result = evaluateGates(makeInput({ candidate: makeCandidate(candidateOverrides) }), CONFIG);
    expect(result.action).toBe("rejected");
    expect(result.gate).toBe(1);
    expect(result.reason).toBe("provenance_missing");
  });

  it("rejects with reason when the source event does not exist", () => {
    const result = evaluateGates(makeInput({ sourceEventExists: false }), CONFIG);
    expect(result.action).toBe("rejected");
    expect(result.gate).toBe(1);
    expect(result.reason).toBe("source_event_not_found");
  });

  it("accepts null runId/model/promptVersion (human-captured source)", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          provenance: { sourceEventId: UUID, runId: null, model: null, promptVersion: null },
        }),
      }),
      CONFIG,
    );
    expect(result.gate).not.toBe(1);
  });
});

describe("gate 2 — domain check", () => {
  it("blocks work-domain semantic content from the personal semantic store", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({ assertionKind: "user_declared" }),
        domain: makeDomain({ key: "work" }),
      }),
      CONFIG,
    );
    expect(result.action).toBe("rejected");
    expect(result.gate).toBe(2);
    expect(result.reason).toBe("work_domain_blocked");
  });

  it("allows abstract method-level learning from the work domain", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          assertionKind: "user_declared",
          proposedClass: "preference",
          payload: { key: "webhook-idempotency", value: "experienced", abstraction: "method_level" },
        }),
        domain: makeDomain({ key: "work" }),
      }),
      CONFIG,
    );
    expect(result.gate).not.toBe(2);
    expect(result.action).toBe("promoted");
  });

  it("blocks employer specifics even when marked user_declared", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          assertionKind: "user_declared",
          payload: { statement: "Employer X has vulnerability Y in table Z" },
        }),
        domain: makeDomain({ key: "work" }),
      }),
      CONFIG,
    );
    expect(result.action).toBe("rejected");
    expect(result.reason).toBe("work_domain_blocked");
  });

  it("opaque domains contribute no semantic payload at all", () => {
    const result = evaluateGates(
      makeInput({ domain: makeDomain({ key: "employerarchive", storageMode: "opaque" }) }),
      CONFIG,
    );
    expect(result.action).toBe("rejected");
    expect(result.reason).toBe("opaque_domain_no_payload");
  });

  it("federated domains contribute counts only, never content", () => {
    const result = evaluateGates(
      makeInput({ domain: makeDomain({ key: "workfederation", storageMode: "federated" }) }),
      CONFIG,
    );
    expect(result.action).toBe("rejected");
    expect(result.reason).toBe("federated_domain_counts_only");
  });

  it("episodic work events are not semantic writes (gate 2 scoped to semantic classes)", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({ proposedClass: "episodic", payload: {} }),
        domain: makeDomain({ key: "work" }),
      }),
      CONFIG,
    );
    expect(result.action).toBe("promoted");
    expect(result.canonicalWrite).toBe(false);
  });
});

describe("gate 3 — sensitivity/retention + egress", () => {
  const registry = new ModelEgressPolicyRegistry([
    {
      id: "personal-normal",
      domainId: "personal",
      sensitivity: "normal",
      allowedProviders: ["openrouter"],
      allowRemote: false,
      requireRedaction: false,
    },
  ]);

  it("rejects when the egress policy denies the provider being asked", () => {
    const denied = registry.check({ domainId: "personal", sensitivity: "sensitive", provider: "openrouter" });
    expect(denied.allowed).toBe(false);
    const result = evaluateGates(makeInput({ egress: denied }), CONFIG);
    expect(result.action).toBe("rejected");
    expect(result.gate).toBe(3);
    expect(result.reason).toBe("egress_denied");
  });

  it("rejects secret sensitivity (never in model context)", () => {
    const denied = registry.check({ domainId: "personal", sensitivity: "secret", provider: "openrouter" });
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({ payload: { statement: "x", sensitivity: "secret" } }),
        egress: denied,
      }),
      CONFIG,
    );
    expect(result.action).toBe("rejected");
    expect(result.reason).toBe("egress_denied");
  });

  it("classifies sensitivity from payload override, then domain mapping, then normal", () => {
    expect(classifySensitivity({ sensitivity: "sensitive" }, makeDomain(), CONFIG)).toBe("sensitive");
    expect(classifySensitivity({}, makeDomain({ sensitivity: "finance" }), CONFIG)).toBe("sensitive");
    expect(classifySensitivity({}, makeDomain({ sensitivity: "normal" }), CONFIG)).toBe("normal");
    expect(classifySensitivity({}, makeDomain({ sensitivity: "unmapped-vocab" }), CONFIG)).toBe("normal");
  });

  it("records retention classification from the domain", () => {
    const result = evaluateGates(makeInput({ domain: makeDomain({ retentionClass: "seven_years" }) }), CONFIG);
    expect(result.retentionClass).toBe("seven_years");
  });
});

describe("gate 4 — confidence + conflict", () => {
  it("routes below-threshold confidence to review", () => {
    const result = evaluateGates(
      makeInput({ candidate: makeCandidate({ confidence: 0.3 }) }),
      CONFIG,
    );
    expect(result.action).toBe("in_review");
    expect(result.gate).toBe(4);
    expect(result.reason).toBe("low_confidence");
  });

  it("material conflict: both kept, conflict recorded, review queue", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          proposedClass: "preference",
          assertionKind: "user_declared",
          payload: { key: "code-review-detail", value: "concise" },
        }),
        existingConflict: { recordId: "ev-1", value: "verbose", candidateId: "c0" },
      }),
      CONFIG,
    );
    expect(result.action).toBe("in_review");
    expect(result.reason).toBe("material_conflict");
    expect(result.conflict).toMatchObject({ key: "code-review-detail", existingValue: "verbose", newValue: "concise", material: true });
  });

  it("non-material conflict still records the conflict but promotes", () => {
    const config: PromotionGateConfig = {
      ...CONFIG,
      gate4Confidence: {
        ...CONFIG.gate4Confidence,
        conflict: { ...CONFIG.gate4Confidence.conflict, materialClasses: ["commitment"] },
      },
    };
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          proposedClass: "preference",
          assertionKind: "user_declared",
          payload: { key: "theme", value: "dark" },
        }),
        existingConflict: { recordId: "ev-1", value: "light", candidateId: "c0" },
      }),
      config,
    );
    expect(result.action).toBe("promoted");
    expect(result.conflict).toMatchObject({ material: false });
  });

  it("same value re-asserted is not a conflict", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          proposedClass: "preference",
          assertionKind: "user_declared",
          payload: { key: "theme", value: "dark" },
        }),
        existingConflict: { recordId: "ev-1", value: "dark", candidateId: "c0" },
      }),
      CONFIG,
    );
    expect(result.action).toBe("promoted");
    expect(result.conflict).toBeNull();
  });
});

describe("gate 5 — truth semantics (T14)", () => {
  const declarable: readonly ProposedClass[] = [
    "preference",
    "commitment",
    "decision",
    "assumption",
  ];

  it.each(declarable)("user_declared %s canonically promotes", (cls) => {    const payload =
      cls === "commitment"
        ? { counterparty: "Acme", description: "migration plan" }
        : cls === "decision"
          ? { question: "q", chosen: "a" }
          : cls === "preference"
            ? { key: "k", value: "v" }
            : { statement: "s" };
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({ proposedClass: cls, assertionKind: "user_declared", payload }),
      }),
      CONFIG,
    );
    expect(result.action).toBe("promoted");
    expect(result.canonicalWrite).toBe(true);
  });

  it("T14: a user_declared external-world claim is NEVER auto-promoted to verified fact", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          proposedClass: "semantic",
          assertionKind: "user_declared",
          payload: { statement: "Company X has 3M customers" },
        }),
      }),
      CONFIG,
    );
    // "Jehad said X" is not "X is true": the claim routes to review, and even
    // on approval lands as a claim (writers), never a verified semantic fact.
    expect(result.action).toBe("in_review");
    expect(result.reason).toBe("semantic_requires_review");
  });

  it("model_inferred semantic routes to review", () => {
    const result = evaluateGates(makeInput(), CONFIG);
    expect(result.action).toBe("in_review");
    expect(result.reason).toBe("semantic_requires_review");
  });

  it("episodic writes without review", () => {
    const result = evaluateGates(
      makeInput({ candidate: makeCandidate({ proposedClass: "episodic", payload: {} }) }),
      CONFIG,
    );
    expect(result.action).toBe("promoted");
    expect(result.canonicalWrite).toBe(false);
  });

  it("user_declared working-intent promotes without a kernel store", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({ proposedClass: "working", assertionKind: "user_declared", payload: {} }),
      }),
      CONFIG,
    );
    expect(result.action).toBe("promoted");
    expect(result.canonicalWrite).toBe(false);
  });

  it("non-user-declared working memory stays gated (harness-owned)", () => {
    const result = evaluateGates(
      makeInput({ candidate: makeCandidate({ proposedClass: "working", payload: {} }) }),
      CONFIG,
    );
    expect(result.action).toBe("gated");
    expect(result.canonicalWrite).toBe(false);
  });

  it("discard-class candidates are rejected by the classifier's own label", () => {
    const result = evaluateGates(
      makeInput({ candidate: makeCandidate({ proposedClass: "discard", payload: {} }) }),
      CONFIG,
    );
    expect(result.action).toBe("rejected");
    expect(result.reason).toBe("discard_class");
  });

  it("review override promotes a queued semantic candidate but never overrides hard gates", () => {
    const queued = makeInput();
    const approved = evaluateGates(queued, CONFIG, { overrideReview: true });
    expect(approved.action).toBe("promoted");
    expect(approved.canonicalWrite).toBe(true);

    const stillBlocked = evaluateGates(
      makeInput({ domain: makeDomain({ key: "work" }), candidate: makeCandidate({ assertionKind: "user_declared" }) }),
      CONFIG,
      { overrideReview: true },
    );
    expect(stillBlocked.action).toBe("rejected");
    expect(stillBlocked.reason).toBe("work_domain_blocked");
  });

  it("an invalid canonical payload routes to review instead of a broken write", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          proposedClass: "commitment",
          assertionKind: "user_declared",
          payload: { description: "missing counterparty" },
        }),
      }),
      CONFIG,
    );
    expect(result.action).toBe("in_review");
    expect(result.reason).toBe("invalid_write_payload");
  });
});

describe("gate 4 — policy confidence (decalibration directive 2026-09-17)", () => {
  const EMPIRICAL = {
    updatedAt: "2026-09-17T00:00:00.000Z",
    byClass: { commitment: 0.81 },
    source: "test",
  };

  it("model confidence 0.95 capped at empirical 0.81 fails a 0.9 action threshold → review", () => {
    const config: PromotionGateConfig = {
      ...CONFIG,
      gate4Confidence: {
        ...CONFIG.gate4Confidence,
        minByClass: { commitment: 0.9 },
        empiricalPrecisionPath: "evals/.empirical-precision.json",
      },
    };
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          proposedClass: "commitment",
          assertionKind: "user_declared",
          payload: { counterpartyText: "Acme", description: "d" },
          confidence: 0.95,
        }),
        // The pipeline injects the parsed file; gates stay pure.
        empirical: EMPIRICAL,
      }),
      config,
    );
    expect(result.action).toBe("in_review");
    expect(result.gate).toBe(4);
    expect(result.reason).toBe("low_confidence");
    expect(result.message).toContain("policy confidence 0.81");
    expect(result.confidencePolicy).toEqual({ model: 0.95, policy: 0.81, cap: 0.81 });
  });

  it("configured-but-missing empirical file fails closed to the 0.5 action cap", () => {
    const config: PromotionGateConfig = {
      ...CONFIG,
      gate4Confidence: { ...CONFIG.gate4Confidence, empiricalPrecisionPath: "evals/.empirical-precision.json" },
    };
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          proposedClass: "commitment",
          assertionKind: "user_declared",
          payload: { counterpartyText: "Acme", description: "d" },
          confidence: 0.95,
        }),
        empirical: null,
      }),
      config,
    );
    expect(result.action).toBe("in_review");
    expect(result.reason).toBe("low_confidence");
    expect(result.confidencePolicy).toEqual({ model: 0.95, policy: 0.5, cap: 0.5 });
  });

  it("an empirical cap above the model claim never boosts confidence", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          proposedClass: "commitment",
          assertionKind: "user_declared",
          payload: { counterpartyText: "Acme", description: "d" },
          confidence: 0.65,
        }),
        empirical: { ...EMPIRICAL, byClass: { commitment: 0.99 } },
      }),
      { ...CONFIG, gate4Confidence: { ...CONFIG.gate4Confidence, empiricalPrecisionPath: "x" } },
    );
    expect(result.action).toBe("promoted");
    expect(result.confidencePolicy).toEqual({ model: 0.65, policy: 0.65, cap: null });
  });

  it("no empirical source configured keeps the legacy raw-confidence gate", () => {
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({
          proposedClass: "commitment",
          assertionKind: "user_declared",
          payload: { counterpartyText: "Acme", description: "d" },
          confidence: 0.95,
        }),
      }),
      CONFIG,
    );
    expect(result.action).toBe("promoted");
    expect(result.confidencePolicy).toBeNull();
  });

  it("config validation rejects an invalid empiricalPrecisionPath", () => {
    expect(() =>
      validatePromotionGateConfig({
        ...CONFIG,
        gate4Confidence: { ...CONFIG.gate4Confidence, empiricalPrecisionPath: 42 as unknown as string },
      }),
    ).toThrow(PromotionConfigError);
    expect(() =>
      validatePromotionGateConfig({
        ...CONFIG,
        gate4Confidence: { ...CONFIG.gate4Confidence, empiricalPrecisionPath: "" },
      }),
    ).toThrow(PromotionConfigError);
  });
});

describe("promotion rules are configuration, not model judgment", () => {
  it("unblocking a domain key in config changes the outcome (no code path)", () => {
    const config: PromotionGateConfig = {
      ...CONFIG,
      gate2Domain: { ...CONFIG.gate2Domain, blockedDomainKeys: [] },
    };
    const result = evaluateGates(
      makeInput({
        candidate: makeCandidate({ assertionKind: "user_declared" }),
        domain: makeDomain({ key: "work" }),
      }),
      config,
    );
    expect(result.action).not.toBe("rejected");
  });

  it("raising the confidence threshold reroutes a previously promoted candidate", () => {
    const config: PromotionGateConfig = {
      ...CONFIG,
      gate4Confidence: { ...CONFIG.gate4Confidence, minByClass: { preference: 0.95 } },
    };
    const candidate = makeCandidate({
      proposedClass: "preference",
      assertionKind: "user_declared",
      payload: { key: "k", value: "v" },
      confidence: 0.9,
    });
    expect(evaluateGates(makeInput({ candidate }), CONFIG).action).toBe("promoted");
    expect(evaluateGates(makeInput({ candidate }), config).action).toBe("in_review");
  });

  it("removing a class from the declarable set sends it to review (T14 by config)", () => {
    const config: PromotionGateConfig = {
      ...CONFIG,
      gate5TruthSemantics: {
        ...CONFIG.gate5TruthSemantics,
        canonicallyDeclarableClasses: ["preference"],
      },
    };
    const candidate = makeCandidate({
      proposedClass: "commitment",
      assertionKind: "user_declared",
      payload: { counterparty: "Acme", description: "d" },
    });
    expect(evaluateGates(makeInput({ candidate }), CONFIG).action).toBe("promoted");
    expect(evaluateGates(makeInput({ candidate }), config).action).toBe("in_review");
  });
});
