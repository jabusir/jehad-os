// Hermetic gmail adapter tests (Lane G1): stubbed fetch against
// recorded-realistic Gmail v1 fixtures (history.list, messages.list,
// messages.get, profile), plus the READ-ONLY proof — every issued call is a
// GET on a Gmail v1 read path with the bearer token from the tokenProvider.
// The adapter NEVER retries: error tests also pin call counts. The Keychain
// path of the token provider runs against a mocked execFile (no host state).

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  createGmailAdapter,
  gmailEnvOrKeychainTokenProvider,
  GMAIL_SOURCE,
  GmailApiError,
  htmlToText,
  isHistoryExpired,
  type GmailFetchLike,
} from "./gmail.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const BASE = "https://www.googleapis.com/gmail/v1/users/me";
const READ_PATH = /^\/gmail\/v1\/users\/me\/(history|messages(\/[^/]+)?|profile)$/;

// Recorded-realistic Gmail v1 resources (shapes as returned by the API;
// int64 ids arrive as strings, part bodies as URL-safe base64).
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

const HISTORY_PAGE_1 = {
  history: [
    {
      id: "6000",
      messagesAdded: [{ message: { id: "msg-1", threadId: "thr-1" } }],
    },
    {
      id: "6001",
      messages: [{ id: "msg-2", threadId: "thr-2" }, { id: "msg-1", threadId: "thr-1" }],
    },
    { id: "junk-record" },
  ],
  historyId: "6002",
  nextPageToken: "history-page-2",
};

const HISTORY_PAGE_2 = {
  history: [{ id: "6002", messagesAdded: [{ message: { id: "msg-3", threadId: "thr-3" } }] }],
  historyId: "6003",
};

const LIST_PAGE_1 = {
  messages: [{ id: "msg-1", threadId: "thr-1" }, { id: "msg-2", threadId: "thr-2" }, "junk"],
  historyId: "7001",
  nextPageToken: "list-page-2",
};

const LIST_PAGE_2 = {
  messages: [{ id: "msg-3", threadId: "thr-3" }],
  historyId: "7001",
};

const MESSAGE_FULL = {
  id: "msg-1",
  threadId: "thr-1",
  labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
  sizeEstimate: 10234,
  internalDate: "1694956800000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Stripe <billing@stripe.com>" },
      { name: "Subject", value: "Your invoice is ready" },
      { name: "Date", value: "Sun, 20 Sep 2026 08:00:00 +0000" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64("Invoice body: pay $120 by Oct 1") } },
      { mimeType: "text/html", body: { data: b64("<p>Invoice body</p>") } },
    ],
  },
};

const MESSAGE_HTML_ONLY = {
  id: "msg-2",
  threadId: "thr-2",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/related",
    headers: [
      { name: "From", value: "notifications@github.com" },
      { name: "Subject", value: "[repo] PR merged" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: b64("<p>PR <b>#42</b> merged</p><script>steal()</script>") } },
        ],
      },
    ],
  },
};

const MESSAGE_NESTED_PLAIN = {
  id: "msg-3",
  threadId: "thr-3",
  payload: {
    mimeType: "multipart/mixed",
    headers: [{ name: "From", value: "Bank <statements@bank.example.com>" }],
    parts: [
      { mimeType: "application/pdf", filename: "stmt.pdf", body: { attachmentId: "att-1" } },
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
          { mimeType: "text/plain", body: { data: b64("deep plain part") } },
        ],
      },
    ],
  },
};

const MESSAGE_SIMPLE = {
  id: "msg-4",
  payload: {
    mimeType: "text/plain",
    headers: [{ name: "From", value: "plain@example.org" }],
    body: { data: b64("non-multipart body") },
  },
};

interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(
  handler: (url: string) => Response | Promise<Response>,
): { fetch: GmailFetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({
      method: init?.method ?? "(default)",
      url,
      authorization: init?.headers?.["Authorization"],
    });
    return handler(url);
  }) as GmailFetchLike;
  return { fetch, calls };
}

const token = (): string => "ya29.gmail-test-token";

const adapter = (fetch: GmailFetchLike) => createGmailAdapter({ tokenProvider: token, fetchImpl: fetch });

