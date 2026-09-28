// OpenRouterAdapter — the first ModelProvider implementation (plan §15 M5;
// A5: OpenRouter is the first provider, always behind the egress policy
// ADR-0012). Plain `fetch` only: zero SDK dependencies (AGENTS.md hard rule —
// vendor code stays out of the repo; OpenRouter's HTTP API is stable).
//
// Secrets (T4/AGENTS.md): the API key is read from the environment (or
// injected by the caller) and sent ONLY in the Authorization header. This
// module never logs anything — not the key, not prompts, not responses.
// Vendor response types are module-private and never leak past the
// ModelProvider port (ADR-0002).

import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatToolCall,
  ModelProvider,
  ModelRequest,
  ModelResult,
} from "../ports/model-provider.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 60_000;

/** OpenRouter /chat/completions response — module-private (never exported). */
interface OpenRouterCompletionResponse {
  readonly id?: string;
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly {
        readonly id?: unknown;
        readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
      }[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly cost?: number;
  };
}

export interface OpenRouterProviderOptions {
  /** Defaults to process.env.OPENROUTER_API_KEY; never logged. */
  readonly apiKey?: string;
  /** Override for tests; defaults to the public API. */
  readonly baseUrl?: string;
  /** Request timeout; defaults to 60s. */
  readonly timeoutMs?: number;
  /** fetch implementation; defaults to global fetch (tests stub it). */
  readonly fetchImpl?: typeof fetch;
}

/** Raised for a missing API key — configuration error, before any dispatch. */
export class OpenRouterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterConfigError";
  }
}

/** Raised on non-2xx or unparseable responses. Carries no prompt content. */
export class OpenRouterRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterRequestError";
    this.status = status;
  }
}

function resolveApiKey(explicit?: string): string {
  const key = explicit ?? process.env.OPENROUTER_API_KEY;
  if (typeof key !== "string" || key.length === 0) {
    throw new OpenRouterConfigError(
      "OPENROUTER_API_KEY is not set (copy .env.example to .env); the provider refuses to dispatch without it",
    );
  }
  return key;
}

/**
 * Extracts a safe error message from a failed response body. Only the
 * provider's own `error.message` field is surfaced; the raw body is never
 * embedded (it must not carry prompts or echo the key into logs, T4).
 */
function safeProviderMessage(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // unparseable body — nothing safe to surface
  }
  return undefined;
}

export function createOpenRouterProvider(
  options: OpenRouterProviderOptions = {},
): ModelProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    id: "openrouter",
    async complete(request: ModelRequest): Promise<ModelResult> {
      const apiKey = resolveApiKey(options.apiKey);

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            messages: [{ role: "user", content: request.prompt }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (err instanceof OpenRouterConfigError) throw err;
        throw new OpenRouterRequestError(
          `openrouter request failed before dispatch: ${err instanceof Error ? err.name : "unknown error"}`,
          0,
        );
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const providerMessage = safeProviderMessage(bodyText);
        throw new OpenRouterRequestError(
          providerMessage ?? `openrouter request failed with HTTP ${response.status}`,
          response.status,
        );
      }

      const body = (await response.json().catch(() => {
        throw new OpenRouterRequestError("openrouter returned an unparseable response body", response.status);
      })) as OpenRouterCompletionResponse;

      const choice = body.choices?.[0];
      const text = choice?.message?.content ?? "";
      return {
        text,
        usage: {
          inputTokens: body.usage?.prompt_tokens,
          outputTokens: body.usage?.completion_tokens,
          costUsd: body.usage?.cost,
        },
        providerRef: body.id,
      };
    },

    async chat(request: ChatRequest): Promise<ChatResult> {
      const apiKey = resolveApiKey(options.apiKey);
      // Per-call timeout (the native path's T_native) bounded by the
      // constructor default — a caller can shorten, never extend.
      const effectiveTimeoutMs = Math.min(request.timeoutMs ?? timeoutMs, timeoutMs);

      const messages = request.messages.map(chatRequestToWire);
      const body: Record<string, unknown> = { model: request.model, messages };
      if (request.tools !== undefined && request.tools.length > 0) {
        body["tools"] = request.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        body["tool_choice"] = "auto";
      }

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(effectiveTimeoutMs),
        });
      } catch (err) {
        if (err instanceof OpenRouterConfigError) throw err;
        throw new OpenRouterRequestError(
          `openrouter chat request failed before dispatch: ${err instanceof Error ? err.name : "unknown error"}`,
          0,
        );
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const providerMessage = safeProviderMessage(bodyText);
        throw new OpenRouterRequestError(
          providerMessage ?? `openrouter chat failed with HTTP ${response.status}`,
          response.status,
        );
      }

      const parsed = (await response.json().catch(() => {
        throw new OpenRouterRequestError("openrouter returned an unparseable response body", response.status);
      })) as OpenRouterCompletionResponse;

      const choice = parsed.choices?.[0];
      const message = choice?.message;
      const text = message?.content ?? "";
      const toolCalls: ChatToolCall[] = [];
      const rawCalls = message?.tool_calls;
      if (Array.isArray(rawCalls)) {
        rawCalls.forEach((call, index) => {
          const name = call.function?.name;
          const args = call.function?.arguments;
          if (typeof name !== "string" || name.length === 0) return;
          if (typeof args !== "string" || args.length === 0) return;
          // Arguments must be a JSON object — garbage from the provider is
          // dropped here rather than passed to the gateway (which would
          // only reject it; this keeps the wire surface honest).
          try {
            const parsed: unknown = JSON.parse(args);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
          } catch {
            return;
          }
          const id = typeof call.id === "string" && call.id.length > 0 ? call.id : `call_${index}`;
          toolCalls.push({ id, name, arguments: args });
        });
      }
      return {
        text,
        toolCalls,
        usage: {
          inputTokens: parsed.usage?.prompt_tokens,
          outputTokens: parsed.usage?.completion_tokens,
          costUsd: parsed.usage?.cost,
        },
        providerRef: parsed.id,
      };
    },
  };
}

/** Normalized ChatMessage → OpenRouter wire message (vendor shape stays here). */
function chatRequestToWire(message: ChatMessage): Record<string, unknown> {
  if (message.role === "system" || message.role === "user") {
    return { role: message.role, content: message.content };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  const wire: Record<string, unknown> = { role: "assistant", content: message.content };
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    wire["tool_calls"] = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return wire;
}
