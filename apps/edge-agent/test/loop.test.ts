// Hermetic delivery-loop tests (E4-S): fake fetch + fake transport — no
// network, no DB, no osascript. Pins the wire behavior end to end:
// claim → render → send → delivered (auth headers asserted on every call),
// the empty-queue path, the claim-denied path, and the failure contract
// (send failure → NO delivered report; the row expires via its TTL).

import { describe, expect, it } from "vitest";
import { runOnce, type AgentDeps, type EdgeAgentCredentials } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import {
  FALLBACK_TRUNCATION_LIMIT,
  renderNotificationText,
} from "../src/render.js";

const CONFIG = loadConfig(
  { EDGE_API_URL: "http://api.test", EDGE_POLL_SECONDS: "1" },
  [],
);

const CREDENTIALS: EdgeAgentCredentials = {
  bearer: "test-bearer-credential",
  capabilityToken: "test-capability-token",
  target: "+15551234567",
};

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Harness {
  readonly deps: AgentDeps;
  readonly calls: RecordedCall[];
  readonly sent: { target: string; text: string }[];
  failSend: boolean;
}

function makeHarness(
  claimBody: unknown,
  opts: { deliveredStatus?: number } = {},
): Harness {
  const calls: RecordedCall[] = [];
  const sent: { target: string; text: string }[] = [];
  const harness: Harness = {
    calls,
    sent,
    failSend: false,
    deps: {
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/harness/notifications/claim")) {
          return jsonResponse(claimBody);
        }
        return jsonResponse({ ok: true }, opts.deliveredStatus ?? 200);
      },
      transport: async (target, text) => {
        if (harness.failSend) throw new Error("osascript exited 1");
        sent.push({ target, text });
      },
      resolveCredentials: async () => CREDENTIALS,
    },
  };
  return harness;
}

const NOTIFICATION = {
  id: "b7d4b1a2-0000-4000-8000-000000000001",
  kind: "brief",
  title: "Morning brief",
  payload: { content: "LINE ONE\nLINE TWO" },
  claimedAt: "2026-09-18T07:00:05.000Z",
  expiresAt: "2026-09-18T11:00:00.000Z",
};

