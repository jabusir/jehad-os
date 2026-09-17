/**
 * Promotion gate configuration — promotion rules are data, not model
 * judgment (ADR-0004; docs/memory-architecture.md §5; plan §6.2).
 *
 * Every threshold, domain list, and truth-semantics exception below is
 * configuration: the gate pipeline never calls a model, and changing a rule
 * is an edit here (or an injected override), never a code change. The
 * pipeline interprets; it does not judge.
 */

import type { Sensitivity, StorageMode } from "../egress/policy.js";
import type { ProposedClass } from "../memory/candidate-contract.js";

/** The classifier vocabulary (plan §6.2) — config keys are validated against it. */
export const PROPOSED_CLASSES: readonly ProposedClass[] = [
  "discard",
  "working",
  "episodic",
  "semantic",
  "preference",
  "commitment",
  "decision",
  "assumption",
  "procedural",
  "policy",
];

/** Domain storage modes that may never contribute semantic payload (cleanup §3). */
export type NonContributingStorageMode = Extract<StorageMode, "federated" | "opaque">;

export interface PromotionGateConfig {
  readonly version: number;

  /** Gate 2 — domain check (T3; cleanup §3). */
  readonly gate2Domain: {
    /** Domain keys whose content is blocked from the personal semantic store. */
    readonly blockedDomainKeys: readonly string[];
    /** Classes that would write the semantic store (gate 2 scope). */
    readonly semanticClasses: readonly ProposedClass[];
    /**
     * Abstract method-level learning escape hatch: payload[payloadKey] ∈
     * allowedValues marks a candidate as abstract ("user has experience with
     * webhook idempotency" — allowed) rather than employer-specific
     * ("Employer X has vulnerability Y in table Z" — blocked).
     */
    readonly abstractLearning: {
      readonly payloadKey: string;
      readonly allowedValues: readonly string[];
    };
    /** storage_modes that contribute nothing (opaque) or counts only (federated). */
    readonly blockedStorageModes: readonly NonContributingStorageMode[];
  };

  /** Gate 3 — sensitivity/retention classification + egress check (ADR-0012). */
  readonly gate3Egress: {
    /** Payload key carrying an optional per-candidate sensitivity override. */
    readonly payloadSensitivityKey: string;
    /** domains.sensitivity (policy vocabulary) → event/egress sensitivity. */
    readonly domainSensitivityMap: Readonly<Record<string, Sensitivity>>;
    /** The provider being asked — the egress check context, from config. */
    readonly provider: string;
    readonly model?: string;
  };

  /** Gate 4 — confidence + conflict (§38; plan §6.2). */
  readonly gate4Confidence: {
    /** Per-class minimum confidence; unknown classes fall back to defaultMin. */
    readonly minByClass: Readonly<Record<string, number>>;
    readonly defaultMin: number;
    readonly conflict: {
      /** Payload fields carrying the canonical key/value pair being asserted. */
      readonly payloadKeyField: string;
      readonly payloadValueField: string;
      /** Classes whose conflicts are material → review queue. */
      readonly materialClasses: readonly ProposedClass[];
    };
  };

  /**
   * Gate 5 — truth semantics (review §8; T14). Semantic writes land in the
   * review queue UNLESS (a) user_declared AND a class a person can
   * canonically establish by stating it, or (b) episodic.
   */
  readonly gate5TruthSemantics: {
    readonly canonicallyDeclarableClasses: readonly ProposedClass[];
    readonly episodicClasses: readonly ProposedClass[];
  };
}

export const DEFAULT_PROMOTION_GATE_CONFIG: PromotionGateConfig = {
  version: 1,
  gate2Domain: {
    // Work is the detachable domain, excluded from personal semantic
    // promotion (plan §10; plan §6.2 gate 2).
    blockedDomainKeys: ["work"],
    semanticClasses: [
      "semantic",
      "preference",
      "commitment",
      "decision",
      "assumption",
      "procedural",
      "policy",
    ],
    abstractLearning: {
      payloadKey: "abstraction",
      allowedValues: ["method_level"],
    },
    blockedStorageModes: ["federated", "opaque"],
  },
  gate3Egress: {
    payloadSensitivityKey: "sensitivity",
    // domains.sensitivity is policy-defined free text; map the v1 seeded
    // values onto the event/egress vocabulary, defaulting to "normal".
    domainSensitivityMap: {
      personal: "normal",
      finance: "sensitive",
      research: "normal",
      learning: "normal",
      creative: "normal",
      work: "sensitive",
    },
    provider: "openrouter",
  },
  gate4Confidence: {
    minByClass: {
      default: 0.5,
      semantic: 0.7,
      commitment: 0.6,
    },
    defaultMin: 0.5,
    conflict: {
      payloadKeyField: "key",
      payloadValueField: "value",
      materialClasses: ["preference", "commitment", "decision", "semantic"],
    },
  },
  gate5TruthSemantics: {
    // review §8: preference, intent (working), commitment, personal
    // decision, assumption — the classes a person canonically establishes
    // by stating them. External-world claims are NOT here (T14).
    canonicallyDeclarableClasses: [
      "preference",
      "commitment",
      "decision",
      "assumption",
      "working",
    ],
    episodicClasses: ["episodic"],
  },
};

