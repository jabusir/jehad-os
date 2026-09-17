/**
 * The five promotion gates, in order (docs/memory-architecture.md §3; plan
 * §6.2; ADR-0004). Pure evaluation: every DB fact (domain row, source-event
 * existence, existing conflicting record) and every policy decision (egress)
 * is gathered by the caller and injected — so this module is fully
 * deterministic and unit-testable with no database and no model.
 *
 * Gate order is fixed by the spec:
 *   1 provenance → 2 domain → 3 sensitivity/egress → 4 confidence/conflict
 *   → 5 write routing under truth semantics.
 */

import type { EgressDecision, Sensitivity, StorageMode } from "../egress/policy.js";
import { SENSITIVITY_V1, UUID_RE } from "../events/envelope.js";
import type {
  AssertionKind,
  ProposedClass,
} from "../memory/candidate-contract.js";
import type { PromotionGateConfig } from "./config.js";

/** The candidate as the gate sees it (contract shape + row identity). */
export interface GateCandidate {
  readonly id: string;
  readonly proposedClass: ProposedClass;
  readonly assertionKind: AssertionKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provenance: {
    readonly sourceEventId: string | null;
    readonly runId: string | null;
    readonly model: string | null;
    readonly promptVersion: string | null;
  } | null;
  readonly confidence: number;
}

/** The domains-table facts gate 2/3 need. */
export interface GateDomain {
  readonly key: string;
  readonly storageMode: StorageMode;
  readonly sensitivity: string;
  readonly retentionClass: string;
}

/** Result of the pipeline's conflict probe against the canonical store. */
export interface ExistingConflictRecord {
  /** Canonical record id (e.g. evidence row) asserting a value for the key. */
  readonly recordId: string;
  readonly value: string;
  /** Candidate that produced the existing record, when known. */
  readonly candidateId: string | null;
}

export interface GateEvaluationInput {
  readonly candidate: GateCandidate;
  readonly domain: GateDomain;
  /** Gate 1: does provenance.sourceEventId reference an events row? */
  readonly sourceEventExists: boolean;
  /** Gate 3: decision from the injected ModelEgressPolicyRegistry. */
  readonly egress: EgressDecision;
  /** Gate 4: newest canonical record for the same conflict key, if any. */
  readonly existingConflict: ExistingConflictRecord | null;
}

export type GateNumber = 1 | 2 | 3 | 4 | 5;

export type PromotionRejectionReason =
  | "provenance_missing"
  | "source_event_not_found"
  | "work_domain_blocked"
  | "opaque_domain_no_payload"
  | "federated_domain_counts_only"
  | "egress_denied"
  | "discard_class";

export type PromotionReviewReason =
  | "low_confidence"
  | "material_conflict"
  | "semantic_requires_review"
  | "invalid_write_payload";

export type PromotionAction = "promoted" | "rejected" | "in_review" | "gated";

export interface ConflictInfo {
  readonly key: string;
  readonly existingValue: string;
  readonly newValue: string;
  readonly existingRecordId: string;
  /** True when the class routes the conflict to the review queue. */
  readonly material: boolean;
}

/** The gate pipeline's verdict — everything gate_result persists. */
export interface GateEvaluation {
  readonly action: PromotionAction;
  readonly gate: GateNumber | null;
  readonly reason: PromotionRejectionReason | PromotionReviewReason | null;
  readonly message: string;
  readonly gatedClass: ProposedClass;
  readonly sensitivity: Sensitivity;
  readonly retentionClass: string;
  readonly egressRuleId: string | undefined;
  readonly conflict: ConflictInfo | null;
  /** Gate 5: will domain tables be written (vs. event-log-only landing)? */
  readonly canonicalWrite: boolean;
  /** Human-readable routing note (e.g. "episodic: canonical store is the event log"). */
  readonly note: string | null;
}

/**
 * Gate 3 helper: classifies the candidate's sensitivity — an explicit payload
 * override wins, then the domain's mapped default. Exported so the pipeline
 * can build the egress check context from the same classification it records.
 */
export function classifySensitivity(
  payload: Readonly<Record<string, unknown>>,
  domain: GateDomain,
  config: PromotionGateConfig,
): Sensitivity {
  const override = payload[config.gate3Egress.payloadSensitivityKey];
  if (typeof override === "string" && (SENSITIVITY_V1 as readonly string[]).includes(override)) {
    return override as Sensitivity;
  }
  return config.gate3Egress.domainSensitivityMap[domain.sensitivity] ?? "normal";
}

/** Thrown when a review-approved write still cannot land (payload contract violation). */
export class InvalidWritePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWritePayloadError";
  }
}

/** Gate 1: provenance attached (sourceEventId required; nulls allowed for human sources). */
function validateProvenance(
  provenance: GateCandidate["provenance"],
): { ok: true } | { ok: false; field: string } {
  if (provenance === null || typeof provenance !== "object") {
    return { ok: false, field: "provenance" };
  }
  const { sourceEventId, runId, model, promptVersion } = provenance;
  if (typeof sourceEventId !== "string" || !UUID_RE.test(sourceEventId)) {
    return { ok: false, field: "sourceEventId" };
  }
  for (const [field, value] of [
    ["runId", runId],
    ["model", model],
    ["promptVersion", promptVersion],
  ] as const) {
    if (value === null) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      return { ok: false, field };
    }
  }
  return { ok: true };
}

