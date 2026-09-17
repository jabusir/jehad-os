// FakeModelProvider tests — determinism (plan §13 hermetic checks).

import { describe, expect, it } from "vitest";
import { FakeModelProvider } from "./fake-model.js";

const REQUEST = {
  domainId: "personal",
  sensitivity: "normal" as const,
  provider: "fake",
  model: "m",
  prompt: "p",
  runId: "00000000-0000-0000-0000-000000000001",
};

describe("FakeModelProvider", () => {
  it("returns the same canned result on every call (deterministic)", async () => {
    const provider = new FakeModelProvider();
    const first = await provider.complete(REQUEST);
    const second = await provider.complete(REQUEST);
    expect(first).toEqual(second);
    expect(first.text).toBe("fake-model-response");
  });

  it("records every dispatched request, in order", async () => {
    const provider = new FakeModelProvider();
    await provider.complete(REQUEST);
    await provider.complete({ ...REQUEST, prompt: "second" });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.prompt).toBe("second");
  });

  it("supports a per-request responder function (eval-suite scripting)", async () => {
    const provider = new FakeModelProvider({
      respond: (request) => ({
        text: `echo:${request.prompt.length}`,
        usage: { inputTokens: request.prompt.length, outputTokens: 1, costUsd: 0.001 },
      }),
    });
    const result = await provider.complete({ ...REQUEST, prompt: "four" });
    expect(result.text).toBe("echo:4");
    expect(result.usage?.inputTokens).toBe(4);
  });

  it("throws the configured failure after recording the request", async () => {
    const failure = new Error("provider exploded");
    const provider = new FakeModelProvider({ failWith: failure });
    await expect(provider.complete(REQUEST)).rejects.toBe(failure);
    expect(provider.requests).toHaveLength(1);
  });

  it("honors a custom id", () => {
    expect(new FakeModelProvider({ id: "other" }).id).toBe("other");
    expect(new FakeModelProvider().id).toBe("fake");
  });
});
