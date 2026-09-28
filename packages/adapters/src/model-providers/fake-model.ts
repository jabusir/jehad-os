// FakeModelProvider — deterministic test double for the ModelProvider port
// (plan §13 hermetic checks; plan §15 M5). Pure in-memory: no network I/O,
// no clock dependence (latency simulation is opt-in and static). The same
// construction answers every call identically — eval suites (M5B) script
// per-request behavior through a responder function instead.
//
// `requests` records every dispatched request so tests can assert dispatch
// happened (or did NOT happen — egress denials must never reach a provider,
// T12). It is test state in memory only; nothing is ever logged (T4).

import type {
  ChatRequest,
  ChatResult,
  ModelProvider,
  ModelRequest,
  ModelResult,
} from "../ports/model-provider.js";

/** A fixed result, or per-request responder (may throw to model failures). */
export type FakeModelResponder =
  | ModelResult
  | ((request: ModelRequest) => ModelResult | Promise<ModelResult>);

/** Chat-side responder: scripted tool-call trajectories for the native loop. */
export type FakeModelChatResponder =
  | ChatResult
  | ((request: ChatRequest) => ChatResult | Promise<ChatResult>);

export interface FakeModelProviderOptions {
  /** Fixed result for every call (default: deterministic canned text). */
  readonly respond?: FakeModelResponder;
  /** Chat responder for native tool-calling calls (default: canned text). */
  readonly respondChat?: FakeModelChatResponder;
  /** Throw this from every call, after recording the request. */
  readonly failWith?: Error;
  /** Static simulated latency (default 0 — deterministic, no timers). */
  readonly latencyMs?: number;
  readonly id?: string;
}

export class FakeModelProvider implements ModelProvider {
  readonly id: string;

  /** Every request ever dispatched to this provider, in order. */
  readonly requests: ModelRequest[] = [];

  /** Every chat request ever dispatched to this provider, in order. */
  readonly chatRequests: ChatRequest[] = [];

  private readonly respond: FakeModelResponder;
  private readonly respondChat: FakeModelChatResponder;
  private readonly failWith?: Error;
  private readonly latencyMs: number;

  constructor(options: FakeModelProviderOptions = {}) {
    this.id = options.id ?? "fake";
    this.respond = options.respond ?? { text: "fake-model-response" };
    this.respondChat = options.respondChat ?? { text: "fake-model-response", toolCalls: [] };
    this.failWith = options.failWith;
    this.latencyMs = options.latencyMs ?? 0;
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    if (this.failWith !== undefined) throw this.failWith;
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    return typeof this.respond === "function" ? await this.respond(request) : this.respond;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.chatRequests.push(request);
    if (this.failWith !== undefined) throw this.failWith;
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    return typeof this.respondChat === "function" ? await this.respondChat(request) : this.respondChat;
  }
}
