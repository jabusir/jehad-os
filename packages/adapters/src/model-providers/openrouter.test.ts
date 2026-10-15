// OpenRouterProvider unit tests — hermetic: global fetch is stubbed, no
// network, no real key (plan §13). The live smoke below is the ONLY
// network-touching test and skips cleanly when OPENROUTER_API_KEY is absent
// (plan §13: live-model evals are opt-in, key stays in gitignored .env).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest } from "../ports/model-provider.js";
import {
  OpenRouterConfigError,
  OpenRouterRequestError,
  createOpenRouterProvider,
} from "./openrouter.js";

const REQUEST: Parameters<ReturnType<typeof createOpenRouterProvider>["complete"]>[0] = {
  domainId: "personal",
  sensitivity: "normal",
  provider: "openrouter",
  model: "openai/gpt-4o-mini",
  prompt: "ping",
  runId: "00000000-0000-0000-0000-000000000001",
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
});

describe("createOpenRouterProvider (hermetic, mocked fetch)", () => {
  it("sends the chat/completions shape with bearer auth from the explicit key", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        id: "gen-123",
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.000123 },
      }),
    );
    const provider = createOpenRouterProvider({ apiKey: "test-key", fetchImpl: fetchMock });

    const result = await provider.complete(REQUEST);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "ping" }] }),
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({
      text: "pong",
      usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.000123 },
      providerRef: "gen-123",
    });
  });

  it("falls back to OPENROUTER_API_KEY from the environment", async () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const fetchMock = vi.fn(async () => okResponse({ choices: [{ message: { content: "x" } }] }));
    const provider = createOpenRouterProvider({ fetchImpl: fetchMock });

    await provider.complete(REQUEST);

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ authorization: "Bearer env-key" });
  });

  it("throws OpenRouterConfigError without any key — no request is made", async () => {
    const fetchMock = vi.fn();
    const provider = createOpenRouterProvider({ fetchImpl: fetchMock });

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(OpenRouterConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the provider error message on non-2xx and never leaks the key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 }),
    );
    const provider = createOpenRouterProvider({ apiKey: "secret-key", fetchImpl: fetchMock });

    const err = await provider.complete(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterRequestError);
    expect((err as OpenRouterRequestError).status).toBe(402);
    expect((err as Error).message).toBe("Insufficient credits");
    expect((err as Error).message).not.toContain("secret-key");
  });

  it("reports HTTP status when the error body has no safe message", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>gateway</html>", { status: 502 }));
    const provider = createOpenRouterProvider({ apiKey: "k", fetchImpl: fetchMock });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      name: "OpenRouterRequestError",
      status: 502,
      message: expect.not.stringContaining("gateway"),
    });
  });

  it("rejects Authorization headers the provider did not issue (401)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    const provider = createOpenRouterProvider({ apiKey: "k", fetchImpl: fetchMock });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({ name: "OpenRouterRequestError", status: 401 });
  });

  it("tolerates a missing usage block and an empty choices array", async () => {
    const fetchMock = vi.fn(async () => okResponse({ choices: [] }));
    const provider = createOpenRouterProvider({ apiKey: "k", fetchImpl: fetchMock });

    const result = await provider.complete(REQUEST);
    expect(result.text).toBe("");
    expect(result.usage).toEqual({ inputTokens: undefined, outputTokens: undefined, costUsd: undefined });
  });
});

// Native tool-calling chat() — server tools, annotations, server-tool usage
// (mission-execution v1). Hermetic: same fetch-stub style as above.
describe("createOpenRouterProvider chat() (server tools + annotations, mocked fetch)", () => {
  const CHAT_BASE: ChatRequest = {
    domainId: "personal",
    sensitivity: "normal",
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "research ping" }],
  };

  it("maps serverTools ahead of function tools with tool_choice auto and max_tool_calls", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ id: "gen-chat", choices: [{ message: { role: "assistant", content: "ok" } }] }),
    );
    const provider = createOpenRouterProvider({ apiKey: "test-key", fetchImpl: fetchMock });

    const result = await provider.chat!({
      ...CHAT_BASE,
      tools: [{ name: "lookup", description: "d", parameters: { type: "object", properties: {} } }],
      serverTools: [
        { type: "openrouter:web_search", parameters: { max_results: 5 } },
        { type: "openrouter:web_fetch" },
      ],
      maxToolCalls: 4,
    });

    const init = fetchMock.mock.calls[0]![1]!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("openai/gpt-4o-mini");
    expect(body["tools"]).toEqual([
      { type: "openrouter:web_search", parameters: { max_results: 5 } },
      { type: "openrouter:web_fetch" },
      { type: "function", function: { name: "lookup", description: "d", parameters: { type: "object", properties: {} } } },
    ]);
    expect(body["tool_choice"]).toBe("auto");
    expect(body["max_tool_calls"]).toBe(4);
    expect(result.text).toBe("ok");
  });

  it("plain chat sends no tools, no tool_choice, no max_tool_calls", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ id: "gen-plain", choices: [{ message: { role: "assistant", content: "pong" } }] }),
    );
    const provider = createOpenRouterProvider({ apiKey: "test-key", fetchImpl: fetchMock });

    await provider.chat!(CHAT_BASE);

    const init = fetchMock.mock.calls[0]![1]!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["tools"]).toBeUndefined();
    expect(body["tool_choice"]).toBeUndefined();
    expect(body["max_tool_calls"]).toBeUndefined();
  });

  it("parses url_citation annotations into WebCitations and drops everything else", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        id: "gen-ann",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Answer",
              annotations: [
                { type: "url_citation", url_citation: { url: "https://a.example/x", title: "A" } },
                { type: "other" },
              ],
            },
          },
        ],
      }),
    );
    const provider = createOpenRouterProvider({ apiKey: "test-key", fetchImpl: fetchMock });

    const result = await provider.chat!(CHAT_BASE);

    expect(result.annotations).toEqual([{ url: "https://a.example/x", title: "A" }]);
  });

  it("parses usage.server_tool_use counts alongside the base usage", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({
        id: "gen-usage",
        choices: [{ message: { role: "assistant", content: "done" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          cost: 0.001,
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
        },
      }),
    );
    const provider = createOpenRouterProvider({ apiKey: "test-key", fetchImpl: fetchMock });

    const result = await provider.chat!(CHAT_BASE);

    expect(result.usage?.serverToolUse).toEqual({ webSearchRequests: 2, webFetchRequests: 1 });
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(20);
  });
});

// Live smoke — the ONLY non-hermetic test. Absent key → skipped cleanly
// (never committed; .env is gitignored — AGENTS.md secrets rule).
describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouterProvider live smoke", () => {
  it("completes one tiny round-trip and parses usage", { timeout: 30_000 }, async () => {
    const provider = createOpenRouterProvider();
    const result = await provider.complete({
      ...REQUEST,
      prompt: "Reply with exactly: ok",
    });
    expect(typeof result.text).toBe("string");
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
  });
});
