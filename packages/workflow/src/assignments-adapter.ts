// ModelHarnessAdapter (D1; roadmap §8.1) — the first concrete
// HarnessCapableAdapter implementation, owned by the workflow layer (it
// needs core's callModel + the adapters port; living here keeps the
// packages acyclic): in-process, model-bounded. One structured model
// call per assignment execution, through callModel (egress gate + monthly
// budget reservation + model_calls ledger with assignment attribution).
// Per-assignment budget/deadline enforcement lives executive-side in the
// assignment service/executor — this adapter is deliberately thin: it adds
// NO authority, it spends and reports.
//
// In-process means `start` runs to completion before returning: status/
// cancel/artifacts are honest bookkeeping around a memoized terminal map,
// not a scheduler.

import type {
  HarnessCapableAdapter,
  HarnessRunResult,
  HarnessRunSpec,
  HarnessRunStatus,
  ModelProvider,
} from "@jehad/adapters";
import { callModel, type ModelCallDb, type ModelEgressPolicyRegistry } from "@jehad/core";

export interface ModelHarnessAdapterDeps {
  readonly db: ModelCallDb;
  /** The RAW provider; callModel applies the egress gate itself. */
  readonly provider: ModelProvider;
  readonly registry: ModelEgressPolicyRegistry;
  readonly now?: () => Date;
}

interface TerminalRun {
  readonly state: "succeeded" | "failed";
  readonly text: string;
  readonly latencyMs: number;
}

export class ModelHarnessAdapter implements HarnessCapableAdapter {
  readonly id = "model-harness-v1";

  private readonly terminals = new Map<string, TerminalRun>();

  constructor(private readonly deps: ModelHarnessAdapterDeps) {}

  capabilities(): readonly string[] {
    return ["model:call"];
  }

  async start(spec: HarnessRunSpec): Promise<HarnessRunResult> {
    const outcome = await callModel(this.deps, {
      runId: spec.runId,
      domainId: "personal",
      sensitivity: "normal",
      provider: this.deps.provider.id,
      model: spec.model,
      prompt: spec.prompt,
      promptVersion: spec.promptVersion ?? undefined,
      principalId: spec.principalId,
      surface: "assignment",
      outcomeId: spec.outcomeId,
      assignmentId: spec.assignmentId,
    });
    const state: "succeeded" | "failed" = outcome.resultStatus === "error" ? "failed" : "succeeded";
    const denial =
      outcome.resultStatus === "error"
        ? (outcome.result.text === "" ? "provider_error" : "empty_output")
        : undefined;
    this.terminals.set(spec.assignmentId ?? spec.runId, {
      state,
      text: outcome.result.text,
      latencyMs: outcome.latencyMs,
    });
    return {
      ok: outcome.resultStatus !== "error",
      text: outcome.result.text,
      costUsd: outcome.costUsd,
      latencyMs: outcome.latencyMs,
      ...(denial !== undefined ? { denial } : {}),
    };
  }

  status(runKey: string): HarnessRunStatus {
    const terminal = this.terminals.get(runKey);
    if (terminal === undefined) {
      return { runKey, state: "unknown", latencyMs: null };
    }
    return { runKey, state: terminal.state, latencyMs: terminal.latencyMs };
  }

  async cancel(runKey: string): Promise<{ cancelled: boolean; reason: string }> {
    const terminal = this.terminals.get(runKey);
    return terminal !== undefined
      ? { cancelled: false, reason: "run already terminal" }
      : { cancelled: false, reason: "in-process V1: nothing long-running to cancel" };
  }

  async artifacts(runKey: string): Promise<{ readonly text: string | null }> {
    const terminal = this.terminals.get(runKey);
    return { text: terminal?.text ?? null };
  }
}
