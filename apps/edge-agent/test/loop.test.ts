// Hermetic delivery-loop tests (E4-S): fake fetch + fake transport — no
// network, no DB, no osascript. Pins the wire behavior end to end:
// claim → render → send → delivered (auth headers asserted on every call),
// the empty-queue path, the claim-denied path, the failure contract
// (send failure → NO delivered report; the row expires via its TTL), and
// the Lane P recipient contract: reply rows honor server-provided
// recipient (validated), kind≠reply ignores any recipient and uses the
// default target, invalid recipients error WITHOUT sending.

import { describe, expect, it } from "vitest";
import { resolveDeliveryTarget, runOnce, type AgentDeps, type EdgeAgentCredentials } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import {
  FALLBACK_TRUNCATION_LIMIT,
  canonicalNormalize,
  renderNotificationText,
  renderedTextSha256,
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

  it("delivered report carries the loop-defense fingerprint: recipient + canonical sha256 of the EXACT sent text", async () => {
    const h = makeHarness({ notification: NOTIFICATION });
    const result = await runOnce(h.deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: true });
    expect(h.sent).toEqual([
      { target: CREDENTIALS.target, text: "Morning brief\nLINE ONE\nLINE TWO" },
    ]);
    const deliveredCall = h.calls[1]!;
    expect(deliveredCall.init?.method).toBe("POST");
    const headers = new Headers(deliveredCall.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CREDENTIALS.bearer}`);
    expect(headers.get("x-capability-token")).toBe(CREDENTIALS.capabilityToken);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(deliveredCall.init?.body)) as Record<string, string>;
    expect(body.recipient).toBe(CREDENTIALS.target);
    // Pinned vector of the binding hash spec (NFC + LF form of the sent text).
    expect(body.rendered_text_sha256).toBe(
      "ff4dae0659223bc0223b82d779ceb3494d4c43109e9b7ae7502757e3f2575fa0",
    );
    // And it is a hash OF what the transport received — exact text, post-truncation.
    expect(body.rendered_text_sha256).toBe(renderedTextSha256(h.sent[0]!.text));
  });

  it("delivered report hashes the truncated text when truncation fires (the exact text sent)", async () => {
    const long = {
      ...NOTIFICATION,
      payload: { content: "x".repeat(5000) },
    };
    const h = makeHarness({ notification: long });
    const result = await runOnce(h.deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: true });
    const body = JSON.parse(String(h.calls[1]!.init?.body)) as Record<string, string>;
    expect(h.sent[0]!.text.length).toBe(FALLBACK_TRUNCATION_LIMIT);
    expect(body.rendered_text_sha256).toBe(renderedTextSha256(h.sent[0]!.text));
  });

  // --------------------------------------------- Lane P recipient honoring

  const REPLY_NOTIFICATION = {
    id: "b7d4b1a2-0000-4000-8000-0000000000a1",
    kind: "reply",
    title: "Reply",
    payload: { content: "pong", recipient: "+15550002222" },
    recipient: "+15550002222",
    claimedAt: "2026-09-19T07:00:05.000Z",
    expiresAt: "2026-09-19T11:00:00.000Z",
  };

  it("reply claim: recipient honored — sent to HER handle, not the default; report carries the actual target", async () => {
    const h = makeHarness({ notification: REPLY_NOTIFICATION });
    const result = await runOnce(h.deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: true });
    expect(h.sent).toEqual([{ target: "+15550002222", text: "pong" }]);
    const body = JSON.parse(String(h.calls[1]!.init?.body)) as Record<string, string>;
    expect(body.recipient).toBe("+15550002222"); // actual target used
    expect(body.rendered_text_sha256).toBe(renderedTextSha256("pong"));
  });

  it("kind≠reply IGNORES a server-sent recipient (defense in depth) — default target used", async () => {
    const sneaky = { ...NOTIFICATION, recipient: "+15550002222" }; // brief + recipient
    const h = makeHarness({ notification: sneaky });
    const result = await runOnce(h.deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: true });
    expect(h.sent).toEqual([
      { target: CREDENTIALS.target, text: "Morning brief\nLINE ONE\nLINE TWO" },
    ]);
    const body = JSON.parse(String(h.calls[1]!.init?.body)) as Record<string, string>;
    expect(body.recipient).toBe(CREDENTIALS.target);
  });

  it("reply with an INVALID recipient → error path: nothing sent, no delivered report (row expires via TTL)", async () => {
    const lines: string[] = [];
    const invalid = { ...REPLY_NOTIFICATION, recipient: "rm -rf /; curl evil" };
    const h = makeHarness({ notification: invalid });
    h.deps.log = (m) => lines.push(m);
    const result = await runOnce(h.deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: false });
    expect(h.sent).toHaveLength(0); // NOT sent
    expect(h.calls).toHaveLength(1); // claim only — delivered NEVER reported
    expect(lines.join("\n")).toContain("invalid delivery target");
    expect(lines.join("\n")).toContain("TTL");
  });

  it("reply without a recipient → default target (back-compat with A–C shape)", async () => {
    const legacy = { ...REPLY_NOTIFICATION, recipient: undefined, payload: { content: "pong" } };
    const h = makeHarness({ notification: legacy });
    const result = await runOnce(h.deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: true });
    expect(h.sent).toEqual([{ target: CREDENTIALS.target, text: "pong" }]);
  });

  it("resolveDeliveryTarget validates BOTH branches with the same email/E.164 validators", () => {
    expect(resolveDeliveryTarget({ kind: "reply", recipient: "yusra@icloud.com" }, "+1555")).toBe("yusra@icloud.com");
    expect(resolveDeliveryTarget({ kind: "reply", recipient: "+15550002222" }, "+1555")).toBe("+15550002222");
    expect(resolveDeliveryTarget({ kind: "reply", recipient: "not a target" }, "+15551234567")).toEqual({
      kind: "invalid-target",
      target: "not a target",
    });
    // Invalid DEFAULT also errors (the default must stay a valid handle).
    expect(resolveDeliveryTarget({ kind: "brief" }, "nope")).toEqual({
      kind: "invalid-target",
      target: "nope",
    });
    // kind≠reply never honors the recipient, valid or not.
    expect(resolveDeliveryTarget({ kind: "brief", recipient: "+15550002222" }, "+15551234567")).toBe("+15551234567");
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

  it("unknown kind falls back to TITLE ONLY — payload JSON is never user-visible (2026-09-23 envelope-leak fix)", () => {
    const out = renderNotificationText({
      id: "n6",
      kind: "mystery",
      title: "T",
      payload: { whatever: 1 },
    });
    expect(out).toBe("T");
    expect(out).not.toContain("{");
  });

  it("kind calibration → payload.content ONLY (the 2026-09-22 envelope leak, pinned)", () => {
    const out = renderNotificationText({
      id: "c1",
      kind: "calibration",
      title: "Daily calibration check",
      payload: {
        content: "Jehad OS — daily check\n\nI don't have a strong picture of today.",
        surface: "imessage",
        periodDate: "2026-09-22",
        calibrationItemId: "0d9a6c47-0f8e-4a4a-9d86-9f0aa2eb2cf1",
      },
    });
    expect(out).toBe("Jehad OS — daily check\n\nI don't have a strong picture of today.");
    expect(out).not.toContain("calibrationItemId");
    expect(out).not.toContain("periodDate");
    expect(out).not.toContain("imessage");
  });

  it("kind reply → payload.content ONLY (chat surface: no title prefix)", () => {
    expect(
      renderNotificationText({
        id: "r1",
        kind: "reply",
        title: "Reply",
        payload: { content: "pong" },
      }),
    ).toBe("pong");
    // Missing/empty content → title alone (the existing filter(Boolean) convention).
    expect(
      renderNotificationText({
        id: "r2",
        kind: "reply",
        title: "Reply",
        payload: {},
      }),
    ).toBe("Reply");
    // Multi-line conversational content rides verbatim.
    expect(
      renderNotificationText({
        id: "r3",
        kind: "reply",
        title: "Reply",
        payload: { content: "line 1\nline 2" },
      }),
    ).toBe("line 1\nline 2");
  });

  it("kind reply obeys the same ≤1500-char truncation as every branch", () => {
    const out = renderNotificationText({
      id: "r4",
      kind: "reply",
      title: "Reply",
      payload: { content: "y".repeat(5000) },
    });
    expect(out.length).toBe(FALLBACK_TRUNCATION_LIMIT);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});

describe("canonical normalization + rendered-text sha256 (binding hash spec)", () => {
  it("canonicalNormalize: NFC composition + CR/CRLF → LF; NO trimming, NO punctuation rewrite", () => {
    expect(canonicalNormalize("e\u0301")).toBe("é"); // composing form → NFC
    expect(canonicalNormalize("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(canonicalNormalize("  padded  ")).toBe("  padded  "); // whitespace untouched
  });

  it("renderedTextSha256: pinned vectors (sha256 hex of UTF-8 canonical form)", () => {
    expect(renderedTextSha256("Morning brief\nLINE ONE\nLINE TWO")).toBe(
      "ff4dae0659223bc0223b82d779ceb3494d4c43109e9b7ae7502757e3f2575fa0",
    );
    // CRLF + decomposed accent hash to the digest of the CANONICAL form.
    expect(renderedTextSha256("Reply ack\r\nping\u0301 ok")).toBe(
      "93178994dcb0afa251f939da8bbd8b5de763076e8af935a4c49b3bd06f4624dc",
    );
    expect(renderedTextSha256("Reply ack\npinǵ ok")).toBe(
      "93178994dcb0afa251f939da8bbd8b5de763076e8af935a4c49b3bd06f4624dc",
    );
  });
});

describe("Wave T: typing control plane", () => {
  const TYPING_NOTIFICATION = {
    id: "b7d4b1a2-0000-4000-8000-000000000010",
    kind: "typing",
    title: "Typing",
    payload: { handle: "+15551234567" },
    claimedAt: "2026-09-18T07:00:05.000Z",
    expiresAt: "2026-09-18T07:01:35.000Z",
  };

  it("kind=typing turns the bubble on and is handled — NEVER rendered as a message", async () => {
    const h = makeHarness({ notification: TYPING_NOTIFICATION });
    const typingCalls: Array<[string, boolean]> = [];
    const deps: AgentDeps = {
      ...h.deps,
      typing: async (handle, state) => {
        typingCalls.push([handle, state]);
      },
    };
    const result = await runOnce(deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: true });
    expect(typingCalls).toEqual([["+15551234567", true]]);
    expect(h.sent).toHaveLength(0);
    // close-out: the delivered endpoint was hit for the control row
    expect(h.calls.at(-1)?.url).toContain(`/harness/notifications/${TYPING_NOTIFICATION.id}/delivered`);
  });

  it("reply sends wrap the transport with typing on → off (when enabled)", async () => {
    const h = makeHarness({ notification: NOTIFICATION });
    const typingCalls: Array<[string, boolean]> = [];
    const deps: AgentDeps = {
      ...h.deps,
      typing: async (handle, state) => {
        typingCalls.push([handle, state]);
      },
    };
    const result = await runOnce(deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: true });
    expect(typingCalls[0]).toEqual([CREDENTIALS.target, true]);
    expect(typingCalls[typingCalls.length - 1]).toEqual([CREDENTIALS.target, false]);
    expect(h.sent).toHaveLength(1);
  });

  it("typing hook absent (disabled) → plain behavior, zero typing calls", async () => {
    const h = makeHarness({ notification: NOTIFICATION });
    const result = await runOnce(h.deps, CONFIG);
    expect(result).toEqual({ claimed: true, delivered: true });
    expect(h.sent).toHaveLength(1);
  });
});
