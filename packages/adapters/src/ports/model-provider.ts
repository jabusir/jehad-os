/**
 * ModelProvider port — model calls, egress-gated (plan §4).
 *
 * Source: plan §9 (ModelEgressPolicy; context building calls policy BEFORE
 * provider dispatch), plan §15 M5 (OpenRouter is the first implementation).
 * Defining ADR: ADR-0012 (model/data egress policy enforced before provider
 * dispatch).
 */
import type { Sensitivity } from "./source-adapter.js";

/**
 * Egress policy per plan §9 (shape per review §7; ADR-0012). The question
 * is: may *this data* (domain × sensitivity) leave for *this provider/model*?
 * Policy is data (configuration) — tightening for a future employer is an
 * edit, not a code change.
 */
export interface ModelEgressPolicy {
  readonly domainId: string;
  readonly sensitivity: Sensitivity;
  readonly allowedProviders: readonly string[];
  readonly allowedModels?: readonly string[];
  readonly allowRemote: boolean;
  readonly requireRedaction: boolean;
}

/**
 * A model call request. `domainId` + `sensitivity` are REQUIRED on every
 * request — they select the ModelEgressPolicy consulted before dispatch
 * (ADR-0012). Secrets never enter prompts (AGENTS.md, T4).
 *
 * TODO(at M5): full message/params shape (system prompt, messages array,
 * token/stop controls, structured output).
 */
export interface ModelRequest {
  readonly domainId: string;
  readonly sensitivity: Sensitivity;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  /** Set when the call happens inside a run (model_calls ledger, plan §7/§14). */
  readonly runId?: string;
}

// ---------------------------------------------------------------------------
// Native tool-calling chat (native-tool-cognition.md §5.1 — additive port).
// `complete()` stays the text-completion contract for every existing caller;
// `chat()` is the typed tool-calling surface the native cognition loop uses.
// ---------------------------------------------------------------------------

/** One provider-normalized tool call inside an assistant turn. */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON string exactly as the provider returned it (parsed by the gateway). */
  readonly arguments: string;
}

/** A chat message in provider-normalized shape (vendor types stay inside adapters). */
export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ChatToolCall[] }
  | { readonly role: "tool"; readonly content: string; readonly toolCallId: string };

/** A tool definition (JSON-schema parameters — validated again at the gateway). */
export interface ChatTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/**
 * A PROVIDER-OPERATED server tool (mission-execution v1): the provider
 * executes it inside the request loop and folds the results into the model's
 * context. OpenRouter names them `openrouter:*`; the exact wire type string
 * is the provider's contract — this port only carries it opaquely. Never
 * granted globally: callers pass server tools per request, and policy (the
 * workers ceiling) decides which role's request may carry them.
 */
export interface ChatServerTool {
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
}

/**
 * A citation the PROVIDER attached to generated content — the mechanical
 * record of an externally retrieved source (url_citation annotations).
 * Software truth, not model prose: research results may cite only URLs that
 * appear here (or were provably fetched), never URLs the model invented.
 */
export interface WebCitation {
  readonly url: string;
  readonly title?: string;
  readonly content?: string;
}

/** Server-tool usage reported by the provider (spend/count audit trail). */
export interface ServerToolUse {
  readonly webSearchRequests?: number;
  readonly webFetchRequests?: number;
}

export interface ChatRequest {
  readonly domainId: string;
  readonly sensitivity: Sensitivity;
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** Absent/empty = plain chat (no tool surface offered). */
  readonly tools?: readonly ChatTool[];
  /**
   * Provider-operated server tools for THIS request only (read-only web
   * tools for the research role; nothing else). Absent = no server tools.
   */
  readonly serverTools?: readonly ChatServerTool[];
  /**
   * Hard cap on total server-tool steps for the request (OpenRouter's
   * `max_tool_calls`); omitted = provider default.
   */
  readonly maxToolCalls?: number;
  /**
   * Per-call provider timeout (the native path's ratified T_native, 15s).
   * Providers honor min(this, their own default); omitted = provider default.
   */
  readonly timeoutMs?: number;
  /** Set when the call happens inside a run (model_calls ledger). */
  readonly runId?: string;
}

export interface ChatResult {
  /** Assistant text content ("" when the turn is pure tool calls). */
  readonly text: string;
  /** Tool calls requested by the assistant, in provider order. */
  readonly toolCalls: readonly ChatToolCall[];
  /** Provider-attached web citations (mechanical retrieval record). */
  readonly annotations?: readonly WebCitation[];
  readonly usage?: ModelResult["usage"] & { readonly serverToolUse?: ServerToolUse };
  readonly providerRef?: string;
}

/**
 * TODO(at M5): full result shape (finish reason, raw provider ref, latency).
 * Usage/cost feed the `model_calls` ledger (plan §14).
 */
export interface ModelResult {
  readonly text: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
  };
  readonly providerRef?: string;
}

/**
 * EGRESS GATE — binding contract on every implementation (ADR-0012).
 *
 * preDispatch check, REQUIRED before any provider dispatch:
 * 1. Resolve the applicable `ModelEgressPolicy` for
 *    `request.domainId × request.sensitivity × provider/model`.
 * 2. If that data may not go there — deny by raising; the denial is audited
 *    BEFORE any model call occurs. `secret` sensitivity is never in model
 *    context. Never rely on prompts saying "don't expose this."
 * 3. Honor `allowRemote` (remote-domain content never transits personal
 *    providers — ADR-0010, T15) and `requireRedaction` (redact before
 *    dispatch; concrete redaction machinery lands when a policy first
 *    requires it).
 * 4. Compose with the `call_model:<provider>` capability grant (ADR-0007):
 *    the grant says the run may call a provider; the egress policy says this
 *    data may go there. BOTH must pass.
 *
 * Every `model_calls` row implies the egress-policy check passed.
 */
export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResult>;
  /**
   * Native tool-calling chat (native-tool-cognition §5.1). OPTIONAL:
   * providers without the capability simply omit it — callers must treat
   * its absence as an infrastructure refusal (the native loop refuses to
   * run on such a provider rather than degrading silently).
   */
  chat?(request: ChatRequest): Promise<ChatResult>;
}