function rejected(
  gate: GateNumber,
  reason: PromotionRejectionReason,
  message: string,
  base: Omit<GateEvaluation, "action" | "gate" | "reason" | "message">,
): GateEvaluation {
  return { action: "rejected", gate, reason, message, ...base };
}

function review(
  gate: GateNumber,
  reason: PromotionReviewReason,
  message: string,
  base: Omit<GateEvaluation, "action" | "gate" | "reason" | "message">,
): GateEvaluation {
  return { action: "in_review", gate, reason, message, ...base };
}

/**
 * Runs gates 1–5 in order over pre-gathered facts. `overrideReview` is the
 * review-queue approve path: a human has approved, so gate-4/gate-5 review
 * routing promotes instead (hard gate failures still reject — approval never
 * overrides provenance, domain, or egress violations).
 */
export function evaluateGates(
  input: GateEvaluationInput,
  config: PromotionGateConfig,
  opts: { overrideReview?: boolean } = {},
): GateEvaluation {
  const { candidate, domain } = input;
  const cls = candidate.proposedClass;
  const base = {
    gatedClass: cls,
    sensitivity: classifySensitivity(candidate.payload, domain, config),
    retentionClass: domain.retentionClass,
    egressRuleId: input.egress.ruleId,
    conflict: null as ConflictInfo | null,
    canonicalWrite: false,
    note: null as string | null,
  };

  // ---- Gate 1: provenance attached ------------------------------------
  const provenance = validateProvenance(candidate.provenance);
  if (!provenance.ok) {
    return rejected(
      1,
      "provenance_missing",
      `candidate ${candidate.id}: provenance field "${provenance.field}" is missing or malformed`,
      base,
    );
  }
  if (!input.sourceEventExists) {
    return rejected(
      1,
      "source_event_not_found",
      `candidate ${candidate.id}: source event ${candidate.provenance?.sourceEventId} does not exist`,
      base,
    );
  }

  // ---- Gate 2: domain check -------------------------------------------
  const g2 = config.gate2Domain;
  const isSemanticClass = g2.semanticClasses.includes(cls);
  if (isSemanticClass && g2.blockedStorageModes.includes(domain.storageMode as "federated" | "opaque")) {
    const reason =
      domain.storageMode === "opaque"
        ? "opaque_domain_no_payload"
        : "federated_domain_counts_only";
    return rejected(
      2,
      reason,
      domain.storageMode === "opaque"
        ? `domain "${domain.key}" is opaque: no semantic payload crosses (cleanup §3)`
        : `domain "${domain.key}" is federated: only policy-sanitized counts cross, never content (cleanup §3)`,
      base,
    );
  }
  if (isSemanticClass && g2.blockedDomainKeys.includes(domain.key)) {
    const abstraction = candidate.payload[g2.abstractLearning.payloadKey];
    const abstractAllowed =
      typeof abstraction === "string" && g2.abstractLearning.allowedValues.includes(abstraction);
    if (!abstractAllowed) {
      return rejected(
        2,
        "work_domain_blocked",
        `work-domain content is blocked from the personal semantic store (domain "${domain.key}"; abstract learning via payload.${g2.abstractLearning.payloadKey} ∈ {${g2.abstractLearning.allowedValues.join(", ")}} only)`,
        base,
      );
    }
    base.note = `abstract ${g2.abstractLearning.payloadKey}=${abstraction}: method-level learning allowed (§4.3)`;
  }

  // ---- Gate 3: sensitivity/retention + egress --------------------------
  if (!input.egress.allowed) {
    return rejected(
      3,
      "egress_denied",
      `egress policy denies domain "${domain.key}" sensitivity "${base.sensitivity}" for provider "${config.gate3Egress.provider}": ${input.egress.message}`,
      base,
    );
  }

  // ---- Gate 4: confidence + conflict -----------------------------------
  const g4 = config.gate4Confidence;
  const minConfidence = g4.minByClass[cls] ?? g4.defaultMin;
  if (candidate.confidence < minConfidence) {
    if (opts.overrideReview) {
      base.note = `low confidence ${candidate.confidence} < ${minConfidence} overridden by review approval`;
    } else {
      return review(
        4,
        "low_confidence",
        `confidence ${candidate.confidence} below minimum ${minConfidence} for class "${cls}"`,
        base,
      );
    }
  }
  const conflictKey = candidate.payload[g4.conflict.payloadKeyField];
  const conflictValue = candidate.payload[g4.conflict.payloadValueField];
  if (
    input.existingConflict !== null &&
    typeof conflictKey === "string" &&
    typeof conflictValue === "string" &&
    input.existingConflict.value !== conflictValue
  ) {
    const material = g4.conflict.materialClasses.includes(cls);
    const conflict: ConflictInfo = {
      key: conflictKey,
      existingValue: input.existingConflict.value,
      newValue: conflictValue,
      existingRecordId: input.existingConflict.recordId,
      material,
    };
    base.conflict = conflict;
    if (material && !opts.overrideReview) {
      return review(
        4,
        "material_conflict",
        `conflict on "${conflictKey}": existing "${conflict.existingValue}" vs new "${conflict.newValue}" — both kept, conflict recorded, review required (§38)`,
        base,
      );
    }
  }

  // ---- Gate 5: write routing under truth semantics ---------------------
  const g5 = config.gate5TruthSemantics;
  if (cls === "discard") {
    return rejected(5, "discard_class", "classifier discarded the candidate", base);
  }
  if (g5.episodicClasses.includes(cls)) {
    return {
      ...base,
      action: "promoted",
      gate: 5,
      reason: null,
      message: "episodic: writes without review; canonical store is the event log",
      canonicalWrite: false,
      note: "episodic_event_log",
    };
  }
  if (isSemanticClass) {
    const canonicallyDeclarable =
      candidate.assertionKind === "user_declared" &&
      g5.canonicallyDeclarableClasses.includes(cls);
    if (canonicallyDeclarable || opts.overrideReview) {
      const payloadCheck = validateWritePayload(candidate.payload, cls);
      if (!payloadCheck.ok) {
        if (opts.overrideReview) {
          // A reviewer approved a candidate whose payload cannot land
          // canonically — that is a data error, not a routing decision.
          throw new InvalidWritePayloadError(payloadCheck.message);
        }
        return review(5, "invalid_write_payload", payloadCheck.message, base);
      }
      return {
        ...base,
        action: "promoted",
        gate: 5,
        reason: null,
        message: canonicallyDeclarable
          ? `user_declared ${cls}: canonically established by stating it (review §8)`
          : "review-approved semantic write",
        canonicalWrite: true,
        note: canonicallyDeclarable ? null : "review_approved",
      };
    }
    return review(
      5,
      "semantic_requires_review",
      `semantic write (${cls}/${candidate.assertionKind}) is a proposal: review queue unless user_declared canonically-declarable or episodic (T14; review §8)`,
      base,
    );
  }
  if (cls === "working") {
    if (
      candidate.assertionKind === "user_declared" &&
      g5.canonicallyDeclarableClasses.includes("working")
    ) {
      return {
        ...base,
        action: "promoted",
        gate: 5,
        reason: null,
        message: "user_declared working-intent: promoted; working memory itself is harness-owned (plan §5)",
        canonicalWrite: false,
        note: "working_intent_no_kernel_store",
      };
    }
    return {
      ...base,
      action: "gated",
      gate: 5,
      reason: null,
      message: "working memory is harness session state; the kernel persists no store (plan §5)",
      canonicalWrite: false,
      note: "working_memory_harness_owned",
    };
  }
  // Unreachable for the ten-class vocabulary: every non-episodic/working
  // class is either in semanticClasses or "discard" (handled above).
  return rejected(5, "discard_class", `class "${cls}" has no promotion route`, base);
}