describe("createGmailAdapter", () => {
  it("historyList: parses messageAdded records (deduped), returns nextHistoryId + nextPageToken, hits the cursor params", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, HISTORY_PAGE_1));
    const result = await adapter(fetch).historyList(5999);

    expect(result.records).toEqual([
      { historyId: 6000, messages: [{ id: "msg-1", threadId: "thr-1" }] },
      {
        historyId: 6001,
        messages: [
          { id: "msg-2", threadId: "thr-2" },
          { id: "msg-1", threadId: "thr-1" },
        ],
      },
    ]);
    expect(result.nextHistoryId).toBe(6002);
    expect(result.nextPageToken).toBe("history-page-2");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/gmail/v1/users/me/history");
    expect(url.searchParams.get("historyTypes")).toBe("messageAdded");
    expect(url.searchParams.get("startHistoryId")).toBe("5999");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.authorization).toBe("Bearer ya29.gmail-test-token");
  });

  it("historyList: pages via pageToken (startHistoryId preserved), empty tail page", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.includes("pageToken=history-page-2")
        ? jsonResponse(200, HISTORY_PAGE_2)
        : jsonResponse(200, HISTORY_PAGE_1),
    );
    const gmail = adapter(fetch);
    const first = await gmail.historyList(5999);
    expect(first.nextPageToken).toBe("history-page-2");

    const second = await gmail.historyList(5999, { pageToken: first.nextPageToken! });
    expect(second.records).toEqual([{ historyId: 6002, messages: [{ id: "msg-3", threadId: "thr-3" }] }]);
    expect(second.nextHistoryId).toBe(6003);
    expect(second.nextPageToken).toBeNull();
    const pageUrl = new URL(calls[1]!.url);
    expect(pageUrl.searchParams.get("pageToken")).toBe("history-page-2");
    expect(pageUrl.searchParams.get("startHistoryId")).toBe("5999");
  });

  it("historyList: null cursor omits startHistoryId", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, { history: [], historyId: "6002" }));
    const result = await adapter(fetch).historyList(null);
    expect(result.records).toEqual([]);
    expect(result.nextHistoryId).toBe(6002);
    expect(new URL(calls[0]!.url).searchParams.has("startHistoryId")).toBe(false);
  });

  it("historyList: skips malformed records and message entries instead of failing the page", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(200, {
        history: [
          "junk",
          { id: 6005, messagesAdded: [{ message: { id: "msg-9" } }, { message: "junk" }, "junk"] },
          { id: "6006", messages: [{ id: "msg-a", threadId: "thr-a" }, { nope: true }] },
        ],
        historyId: "6007",
      }),
    );
    const result = await adapter(fetch).historyList(1);
    expect(result.records).toEqual([
      { historyId: 6005, messages: [] },
      { historyId: 6006, messages: [{ id: "msg-a", threadId: "thr-a" }] },
    ]);
    expect(result.nextHistoryId).toBe(6007);
  });

  it("historyList 404 → GmailApiError{status:404, code:'historyIdNotFound'} and isHistoryExpired → re-sync signal", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(404, { error: { code: 404, message: "Invalid history request", errors: [{ reason: "notFound" }] } }),
    );
    const err = await adapter(fetch).historyList(1).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err).toMatchObject({ name: "GmailApiError", status: 404, code: "historyIdNotFound" } satisfies Partial<GmailApiError>);
    expect(isHistoryExpired(err)).toBe(true);
  });

  it("historyList rejects a malformed startHistoryId up front", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, {}));
    await expect(adapter(fetch).historyList(-1)).rejects.toThrow(TypeError);
    await expect(adapter(fetch).historyList(1.5)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("bootstrapList: q=newer_than:{N}d, messageIds, newestHistoryId from list historyId, paged", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.includes("pageToken=list-page-2") ? jsonResponse(200, LIST_PAGE_2) : jsonResponse(200, LIST_PAGE_1),
    );
    const gmail = adapter(fetch);
    const first = await gmail.bootstrapList(30);
    expect(first.messageIds).toEqual([
      { id: "msg-1", threadId: "thr-1" },
      { id: "msg-2", threadId: "thr-2" },
    ]);
    expect(first.newestHistoryId).toBe(7001);
    expect(first.nextPageToken).toBe("list-page-2");
    expect(new URL(calls[0]!.url).searchParams.get("q")).toBe("newer_than:30d");

    const second = await gmail.bootstrapList(30, { pageToken: first.nextPageToken! });
    expect(second.messageIds).toEqual([{ id: "msg-3", threadId: "thr-3" }]);
    expect(second.newestHistoryId).toBe(7001);
    expect(second.nextPageToken).toBeNull();
    expect(new URL(calls[1]!.url).searchParams.get("pageToken")).toBe("list-page-2");
  });

  it("bootstrapList rejects non-positive / fractional windows", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, {}));
    await expect(adapter(fetch).bootstrapList(0)).rejects.toThrow(TypeError);
    await expect(adapter(fetch).bootstrapList(2.5)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("getMessage: normalizes a full multipart/alternative message (from, domain, subject, labelIds passthrough, internalDate ms, text/plain)", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, MESSAGE_FULL));
    const message = await adapter(fetch).getMessage("msg-1");
    expect(message).toEqual({
      id: "msg-1",
      threadId: "thr-1",
      labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
      from: "billing@stripe.com",
      fromDomain: "stripe.com",
      subject: "Your invoice is ready",
      internalDate: 1694956800000,
      textPlain: "Invoice body: pay $120 by Oct 1",
      sizeEstimate: 10234,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/gmail/v1/users/me/messages/msg-1");
    expect(url.searchParams.get("format")).toBe("full");
  });

  it("getMessage: html-only body goes through htmlToText (script stripped)", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, MESSAGE_HTML_ONLY));
    const message = await adapter(fetch).getMessage("msg-2");
    expect(message.from).toBe("notifications@github.com");
    expect(message.fromDomain).toBe("github.com");
    expect(message.textPlain).toBe("PR #42 merged");
  });

  it("getMessage: finds text/plain nested deep in multipart/mixed (before html siblings' fallback)", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, MESSAGE_NESTED_PLAIN));
    const message = await adapter(fetch).getMessage("msg-3");
    expect(message.textPlain).toBe("deep plain part");
    expect(message.fromDomain).toBe("bank.example.com");
  });

  it("getMessage: non-multipart text/plain body decoded from the payload root", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, MESSAGE_SIMPLE));
    const message = await adapter(fetch).getMessage("msg-4");
    expect(message.textPlain).toBe("non-multipart body");
    expect(message.labelIds).toEqual([]);
    expect(message.subject).toBeNull();
  });

  it("getMessage: malformed fields degrade to nulls, junk labelIds filtered — never a raw throw", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(200, {
        id: "msg-x",
        labelIds: ["INBOX", 42, null],
        internalDate: "not-a-number",
        payload: { mimeType: "text/plain", headers: [{ name: "From", value: "No Address" }], body: {} },
      }),
    );
    const message = await adapter(fetch).getMessage("msg-x");
    expect(message).toEqual({
      id: "msg-x",
      threadId: null,
      labelIds: ["INBOX"],
      from: null,
      fromDomain: null,
      subject: null,
      internalDate: null,
      textPlain: null,
      sizeEstimate: null,
    });
  });

  it("getMessage 404 (deleted/absent message): typed error, NOT history expiry", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(404, {
        error: { code: 404, message: "Requested entity was not found.", errors: [{ reason: "notFound" }] },
      }),
    );
    const err = await adapter(fetch).getMessage("msg-gone").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: "GmailApiError", status: 404, code: "notFound" } satisfies Partial<GmailApiError>);
    expect(isHistoryExpired(err)).toBe(false);
  });

  it("getMessage rejects an empty id before any fetch", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, {}));
    await expect(adapter(fetch).getMessage("  ")).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("getMessage with a missing id in the response degrades to a typed invalidResponse error", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, { threadId: "thr-1" }));
    await expect(adapter(fetch).getMessage("msg-1")).rejects.toMatchObject({
      name: "GmailApiError",
      status: 200,
      code: "invalidResponse",
    } satisfies Partial<GmailApiError>);
  });

  it("profileHistoryId: returns the profile historyId (cursor sanity)", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse(200, { emailAddress: "jejo@example.com", historyId: "7002", messagesTotal: 1000 }),
    );
    const result = await adapter(fetch).profileHistoryId();
    expect(result).toEqual({ historyId: 7002 });
    expect(new URL(calls[0]!.url).pathname).toBe("/gmail/v1/users/me/profile");
  });

  it("profile without historyId degrades to a typed invalidResponse error", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, { emailAddress: "jejo@example.com" }));
    await expect(adapter(fetch).profileHistoryId()).rejects.toMatchObject({
      name: "GmailApiError",
      code: "invalidResponse",
    } satisfies Partial<GmailApiError>);
  });

  it("429/401 pass through as typed errors with NO retry (single call)", async () => {
    for (const status of [429, 401]) {
      const { fetch, calls } = stubFetch(() =>
        jsonResponse(status, {
          error: { code: status, message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }] },
        }),
      );
      const err = await adapter(fetch).historyList(1).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ name: "GmailApiError", status, code: "rateLimitExceeded" } satisfies Partial<GmailApiError>);
      expect(isHistoryExpired(err)).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("non-JSON 200 body degrades to a typed invalidJson error, never a raw SyntaxError", async () => {
    const { fetch } = stubFetch(() => new Response("not json{", { status: 200 }));
    const err = await adapter(fetch).historyList(1).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err).toMatchObject({ status: 200, code: "invalidJson" } satisfies Partial<GmailApiError>);
  });

  it("rejects an empty token from the provider", async () => {
    const { fetch } = stubFetch(() => jsonResponse(200, {}));
    const gmail = createGmailAdapter({ tokenProvider: () => "  ", fetchImpl: fetch });
    await expect(gmail.profileHistoryId()).rejects.toThrow(/empty token/);
    expect(gmail.id).toBe(GMAIL_SOURCE);
  });

  it("READ-ONLY: every call across history+bootstrap+get+profile flows is a GET on a Gmail v1 read path", async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.includes("/history") && url.includes("pageToken=")) return jsonResponse(200, HISTORY_PAGE_2);
      if (url.includes("/history")) return jsonResponse(200, HISTORY_PAGE_1);
      if (url.includes("/messages/msg-")) return jsonResponse(200, MESSAGE_FULL);
      if (url.includes("/messages")) return jsonResponse(200, LIST_PAGE_1);
      return jsonResponse(200, { historyId: "7002" });
    });
    const gmail = adapter(fetch);
    await gmail.historyList(5999);
    await gmail.historyList(5999, { pageToken: "history-page-2" });
    await gmail.bootstrapList(30);
    await gmail.getMessage("msg-1");
    await gmail.profileHistoryId();

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.url.startsWith(`${BASE}/`)).toBe(true);
      expect(READ_PATH.test(new URL(call.url).pathname)).toBe(true);
    }
  });
});

