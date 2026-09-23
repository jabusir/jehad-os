// Hermetic GC0 adapter-hardening tests (ADR-0016 §3): MIME charset decoding,
// RFC 2047 header words, attachment METADATA extraction (bytes never
// fetched), HTML sanitization (remote loads removed, safe links preserved
// as label+URL), snippet collapse. Stubbed fetch against realistic Gmail v1
// fixture shapes — same harness as gmail.test.ts.

import { describe, expect, it } from "vitest";
import {
  charsetFromContentType,
  createGmailAdapter,
  decodeMimeHeaderWords,
  htmlToText,
  type GmailFetchLike,
} from "./gmail.js";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const token = (): string => "ya29.gmail-test-token";
const adapter = (fetch: GmailFetchLike) => createGmailAdapter({ tokenProvider: token, fetchImpl: fetch });

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubFetch(handler: (url: string) => Response): GmailFetchLike {
  return (async (url: string) => handler(url)) as GmailFetchLike;
}

function getMessageFixture(payload: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    id: "msg-c1",
    threadId: "thr-c1",
    labelIds: ["INBOX"],
    sizeEstimate: 4096,
    internalDate: "1694956800000",
    payload,
    ...extra,
  };
}

describe("GC0 adapter hardening (ADR-0016)", () => {
  it("decodes RFC 2047 B- and Q-encoded subject header words", () => {
    // "Résumé — Invoice #42" in UTF-8, B-encoding.
    const b = Buffer.from("Résumé — Invoice #42", "utf8").toString("base64");
    expect(decodeMimeHeaderWords(`=?utf-8?B?${b}?=`)).toBe("Résumé — Invoice #42");
    // Q-encoding with underscores and hex escapes.
    expect(decodeMimeHeaderWords("=?utf-8?Q?Quote_=2412=2C000_updates?=")).toBe("Quote $12,000 updates");
    // Mixed encoded + plain words.
    expect(decodeMimeHeaderWords("Re: =?utf-8?Q?hello_=3F?=")).toBe("Re: hello ?");
    expect(decodeMimeHeaderWords("plain subject")).toBe("plain subject");
  });

  it("surfaces a decoded subject on messages.get (encoded-word subject)", async () => {
    const subject = Buffer.from("Résumé — Invoice #42", "utf8").toString("base64");
    const fixture = getMessageFixture({
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Acme <quotes@acme.com>" },
        { name: "Subject", value: `=?utf-8?B?${subject}?=` },
      ],
      body: { data: b64("hello") },
    });
    const { fetch } = { fetch: stubFetch(() => jsonResponse(200, fixture)) };
    const message = await adapter(fetch).getMessage("msg-c1");
    expect(message.subject).toBe("Résumé — Invoice #42");
  });

  it("decodes a latin-1 text/plain part per its declared charset", async () => {
    const latin1 = Buffer.from("café naïve résumé", "latin1");
    const fixture = getMessageFixture({
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "a@b.com" },
        { name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' },
      ],
      body: { data: latin1.toString("base64url") },
    });
    const { fetch } = { fetch: stubFetch(() => jsonResponse(200, fixture)) };
    const message = await adapter(fetch).getMessage("msg-c1");
    expect(message.textPlain).toBe("café naïve résumé");
  });

  it("collects attachment METADATA only — attachmentId present, bytes never fetched", async () => {
    const fixture = getMessageFixture({
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "a@b.com" }],
      parts: [
        { mimeType: "text/plain", body: { data: b64("see attached") } },
        {
          mimeType: "application/pdf",
          filename: "quote.pdf",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="quote.pdf"' }],
          body: { size: 51234, attachmentId: "ANGjdJ_attach1" },
        },
        { mimeType: "text/html", body: { data: b64("<p>see attached</p>") } },
      ],
    });
    let fetchCalls = 0;
    const fetch = stubFetch(() => {
      fetchCalls += 1;
      return jsonResponse(200, fixture);
    });
    const message = await adapter(fetch).getMessage("msg-c1");
    expect(fetchCalls).toBe(1); // messages.get ONLY — no attachment fetch path exists
    expect(message.textPlain).toBe("see attached");
    expect(message.attachments).toEqual([
      { filename: "quote.pdf", mimeType: "application/pdf", size: 51234, attachmentId: "ANGjdJ_attach1" },
    ]);
  });

  it("caps attachment metadata collection at 10 entries", async () => {
    const parts = Array.from({ length: 14 }, (_, i) => ({
      mimeType: "application/octet-stream",
      filename: `f${i}.bin`,
      body: { size: i, attachmentId: `att-${i}` },
    }));
    const fixture = getMessageFixture({
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "a@b.com" }],
      parts,
    });
    const { fetch } = { fetch: stubFetch(() => jsonResponse(200, fixture)) };
    const message = await adapter(fetch).getMessage("msg-c1");
    expect(message.attachments).toHaveLength(10);
  });

  it("collapses and hard-caps the snippet", async () => {
    const fixture = getMessageFixture(
      {
        mimeType: "text/plain",
        headers: [{ name: "From", value: "a@b.com" }],
        body: { data: b64("x") },
      },
      { snippet: "  a\n\n  lot   of   whitespace  ".repeat(40) },
    );
    const { fetch } = { fetch: stubFetch(() => jsonResponse(200, fixture)) };
    const message = await adapter(fetch).getMessage("msg-c1");
    expect(message.snippet).not.toContain("\n");
    expect(message.snippet!.length).toBeLessThanOrEqual(600);
  });

  it("an empty body decodes to null (honest absence, never fabricated text)", async () => {
    const fixture = getMessageFixture({
      mimeType: "text/plain",
      headers: [{ name: "From", value: "a@b.com" }],
      body: { data: "" },
    });
    const { fetch } = { fetch: stubFetch(() => jsonResponse(200, fixture)) };
    const message = await adapter(fetch).getMessage("msg-c1");
    expect(message.textPlain).toBeNull();
  });
});

