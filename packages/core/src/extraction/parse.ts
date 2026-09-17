/**
 * Extraction output parsing (M5B).
 *
 * Defense-in-depth against prompt injection (T1): the model's output is
 * parsed against a STRICT allowlist — unknown top-level fields are dropped
 * (never stored, never forwarded), never merged into any payload. An
 * injected "tool", "instructions", or "system_directive" field from a
 * compromised or hostile model response cannot survive into a candidate.
 */

export type ExtractionDirection = "owes_me" | "i_owe";

/** The allowlisted, validated extraction proposal. */
export interface ExtractionProposal {
  readonly isCommitment: boolean;
  readonly isDecision: boolean;
  readonly direction: ExtractionDirection | null;
  readonly counterparty: string | null;
  /** ISO date YYYY-MM-DD or null. */
  readonly dueDate: string | null;
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_FIELD = 2000;
const ALLOWED_FIELDS = [
  "is_commitment",
  "is_decision",
  "direction",
  "counterparty",
  "due_date",
  "confidence",
  "description",
  "question",
  "chosen",
  "rationale",
] as const;

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

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

  const dueRaw = optionalText(raw.due_date);
  const dueDate = dueRaw !== null && isIsoDate(dueRaw) ? dueRaw : null;

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
      dueDate,
      confidence,
      description: textField(raw, "description"),
      question: textField(raw, "question"),
      chosen: textField(raw, "chosen"),
      rationale: textField(raw, "rationale"),
    },
    droppedFields,
  };
}
