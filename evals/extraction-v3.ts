/**
 * Eval extraction adapter v3 (lane W6B) — the CONTRACT-DRIVEN pipeline the
 * eval tiers run while the real v3 extraction lands in lane W6A: the REAL
 * prompt builder from @jehad/core → injected provider → an eval-owned v3
 * allowlist parse (unknown top-level fields dropped, never merged — same
 * defense-in-depth as the core parser) → the eval reference normalizer
 * (normalizer.ts) producing the TemporalProvenance block metrics consume.
 *
 * The model output shape is v3 per the owner directive: no raw due_date —
 * temporal_expression (+ temporal_type) echoed from the text, resolved by
 * the deterministic normalizer; commitment_state classified by the model.
 * When W6A merges, the eval tiers swap this adapter for the real v3
 * pipeline without touching metrics (shapes are identical by contract).
 */

import type { ModelProvider } from "@jehad/adapters";
import { buildExtractionPrompt } from "@jehad/core";
import type { EventEnvelope } from "@jehad/core";
import type { CommitmentState } from "@jehad/core";
import { DEFAULT_ANCHOR_TIMEZONE, normalizeTemporalExpression } from "@jehad/core";
import type { Direction, EvalPrediction, TemporalBlock } from "./metrics.js";

export class EvalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalParseError";
  }
}

const ALLOWED_FIELDS = [
  "is_commitment",
  "direction",
  "counterparty",
  "confidence",
  "temporal_expression",
  "temporal_type",
  "commitment_state",
  "description",
  "question",
  "chosen",
  "rationale",
] as const;

const COMMITMENT_STATES: readonly CommitmentState[] = [
  "prospective",
  "active",
  "completed",
  "historical",
  "renegotiated",
  "cancelled",
  "hypothetical",
];

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
  throw new EvalParseError("model output contains no JSON object");
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) return null;
  return trimmed;
}

export interface ParsedV3Output {
  readonly proposal: {
    readonly isCommitment: boolean;
    readonly direction: Direction | null;
    readonly counterparty: string | null;
    readonly confidence: number;
    readonly temporalExpression: string | null;
    readonly commitmentState: CommitmentState | null;
  };
  readonly droppedFields: readonly string[];
}

/** Parses one v3 model completion against the allowlist (injection-safe). */
export function parseV3ExtractionOutput(text: string): ParsedV3Output {
  const raw = jsonObjectFrom(text);
  const droppedFields = Object.keys(raw).filter(
    (key) => !(ALLOWED_FIELDS as readonly string[]).includes(key),
  );

  const directionRaw = raw.direction;
  const direction: Direction | null =
    directionRaw === "owes_me" || directionRaw === "i_owe" ? directionRaw : null;

  const confidenceRaw = raw.confidence;
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.5;

  const stateRaw = raw.commitment_state;

  return {
    proposal: {
      isCommitment: raw.is_commitment === true,
      direction,
      counterparty: optionalText(raw.counterparty),
      confidence,
      temporalExpression: optionalText(raw.temporal_expression),
      commitmentState:
        typeof stateRaw === "string" && (COMMITMENT_STATES as readonly string[]).includes(stateRaw)
          ? (stateRaw as CommitmentState)
          : null,
    },
    droppedFields,
  };
}

/** Builds the candidate temporal block from an echoed expression + anchor. */
export function temporalBlockFor(
  temporalExpression: string | null,
  anchorIso: string,
): TemporalBlock {
  const result = normalizeTemporalExpression({
    expression: temporalExpression,
    anchorTime: anchorIso,
    anchorTimezone: DEFAULT_ANCHOR_TIMEZONE,
  });
  return {
    rawExpression: temporalExpression,
    normalizedTime: result.normalizedTime,
    resolutionStatus: result.resolutionStatus,
  };
}

export interface V3PipelineResult {
  readonly prediction: EvalPrediction;
  readonly droppedFields: readonly string[];
  readonly promptVersion: string;
}

/** Prompt → provider → v3 parse → reference normalize → EvalPrediction. */
export async function runV3Extraction(
  provider: ModelProvider,
  envelope: EventEnvelope,
  opts: { model: string },
): Promise<V3PipelineResult> {
  const { prompt, promptVersion } = buildExtractionPrompt(envelope);
  const result = await provider.complete({
    domainId: envelope.domainId,
    sensitivity: envelope.sensitivity,
    provider: provider.id,
    model: opts.model,
    prompt,
    runId: envelope.runId ?? undefined,
  });
  const { proposal, droppedFields } = parseV3ExtractionOutput(result.text);
  const temporal = proposal.isCommitment
    ? temporalBlockFor(proposal.temporalExpression, envelope.occurredAt)
    : null;
  return {
    prediction: {
      isCommitment: proposal.isCommitment,
      direction: proposal.direction,
      counterparty: proposal.counterparty,
      confidence: proposal.confidence,
      commitmentState: proposal.commitmentState,
      temporal,
    },
    droppedFields,
    promptVersion,
  };
}
