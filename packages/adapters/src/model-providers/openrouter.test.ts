// OpenRouterProvider unit tests — hermetic: global fetch is stubbed, no
// network, no real key (plan §13). The live smoke below is the ONLY
// network-touching test and skips cleanly when OPENROUTER_API_KEY is absent
// (plan §13: live-model evals are opt-in, key stays in gitignored .env).

import { afterEach, describe, expect, it, vi } from "vitest";
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