describe("htmlToText sanitization (ADR-0016 §3)", () => {
  it("preserves safe http(s) links as label + destination metadata", () => {
    expect(
      htmlToText('<p>See <a href="https://acme.com/quote">the quote</a> online.</p>'),
    ).toBe("See the quote (https://acme.com/quote) online.");
  });

  it("degrades non-http(s) hrefs to their label (no scheme smuggling)", () => {
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe("click");
    expect(htmlToText('<a href="data:text/html,evil">click</a>')).toBe("click");
  });

  it("removes remote-content tags entirely (tracking pixels never survive as URLs)", () => {
    const html =
      '<div>hi <img src="https://track.example.com/pixel.gif" width="1" height="1">there</div>' +
      '<video src="https://cdn.example.com/v.mp4"></video>';
    const text = htmlToText(html);
    expect(text).toBe("hi there");
    expect(text).not.toContain("track.example.com");
    expect(text).not.toContain("cdn.example.com");
  });

  it("drops script/style/iframe/object/embed blocks with their content", () => {
    const text = htmlToText(
      "<p>keep</p><script>alert('x')</script><style>.x{}</style>" +
        '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y">',
    );
    expect(text).toBe("keep");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("evil.example");
  });

  it("charsetFromContentType parses quoted/loose charset params", () => {
    expect(charsetFromContentType('text/plain; charset="ISO-8859-1"')).toBe("iso-8859-1");
    expect(charsetFromContentType("text/plain; charset=UTF-8")).toBe("utf-8");
    expect(charsetFromContentType("text/plain")).toBeNull();
    expect(charsetFromContentType(null)).toBeNull();
  });

  it("marks quoted-reply boundaries (blockquote → '> ') so quoted history is distinguishable — not perfectly separated (ADR-0016 §3 honesty)", () => {
    const text = htmlToText(
      "<p>Agreed on the MOQ.</p>" +
        '<blockquote><p>On Mon, Sep 21, 2026 you wrote:</p>' +
        "<p>What price can you offer at 5000 units?</p>" +
        '<blockquote><p>Original order terms…</p></blockquote></blockquote></p>' +
        "<p>Sending the updated sheet today.</p>",
    );
    // Boundary markers exist at each quoting level…
    expect(text.startsWith("Agreed on the MOQ.")).toBe(true);
    expect(text).toContain("\n> On Mon, Sep 21, 2026 you wrote:");
    expect(text).toContain("\n> Original order terms…");
    // …and the authored content outside quotes is intact.
    expect(text).toContain("Sending the updated sheet today.");
    // v1 honesty: quoted lines after the FIRST are NOT per-line-prefixed —
    // the body is one untrusted document with boundary cues, and consumers
    // (verifier) must treat quoted history as untrusted like the rest.
    expect(text).toContain("What price can you offer at 5000 units?");
  });
});
