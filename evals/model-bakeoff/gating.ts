/**
 * §5 model bake-off — spend gating math (plan intelligence-reset.md §5).
 *
 * Pure, hermetic, unit-tested. Two layers, shared by Track A and the
 * capability probe:
 *
 *  1. SMOKE GATE (before the full run): a small live smoke (2 scenarios for
 *     Track A, 2 turns for the probe, every candidate) measures per-answer
 *     means; the full-run projection must fit the track's dollar split
 *     (Track A $4, probe $1) or the full run refuses to start.
 *  2. IN-RUN GUARD: the existing linear projection from the answer-quality
 *     runner (`projectedWithinCeiling`) aborts before the call that would
 *     breach the ceiling once the run is under way.
 */

/** Track A split from plan §5 ($10 total: Track A ~$4 — here the hard $4). */
export const TRACK_A_CEILING_USD = 4.0;
/** Capability-probe split from plan §5 (~$1 hard). */
export const PROBE_CEILING_USD = 1.0;
/** Pairwise render is cheap but still live-capped (48 calls ≈ cents). */
export const PAIRWISE_CEILING_USD = 1.0;
/** Smoke size: plan §5 says "a small 2-scenario smoke first". */
export const SMOKE_SCENARIOS = 2;
export const SMOKE_TURNS = 2;

export interface SmokeMeasures {
  /** Measured mean reply cost per scenario, per candidate model id. */
  readonly candidatePerAnswerUsd: ReadonlyMap<string, number>;
  /** Measured mean judge cost per scored reply (Track A only; 0 for probe). */
  readonly judgePerCallUsd: number;
  /** Actually spent on the smoke itself. */
  readonly smokeSpendUsd: number;
}

/**
 * Projects the FULL-run cost from smoke-measured per-answer means:
 * smoke spend + Σ_candidate(per-answer mean × remaining scenarios)
 * + judge per-call mean × remaining scenario×candidate pairs.
 * Conservative by construction (means, not mins; judge included).
 */
export function projectFullRun(input: {
  readonly measures: SmokeMeasures;
  readonly totalScenarios: number;
  readonly smokeScenarios: number;
}): number {
  const remaining = Math.max(0, input.totalScenarios - input.smokeScenarios);
  const candidates = input.measures.candidatePerAnswerUsd.size;
  let projected = input.measures.smokeSpendUsd;
  for (const perAnswer of input.measures.candidatePerAnswerUsd.values()) {
    projected += perAnswer * remaining;
  }
  projected += input.measures.judgePerCallUsd * remaining * candidates;
  return projected;
}

export interface GateDecision {
  readonly ok: boolean;
  readonly projectedUsd: number;
  readonly ceilingUsd: number;
  readonly headroomUsd: number;
  readonly reason: string | null;
}

/** The hard gate: Track A / probe REFUSES to start over the projection. */
export function gateFullRun(projectedUsd: number, ceilingUsd: number): GateDecision {
  const ok = projectedUsd <= ceilingUsd;
  return {
    ok,
    projectedUsd,
    ceilingUsd,
    headroomUsd: ceilingUsd - projectedUsd,
    reason: ok
      ? null
      : `projected $${projectedUsd.toFixed(4)} exceeds the $${ceilingUsd.toFixed(2)} split — trim per plan §5 (shrink scenario count before dropping candidates)`,
  };
}

/** Mean of a numeric list; null when empty (the runner's convention). */
export function meanOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

/** Nearest-rank percentile (p50 of [1,2,3] → 2; p95 rounds up). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}
