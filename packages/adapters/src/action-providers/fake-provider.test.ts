import { describe, expect, it } from "vitest";
import { FakeActionProvider } from "./fake-provider.js";
import { ProviderResponseLostError } from "./provider.js";
import type { ProviderDispatchRequest } from "./provider.js";

function request(key = "idem-1"): ProviderDispatchRequest {
  return {
    intentId: "intent-1",
    capability: "act:fake",
    resource: "fake:thing",
    payload: { note: "hello" },
    idempotencyKey: key,
  };
}

describe("FakeActionProvider", () => {
  it("succeeds: returns a provider ref and records the effect", async () => {
    const provider = new FakeActionProvider("succeed");
    const response = await provider.dispatch(request());
    expect(response.status).toBe("succeeded");
    expect(response.providerRef).toMatch(/^fake-fake-\d+$/);
    expect(provider.effects).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
  });

  it("fails: returns a failure with an error and performs no effect", async () => {
    const provider = new FakeActionProvider("fail");
    const response = await provider.dispatch(request());
    expect(response.status).toBe("failed");
    expect(response.error).toContain("fake provider failure");
    expect(provider.effects).toHaveLength(0);
    expect(provider.requests).toHaveLength(1);
  });

  it("timeout-after-dispatch: effect happens, dispatch throws, no response returns", async () => {
    const provider = new FakeActionProvider({ behavior: "timeout-after-dispatch" });
    await expect(provider.dispatch(request())).rejects.toBeInstanceOf(ProviderResponseLostError);
    expect(provider.effects).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
  });

  it("statusForKey reports provider-side truth, including lost responses", async () => {
    const provider = new FakeActionProvider({ behavior: "timeout-after-dispatch" });
    await expect(provider.dispatch(request("idem-lost"))).rejects.toBeInstanceOf(
      ProviderResponseLostError,
    );
    const status = provider.statusForKey("idem-lost");
    expect(status?.status).toBe("succeeded");
    expect(status?.providerRef).toBeDefined();
    expect(provider.statusForKey("never-seen")).toBeNull();
  });

  it("replays an idempotency key without performing a second effect", async () => {
    const provider = new FakeActionProvider("succeed");
    const first = await provider.dispatch(request("idem-dedupe"));
    const second = await provider.dispatch(request("idem-dedupe"));
    expect(second.providerRef).toBe(first.providerRef);
    expect(provider.effects).toHaveLength(1);
    expect(provider.requests).toHaveLength(2);
  });

  it("retry after a lost response returns the original outcome under the same key", async () => {
    const provider = new FakeActionProvider({ behavior: "timeout-after-dispatch" });
    await expect(provider.dispatch(request("idem-retry"))).rejects.toBeInstanceOf(
      ProviderResponseLostError,
    );
    provider.behavior = "succeed";
    const retried = await provider.dispatch(request("idem-retry"));
    expect(retried.status).toBe("succeeded");
    expect(provider.effects).toHaveLength(1);
  });

  it("carries a configurable id", () => {
    expect(new FakeActionProvider().id).toBe("fake");
    expect(new FakeActionProvider({ id: "bank" }).id).toBe("bank");
  });
});