describe("edge-agent loop (hermetic)", () => {
  it("claim → send → delivered end to end; auth headers asserted on BOTH calls", async () => {
    const h = makeHarness({ notification: NOTIFICATION });
    const result = await runOnce(h.deps, CONFIG);

    expect(result).toEqual({ claimed: true, delivered: true });
    expect(h.calls.map((c) => c.url)).toEqual([
      "http://api.test/harness/notifications/claim",
      `http://api.test/harness/notifications/${NOTIFICATION.id}/delivered`,
    ]);
    for (const call of h.calls) {
      expect(call.init?.method).toBe("POST");
      const headers = new Headers(call.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${CREDENTIALS.bearer}`);
      expect(headers.get("x-capability-token")).toBe(CREDENTIALS.capabilityToken);
    }
    expect(h.sent).toEqual([
      { target: CREDENTIALS.target, text: "Morning brief\nLINE ONE\nLINE TWO" },
    ]);
  });

  it("empty queue (notification: null) → no transport, no delivered call", async () => {
    const h = makeHarness({ notification: null });
    const result = await runOnce(h.deps, CONFIG);
    expect(result).toEqual({ claimed: false, delivered: false });
    expect(h.calls).toHaveLength(1); // the claim alone
    expect(h.sent).toHaveLength(0);
  });

  it("claim denied (403 + code) → logged to stderr, loop cycle survives, nothing sent", async () => {
    const lines: string[] = [];
    const calls: RecordedCall[] = [];
    const deps: AgentDeps = {
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ error: "forbidden", code: "wrong_capability" }, 403);
      },
      transport: async () => {
        throw new Error("must not be called");
      },
      resolveCredentials: async () => CREDENTIALS,
      log: (m) => lines.push(m),
    };
    const result = await runOnce(deps, CONFIG);
    expect(result).toEqual({ claimed: false, delivered: false });
    expect(calls).toHaveLength(1);
    expect(lines.join("\n")).toContain("wrong_capability");
  });

  it("FAILURE PATH: send fails → stderr log, NO delivered call (row expires via TTL)", async () => {
    const lines: string[] = [];
    const h = makeHarness({ notification: NOTIFICATION });
    h.deps.log = (m) => lines.push(m);
    h.failSend = true;

    const result = await runOnce(h.deps, CONFIG);

    expect(result).toEqual({ claimed: true, delivered: false });
    expect(h.calls).toHaveLength(1); // claim only — delivered NEVER reported
    const logged = lines.join("\n");
    expect(logged).toContain("send FAILED");
    expect(logged).toContain("TTL");
    expect(logged).not.toContain(CREDENTIALS.bearer); // no secrets in logs
  });

  it("credential resolution failure → logged, cycle survives", async () => {
    const lines: string[] = [];
    const deps: AgentDeps = {
      fetchFn: async () => {
        throw new Error("must not be called");
      },
      transport: async () => {
        throw new Error("must not be called");
      },
      resolveCredentials: async () => {
        throw new Error("no Keychain credential");
      },
      log: (m) => lines.push(m),
    };
    const result = await runOnce(deps, CONFIG);
    expect(result).toEqual({ claimed: false, delivered: false });
    expect(lines.join("\n")).toContain("credential resolution failed");
  });

  it("delivered endpoint rejects → reported as not delivered, no throw", async () => {
    const h = makeHarness({ notification: NOTIFICATION }, { deliveredStatus: 409 });
    const result = await runOnce(h.deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: false });
    expect(h.sent).toHaveLength(1); // the send DID happen
  });
});

describe("notification text rendering", () => {
  it("kind brief → title + content; calendar-change → title; escalation → title + consequence", () => {
    expect(
      renderNotificationText({
        id: "n1",
        kind: "brief",
        title: "Morning brief",
        payload: { content: "A\nB" },
      }),
    ).toBe("Morning brief\nA\nB");
    expect(
      renderNotificationText({
        id: "n2",
        kind: "calendar-change",
        title: "Standup: moved to 2026-09-18 09:00 UTC",
        payload: { change: { changeClass: "start_end_changed" } },
      }),
    ).toBe("Standup: moved to 2026-09-18 09:00 UTC");
    expect(
      renderNotificationText({
        id: "n3",
        kind: "escalation",
        title: "Escalation: approval_required (high)",
        payload: { consequenceOfWaiting: "deploy stays blocked" },
      }),
    ).toBe("Escalation: approval_required (high)\ndeploy stays blocked");
    expect(
      renderNotificationText({
        id: "n4",
        kind: "escalation",
        title: "Escalation: no consequence",
        payload: {},
      }),
    ).toBe("Escalation: no consequence");
  });

  it("FallbackTruncation caps every kind at 1500 chars", () => {
    const long = "x".repeat(5000);
    const out = renderNotificationText({
      id: "n5",
      kind: "brief",
      title: "Morning brief",
      payload: { content: long },
    });
    expect(out.length).toBe(FALLBACK_TRUNCATION_LIMIT);
    expect(out.endsWith("…[truncated]")).toBe(true);
    expect(out.slice(0, -"…[truncated]".length)).toBe(
      `Morning brief\n${long.slice(0, FALLBACK_TRUNCATION_LIMIT - "…[truncated]".length - "Morning brief\n".length)}`,
    );
  });

  it("unknown kind falls back to title + payload JSON (inert data)", () => {
    const out = renderNotificationText({
      id: "n6",
      kind: "mystery",
      title: "T",
      payload: { whatever: 1 },
    });
    expect(out).toBe(`T\n${JSON.stringify({ whatever: 1 })}`);
  });
});
