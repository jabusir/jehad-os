/**
 * HarnessAdapter port — delegate work to a harness
 * (start/resume/status/cancel/artifacts/logs).
 *
 * Source: plan §4 (ports list), plan §15; docs/harness-architecture.md §5.
 * Defining ADR: ADR-0002 (harnesses are replaceable peripherals; no harness
 * SDK imports in packages/core).
 *
 * Phasing (final-cleanup review §1): interface DEFINED in Phase 1; first
 * concrete HarnessAdapter implementation lands in Phase 3 (delegation —
 * coding/review execution via Claude Code / Codex; Jehad OS dispatches
 * only, plan §5). The shape below is intentionally minimal:
 *
 * Reference shape (docs/harness-architecture.md §5.2, directive §11.5) —
 * DIRECTION ONLY, not committed as the interface; the concrete surface is
 * fixed later in Phase 1 by the M-lanes:
 *   capabilities() · start(task) → RunHandle · resume(runId, input) ·
 *   status(runId) → RunStatus · cancel(runId) · artifacts(runId) ·
 *   logs(runId): AsyncIterable<RunEvent>
 */
export interface HarnessAdapter {
  readonly id: string;
}

// ---------------------------------------------------------------------------
// D1 — the worker contract's V1 adapter surface (roadmap §8.1).
// ModelHarnessAdapter: in-process, model-bounded. `start` executes ONE
// structured model call under the egress gate and the monthly budget; the
// caller enforces the per-assignment budget/deadline (assignment rows are
// canonical). In-process runs complete inside `start`, so `status` reports
// terminal runs it has seen and honestly reports unknown ids otherwise;
// `cancel` is V1-honest (nothing long-running to cancel); `artifacts`
// returns the terminal text for seen runs.
// ---------------------------------------------------------------------------

/**
 * Bounded read-only web capability for ONE harness run (mission-execution
 * v1). Present on a spec → the provider's server-side web tools (search +
 * fetch) are offered to the model for that request only, hard-capped.
 * Absent → no web tools, exactly the pre-v1 behavior. Read-only by
 * construction: the granted tool set has no write surface.
 */
export interface HarnessWebSpec {
  /** Max web searches in the request (policy-capped). */
  readonly maxSearches: number;
  /** Max web fetches in the request (policy-capped). */
  readonly maxFetches: number;
  /** Max retrieved-source content tokens per fetch. */
  readonly maxSourceContentTokens: number;
}

export interface HarnessRunSpec {
  /** The FULL worker prompt: role stance + context package + output contract. */
  readonly prompt: string;
  readonly promptVersion: string | null;
  readonly model: string;
  /** Canonical runs row for the model_calls ledger (NOT NULL at the DB). */
  readonly runId: string;
  readonly principalId: string | null;
  readonly outcomeId: string | null;
  readonly assignmentId: string | null;
  /** Present ONLY for roles whose policy grants bounded read-only web. */
  readonly web?: HarnessWebSpec;
}

export interface HarnessRunResult {
  readonly ok: boolean;
  readonly text: string;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** Provider-attached web citations — the mechanical retrieval record. */
  readonly annotations?: readonly import("./model-provider.js").WebCitation[];
  /** Server-tool usage reported by the provider (spend/count audit). */
  readonly serverToolUse?: import("./model-provider.js").ServerToolUse;
  /** Set when ok=false: machine-readable denial class. */
  readonly denial?: "deadline_exceeded" | "provider_error" | "empty_output";
}

export interface HarnessRunStatus {
  readonly runKey: string;
  readonly state: "succeeded" | "failed" | "unknown";
  readonly latencyMs: number | null;
}

export interface HarnessCapableAdapter extends HarnessAdapter {
  capabilities(): readonly string[];
  start(spec: HarnessRunSpec): Promise<HarnessRunResult>;
  status(runKey: string): HarnessRunStatus;
  cancel(runKey: string): Promise<{ cancelled: boolean; reason: string }>;
  artifacts(runKey: string): Promise<{ readonly text: string | null }>;
}