/** Thrown for malformed gate configuration — fail closed, never silently. */
export class PromotionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionConfigError";
  }
}

function requireNonEmptyString(where: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PromotionConfigError(`${where} must be a non-empty string`);
  }
  return value;
}

function requireClassList(where: string, value: readonly unknown[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PromotionConfigError(`${where} must be a non-empty array`);
  }
  for (const item of value) {
    if (!PROPOSED_CLASSES.includes(item as ProposedClass)) {
      throw new PromotionConfigError(`${where}: unknown proposed class ${JSON.stringify(item)}`);
    }
  }
}

function requireUnitInterval(where: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PromotionConfigError(`${where} must be a number in [0, 1]`);
  }
}

/** Validates a config object before the pipeline trusts it. Fail closed. */
export function validatePromotionGateConfig(config: PromotionGateConfig): void {
  if (config.version !== 1) {
    throw new PromotionConfigError(`unsupported promotion gate config version ${JSON.stringify(config.version)}`);
  }
  const g2 = config.gate2Domain;
  if (!Array.isArray(g2.blockedDomainKeys)) throw new PromotionConfigError("gate2Domain.blockedDomainKeys must be an array");
  requireClassList("gate2Domain.semanticClasses", g2.semanticClasses);
  requireNonEmptyString("gate2Domain.abstractLearning.payloadKey", g2.abstractLearning.payloadKey);
  if (!Array.isArray(g2.abstractLearning.allowedValues) || g2.abstractLearning.allowedValues.length === 0) {
    throw new PromotionConfigError("gate2Domain.abstractLearning.allowedValues must be a non-empty array");
  }
  const modes = new Set<unknown>(g2.blockedStorageModes);
  if (modes.size !== g2.blockedStorageModes.length) throw new PromotionConfigError("gate2Domain.blockedStorageModes must not repeat");
  for (const mode of g2.blockedStorageModes) {
    if (mode !== "federated" && mode !== "opaque") {
      throw new PromotionConfigError(`gate2Domain.blockedModes: only "federated"/"opaque" allowed (got ${JSON.stringify(mode)})`);
    }
  }

  const g3 = config.gate3Egress;
  requireNonEmptyString("gate3Egress.payloadSensitivityKey", g3.payloadSensitivityKey);
  requireNonEmptyString("gate3Egress.provider", g3.provider);
  if (g3.model !== undefined) requireNonEmptyString("gate3Egress.model", g3.model);
  for (const [key, value] of Object.entries(g3.domainSensitivityMap)) {
    if (value !== "normal" && value !== "sensitive" && value !== "secret") {
      throw new PromotionConfigError(`gate3Egress.domainSensitivityMap.${key}: invalid sensitivity ${JSON.stringify(value)}`);
    }
  }

  const g4 = config.gate4Confidence;
  requireUnitInterval("gate4Confidence.defaultMin", g4.defaultMin);
  for (const [cls, min] of Object.entries(g4.minByClass)) {
    requireUnitInterval(`gate4Confidence.minByClass.${cls}`, min);
  }
  requireNonEmptyString("gate4Confidence.conflict.payloadKeyField", g4.conflict.payloadKeyField);
  requireNonEmptyString("gate4Confidence.conflict.payloadValueField", g4.conflict.payloadValueField);
  requireClassList("gate4Confidence.conflict.materialClasses", g4.conflict.materialClasses);

  const g5 = config.gate5TruthSemantics;
  requireClassList("gate5TruthSemantics.canonicallyDeclarableClasses", g5.canonicallyDeclarableClasses);
  requireClassList("gate5TruthSemantics.episodicClasses", g5.episodicClasses);
}
