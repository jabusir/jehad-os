// Verifier result envelope + verdict application (D3 — builder ≠ verifier,
// ADR-0013: builders don't self-verify). The verifier assignment returns a
// typed per-criterion verdict; applyVerifierVerdict is the ONLY path that
// flips outcome_criteria on the strength of worker output, and it is
// fail-closed twice over: the envelope parses like the research result, and
// the structural checks (role, succeeded builder on the same outcome,
// citation-grounded confirmations, exact criteria coverage) reject
// everything else.

import { recordAudit } from "../actions/audit.js";
import { setCriterionStatus } from "../outcomes/service.js";
import {
  AssignmentError,
  RESULT_MAX_OPEN_QUESTIONS,
  RESULT_OPEN_QUESTION_MAX_CHARS,
  RESULT_SUMMARY_MAX_CHARS,
  type AssignmentDb,
} from "./service.js";

export type VerifierVerdictValue = "confirmed" | "refuted" | "uncertain";
export const VERIFIER_VERDICT_VALUES: readonly VerifierVerdictValue[] = [
  "confirmed",
  "refuted",
  "uncertain",
];

/** 1..10 verdicts — one per outcome criterion, no more. */
export const VERIFIER_MAX_VERDICTS = 10;

export interface VerifierVerdict {
  /** outcome_criteria.ordinal, 1-based. */
  readonly ordinal: number;
  readonly verdict: VerifierVerdictValue;
  /** ≤ RESULT_SUMMARY_MAX_CHARS after trim, non-empty. */
  readonly reasoning: string;
  /** 1-based indices into the VERIFIED (builder) assignment's citations. */
  readonly citationIds: readonly number[];
}

export interface VerifierResult {
  /** ≤ RESULT_SUMMARY_MAX_CHARS. */
  readonly summary: string;
  readonly verdicts: readonly VerifierVerdict[];
  readonly confidence: number | null;
  readonly openQuestions: readonly string[];
}

// ----------------------------------------------------------------- envelope

/** Worker JSON is snake_case, like the research envelope. Fail closed. */
export function parseVerifierResult(raw: unknown): VerifierResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AssignmentError("verifier result must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const summary = obj.summary;
  if (
    typeof summary !== "string" ||
    summary.trim().length === 0 ||
    summary.length > RESULT_SUMMARY_MAX_CHARS
  ) {
    throw new AssignmentError(`verifier result summary required (≤ ${RESULT_SUMMARY_MAX_CHARS} chars)`);
  }
  const verdictsRaw = obj.verdicts;
  if (!Array.isArray(verdictsRaw) || verdictsRaw.length === 0 || verdictsRaw.length > VERIFIER_MAX_VERDICTS) {
    throw new AssignmentError(`verifier result verdicts must be an array (1..${VERIFIER_MAX_VERDICTS})`);
  }
  const seenOrdinals = new Set<number>();
  const verdicts: VerifierVerdict[] = verdictsRaw.map((v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new AssignmentError("each verdict must be an object");
    }
    const verdict = v as Record<string, unknown>;
    const ordinal = verdict.ordinal;
    if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 1) {
      throw new AssignmentError("verdict ordinal must be a positive integer");
    }
    if (seenOrdinals.has(ordinal)) {
      throw new AssignmentError(`duplicate verdict ordinal ${ordinal}`);
    }
    seenOrdinals.add(ordinal);
    if (
      typeof verdict.verdict !== "string" ||
      !VERIFIER_VERDICT_VALUES.includes(verdict.verdict as VerifierVerdictValue)
    ) {
      throw new AssignmentError(
        `verdict must be one of ${VERIFIER_VERDICT_VALUES.join(", ")}`,
      );
    }
    const reasoning = verdict.reasoning;
    if (
      typeof reasoning !== "string" ||
      reasoning.trim().length === 0 ||
      reasoning.length > RESULT_SUMMARY_MAX_CHARS
    ) {
      throw new AssignmentError(`verdict reasoning required (≤ ${RESULT_SUMMARY_MAX_CHARS} chars)`);
    }
    // Absent/empty citation_ids parse — a confirmation with no citations is
    // rejected in applyVerifierVerdict against the builder's actual citations.
    const citationIdsRaw = verdict.citation_ids;
    let citationIds: number[] = [];
    if (citationIdsRaw !== undefined && citationIdsRaw !== null) {
      if (!Array.isArray(citationIdsRaw)) {
        throw new AssignmentError("verdict citation_ids must be an array of positive integers");
      }
      citationIds = citationIdsRaw.map((id) => {
        if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
          throw new AssignmentError("verdict citation_ids must be positive integers");
        }
        return id;
      });
    }
    return {
      ordinal,
      verdict: verdict.verdict as VerifierVerdictValue,
      reasoning: reasoning.trim(),
      citationIds,
    };
  });
  let confidence: number | null = null;
  if (obj.confidence !== undefined && obj.confidence !== null) {
    if (
      typeof obj.confidence !== "number" ||
      !Number.isFinite(obj.confidence) ||
      obj.confidence < 0 ||
      obj.confidence > 1
    ) {
      throw new AssignmentError("verifier result confidence must be within 0..1");
    }
    confidence = obj.confidence;
  }
  let openQuestions: string[] = [];
  if (obj.open_questions !== undefined && obj.open_questions !== null) {
    if (!Array.isArray(obj.open_questions) || obj.open_questions.length > RESULT_MAX_OPEN_QUESTIONS) {
      throw new AssignmentError(`verifier result open_questions must be an array (≤ ${RESULT_MAX_OPEN_QUESTIONS})`);
    }
    openQuestions = obj.open_questions.map((q) => {
      if (typeof q !== "string" || q.trim().length === 0 || q.length > RESULT_OPEN_QUESTION_MAX_CHARS) {
        throw new AssignmentError(`each open question must be a non-empty string (≤ ${RESULT_OPEN_QUESTION_MAX_CHARS} chars)`);
      }
      return q.trim();
    });
  }
  return { summary: summary.trim(), verdicts, confidence, openQuestions };
}

