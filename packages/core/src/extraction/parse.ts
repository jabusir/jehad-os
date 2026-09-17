/**
 * Extraction output parsing (M5B).
 *
 * Defense-in-depth against prompt injection (T1): the model's output is
 * parsed against a STRICT allowlist — unknown top-level fields are dropped
 * (never stored, never forwarded), never merged into any payload. An
 * injected "tool", "instructions", or "system_directive" field from a
 * compromised or hostile model response cannot survive into a candidate.
 */

import type { CommitmentState } from "../memory/candidate-contract.js";

export type ExtractionDirection = "owes_me" | "i_owe";

export type TemporalType = "relative" | "absolute" | "vague";

/** The allowlisted, validated extraction proposal. */
export interface ExtractionProposal {
  readonly isCommitment: boolean;
  readonly isDecision: boolean;
  readonly direction: ExtractionDirection | null;
  readonly counterparty: string | null;
  /** Verbatim temporal phrase from the text; resolution is NOT the model's job. */
  readonly temporalExpression: string | null;
  readonly temporalType: TemporalType | null;
  readonly commitmentState: CommitmentState | null;
  /** Clamped to [0,1]. */
  readonly confidence: number;
  readonly description: string | null;
  readonly question: string | null;
  readonly chosen: string | null;
  readonly rationale: string | null;
}

export class ExtractionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionParseError";
  }
}

export interface ParsedExtraction {
  readonly proposal: ExtractionProposal;
  /**
   * Names of unknown top-level fields present in the model output but
   * dropped by the allowlist (injection telemetry — surfaced, never stored
   * in candidate payloads).
   */
  readonly droppedFields: readonly string[];
}

const MAX_TEXT_FIELD = 2000;
const ALLOWED_FIELDS = [
  "is_commitment",
  "is_decision",
  "direction",
  "counterparty",
  "temporal_expression",
  "temporal_type",
  "commitment_state",
  "confidence",
  "description",
  "question",
  "chosen",
  "rationale",
] as const;

const TEMPORAL_TYPES: readonly TemporalType[] = ["relative", "absolute", "vague"];
const COMMITMENT_STATES: readonly CommitmentState[] = [
  "prospective",
  "active",
  "completed",
  "historical",
  "renegotiated",
  "cancelled",
  "hypothetical",
];

function boolField(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  return value === true;
}

function textField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_FIELD) return null;
  return trimmed;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_FIELD) return null;
  return trimmed;
}

/** Extracts the outermost JSON object from raw model text; throws on none. */
function jsonObjectFrom(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  throw new ExtractionParseError("model output contains no JSON object");
}

/**
 * Parses and validates one model completion against the allowlisted
 * extraction schema. Unknown fields are dropped and reported; known fields
 * with wrong types degrade to null/false rather than failing the run
 * (extraction quality is measured by evals, not runtime throws).
 */
export function parseExtractionOutput(text: string): ParsedExtraction {
  const raw = jsonObjectFrom(text);
  const droppedFields = Object.keys(raw).filter(
    (key) => !(ALLOWED_FIELDS as readonly string[]).includes(key),
  );

  const directionRaw = raw.direction;
  const direction: ExtractionDirection | null =
    directionRaw === "owes_me" || directionRaw === "i_owe" ? directionRaw : null;

  const temporalTypeRaw = raw.temporal_type;
  const temporalType: TemporalType | null =
    typeof temporalTypeRaw === "string" && (TEMPORAL_TYPES as readonly string[]).includes(temporalTypeRaw)
      ? (temporalTypeRaw as TemporalType)
      : null;

  const commitmentStateRaw = raw.commitment_state;
  const commitmentState: CommitmentState | null =
    typeof commitmentStateRaw === "string" &&
    (COMMITMENT_STATES as readonly string[]).includes(commitmentStateRaw)
      ? (commitmentStateRaw as CommitmentState)
      : null;

  const confidenceRaw = raw.confidence;
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.5;

  return {
    proposal: {
      isCommitment: boolField(raw, "is_commitment"),
      isDecision: boolField(raw, "is_decision"),
      direction,
      counterparty: optionalText(raw.counterparty),
      temporalExpression: optionalText(raw.temporal_expression),
      temporalType,
      commitmentState,
      confidence,
      description: textField(raw, "description"),
      question: textField(raw, "question"),
      chosen: textField(raw, "chosen"),
      rationale: textField(raw, "rationale"),
    },
    droppedFields,
  };
}
