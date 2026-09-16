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