describe("htmlToText", () => {
  it("strips nested inline tags, keeps the words", () => {
    expect(htmlToText("<div><p>Hello <b>Wo<i>rl</i>d</b></p></div>")).toBe("Hello World");
  });

  it("decodes the common entities", () => {
    expect(htmlToText("&lt;tag&gt; &amp; &quot;q&quot; &#39;s&#39; end&nbsp;of")).toBe(`<tag> & "q" 's' end of`);
  });

  it("decodes &amp; LAST so double-escaped entities stay single-escaped", () => {
    expect(htmlToText("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  });

  it("drops script and style blocks including their bodies", () => {
    expect(htmlToText('<style>p{color:red}</style><script>alert("x")</script><p>ok</p>')).toBe("ok");
  });

  it("turns <br> variants into newlines", () => {
    expect(htmlToText("line1<br>line2<br/>line3<br />line4")).toBe("line1\nline2\nline3\nline4");
  });

  it("block closes (</p>, </div>) become newlines and >2 blank lines collapse to one", () => {
    expect(htmlToText("<p>a</p><p>b</p><div>c</div><div>d</div>")).toBe("a\nb\nc\nd");
    expect(htmlToText("top<br><br><br><br>bottom")).toBe("top\n\nbottom");
  });

  it("trims outer whitespace and normalizes CRLF", () => {
    expect(htmlToText("  \r\n<p>x</p>\r\n  ")).toBe("x");
  });
});

describe("gmailEnvOrKeychainTokenProvider", () => {
  const ENV_KEY = "GMAIL_ACCESS_TOKEN";
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    execFileMock.mockReset();
  });
  afterEach(() => {
    if (prevEnv !== undefined) process.env[ENV_KEY] = prevEnv;
    else delete process.env[ENV_KEY];
    execFileMock.mockReset();
  });

  it("GMAIL_ACCESS_TOKEN env wins and the Keychain is never probed (dev override)", async () => {
    process.env[ENV_KEY] = "env-gmail-token-1";
    try {
      await expect(gmailEnvOrKeychainTokenProvider()).resolves.toBe("env-gmail-token-1");
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      delete process.env[ENV_KEY];
    }
  });

  it("falls back to the `jehad-gmail` Keychain item via security find-generic-password", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null, out?: { stdout: string }) => void) =>
        cb(null, { stdout: "keychain-gmail-token\n" }),
    );
    await expect(gmailEnvOrKeychainTokenProvider()).resolves.toBe("keychain-gmail-token");
    expect(execFileMock).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "jehad-gmail", "-w"],
      expect.any(Function),
    );
  });

  it("honors an explicit (per-surface) keychain service name", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null, out?: { stdout: string }) => void) =>
        cb(null, { stdout: "other-token" }),
    );
    await expect(gmailEnvOrKeychainTokenProvider("jehad-gmail-test")).resolves.toBe("other-token");
    expect(execFileMock).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "jehad-gmail-test", "-w"],
      expect.any(Function),
    );
  });

  it("missing env + missing Keychain item → bootstrap-pointer error naming the service", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) =>
        cb(new Error("The specified item could not be found in the keychain.")),
    );
    await expect(gmailEnvOrKeychainTokenProvider("jehad-gmail-absent")).rejects.toThrow(
      /jehad-gmail-absent/,
    );
  });

  it("empty Keychain value is treated as missing", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null, out?: { stdout: string }) => void) =>
        cb(null, { stdout: "  \n" }),
    );
    await expect(gmailEnvOrKeychainTokenProvider()).rejects.toThrow(/no access token/);
  });
});