// -------------------------------------------------------------- application

/**
 * Applies a parsed verifier result to the outcome's criteria. Every check is
 * structural and fail-closed: the verifier must be a SUCCEEDED verifier
 * assignment on this outcome bound to a DIFFERENT succeeded research
 * (builder) assignment; confirmations must cite the builder's citations;
 * the verdicts must cover EXACTLY the criteria's ordinal set.
 */
export async function applyVerifierVerdict(
  db: AssignmentDb,
  input: {
    readonly verifierAssignmentId: string;
    readonly outcomeId: string;
    /** ALREADY parsed — this function never re-validates the envelope. */
    readonly result: VerifierResult;
  },
  opts: { readonly now: Date; readonly actor: string },
): Promise<{ readonly applied: number; readonly overall: "pass" | "fail" | "partial" }> {
  const verifier = await db.query(
    `SELECT id, role, status, outcome_id, verifies_assignment_id FROM assignments WHERE id = $1::uuid`,
    [input.verifierAssignmentId],
  );
  const verifierRow = verifier.rows[0] as
    | { id: string; role: string; status: string; outcome_id: string | null; verifies_assignment_id: string | null }
    | undefined;
  if (verifierRow === undefined) {
    throw new AssignmentError(`verifier assignment ${input.verifierAssignmentId} not found`);
  }
  if (verifierRow.role !== "verifier") {
    throw new AssignmentError(`assignment ${verifierRow.id} has role '${verifierRow.role}', not verifier`);
  }
  if (verifierRow.status !== "succeeded") {
    throw new AssignmentError(`verifier assignment ${verifierRow.id} is ${verifierRow.status}, not succeeded`);
  }
  if (verifierRow.outcome_id === null || String(verifierRow.outcome_id) !== input.outcomeId) {
    throw new AssignmentError(`verifier assignment ${verifierRow.id} is not bound to outcome ${input.outcomeId}`);
  }
  // Builder ≠ verifier is structural: the binding must exist and never
  // point back at the verifier itself (or at another verifier).
  const verifiesId = verifierRow.verifies_assignment_id === null ? null : String(verifierRow.verifies_assignment_id);
  if (verifiesId === null) {
    throw new AssignmentError(`verifier assignment ${verifierRow.id} verifies nothing (verifies_assignment_id unset)`);
  }
  if (verifiesId === input.verifierAssignmentId) {
    throw new AssignmentError("builders don't self-verify: verifier assignment verifies itself");
  }
  const builder = await db.query(
    `SELECT id, role, status, outcome_id, result FROM assignments WHERE id = $1::uuid`,
    [verifiesId],
  );
  const builderRow = builder.rows[0] as
    | { id: string; role: string; status: string; outcome_id: string | null; result: Record<string, unknown> | null }
    | undefined;
  if (builderRow === undefined) {
    throw new AssignmentError(`verified assignment ${verifiesId} not found`);
  }
  if (builderRow.role !== "research") {
    throw new AssignmentError(`verified assignment ${builderRow.id} has role '${builderRow.role}', not research`);
  }
  if (builderRow.status !== "succeeded") {
    throw new AssignmentError(`verified assignment ${builderRow.id} is ${builderRow.status}, not succeeded`);
  }
  if (builderRow.outcome_id === null || String(builderRow.outcome_id) !== input.outcomeId) {
    throw new AssignmentError(`verified assignment ${builderRow.id} is not on outcome ${input.outcomeId}`);
  }
  const citationsRaw = (builderRow.result ?? {}) as { citations?: unknown };
  const citations = citationsRaw.citations;
  if (!Array.isArray(citations)) {
    throw new AssignmentError(`verified assignment ${builderRow.id} has no citations array in its result`);
  }
  const citationCount = citations.length;

  // Coverage must be EXACT: the full criteria ordinal set, no missing,
  // extra, or duplicate ordinals (duplicates already rejected at parse).
  const criteria = await db.query(
    `SELECT ordinal FROM outcome_criteria WHERE outcome_id = $1::uuid ORDER BY ordinal`,
    [input.outcomeId],
  );
  const criteriaOrdinals = criteria.rows.map((r) => Number((r as { ordinal: number }).ordinal));
  const verdictOrdinals = new Set(input.result.verdicts.map((v) => v.ordinal));
  if (
    input.result.verdicts.length !== criteriaOrdinals.length ||
    criteriaOrdinals.some((o) => !verdictOrdinals.has(o))
  ) {
    throw new AssignmentError(
      `verdict ordinals (${[...verdictOrdinals].sort((a, b) => a - b).join(",")}) must exactly cover criteria ordinals (${criteriaOrdinals.join(",")})`,
    );
  }

  // A confirmation without builder evidence is rejected outright.
  for (const verdict of input.result.verdicts) {
    if (verdict.verdict !== "confirmed") continue;
    if (verdict.citationIds.length === 0 || verdict.citationIds.some((id) => id > citationCount)) {
      throw new AssignmentError(
        `verdict ${verdict.ordinal} confirms without a valid citation (builder has ${citationCount})`,
      );
    }
  }

  let anyRefuted = false;
  let allConfirmed = true;
  for (const verdict of input.result.verdicts) {
    if (verdict.verdict === "confirmed") {
      await setCriterionStatus(db, input.outcomeId, verdict.ordinal, "verified", {
        now: opts.now,
        actor: opts.actor,
        verifiedByAssignmentId: input.verifierAssignmentId,
      });
    } else {
      allConfirmed = false;
      if (verdict.verdict === "refuted") {
        anyRefuted = true;
        await setCriterionStatus(db, input.outcomeId, verdict.ordinal, "failed", {
          now: opts.now,
          actor: opts.actor,
        });
      } else {
        await setCriterionStatus(db, input.outcomeId, verdict.ordinal, "unverified", {
          now: opts.now,
          actor: opts.actor,
        });
      }
    }
  }
  const overall: "pass" | "fail" | "partial" =
    anyRefuted ? "fail" : allConfirmed ? "pass" : "partial";
  const applied = input.result.verdicts.length;

  // Metadata-only audit (ids/counts, never verdict reasoning).
  await recordAudit(db, {
    actor: opts.actor,
    action: "assignment.verdict_applied",
    reversible: true,
    outputsRef: JSON.stringify({
      outcomeId: input.outcomeId,
      verifierAssignmentId: input.verifierAssignmentId,
      applied,
      overall,
      at: opts.now.toISOString(),
    }),
  });
  return { applied, overall };
}