/**
 * Gate 5 payload contract per class — the deterministic shape each canonical
 * writer needs. Exported for the writers (same rule, one definition).
 */
export type WritePayloadCheck =
  | { ok: true }
  | { ok: false; message: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateWritePayload(
  payload: Readonly<Record<string, unknown>>,
  cls: ProposedClass,
): WritePayloadCheck {
  switch (cls) {
    case "commitment": {
      const direction = payload.direction ?? "i_owe";
      if (direction !== "i_owe" && direction !== "owes_me") {
        return { ok: false, message: `commitment payload.direction must be "i_owe" or "owes_me" (got ${JSON.stringify(direction)})` };
      }
      // Canonical payload key is counterpartyText (matches the
      // commitments.counterparty_text column, review §9); `counterparty` is
      // accepted as a legacy alias.
      if (!nonEmptyString(payload.counterpartyText ?? payload.counterparty)) {
        return { ok: false, message: "commitment payload requires non-empty counterparty text (T9)" };
      }
      if (!nonEmptyString(payload.description)) {
        return { ok: false, message: "commitment payload requires non-empty description" };
      }
      return { ok: true };
    }
    case "decision": {
      if (!nonEmptyString(payload.question)) return { ok: false, message: "decision payload requires non-empty question" };
      if (!nonEmptyString(payload.chosen)) return { ok: false, message: "decision payload requires non-empty chosen" };
      return { ok: true };
    }
    case "preference": {
      if (!nonEmptyString(payload.key) || !nonEmptyString(payload.value)) {
        return { ok: false, message: "preference payload requires non-empty key and value" };
      }
      return { ok: true };
    }
    case "semantic": {
      if (!nonEmptyString(payload.statement)) {
        return { ok: false, message: "semantic claim payload requires non-empty statement" };
      }
      return { ok: true };
    }
    case "assumption": {
      if (!nonEmptyString(payload.statement)) {
        return { ok: false, message: "assumption payload requires non-empty statement" };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}
