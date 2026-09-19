// poll.ts tests — classification, canonical hash (pinned vectors, the
// SAME contract as apps/edge-agent/test/loop.test.ts), drift counters,
// privacy (content never on the wire).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openChatDb } from "../src/db.js";
import { canonicalNormalize, canonicalTextSha256, classifyRow, pollOnce } from "../src/poll.js";
import type { ChatMessageRow } from "../src/db.js";
import { bodyFor, createFixtureChatDb, fixtureDir, malformedBody } from "./fixture-db.js";

const root = mkdtempSync(join(tmpdir(), "imessage-sensor-poll-test-"));
afterAll(() => {});

const PINNED_MORNING = "ff4dae0659223bc0223b82d779ceb3494d4c43109e9b7ae7502757e3f2575fa0";
const PINNED_REPLY_ACK = "93178994dcb0afa251f939da8bbd8b5de763076e8af935a4c49b3bd06f4624dc";

function row(overrides: Partial<ChatMessageRow> & Pick<ChatMessageRow, "rowid">): ChatMessageRow {
  return {
    guid: `guid-${overrides.rowid}`,
    isFromMe: false,
    text: null,
    attributedBody: null,
    service: "iMessage",
    handleId: "+15550000001",
    handleService: "iMessage",
    ...overrides,
  };
}

describe("canonical hash (binding contract, pinned vectors)", () => {
  it("canonicalNormalize: NFC + CR/CRLF → LF; NO trimming, NO punctuation rewrite", () => {
    expect(canonicalNormalize("e\u0301")).toBe("é");
    expect(canonicalNormalize("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(canonicalNormalize("  padded  ")).toBe("  padded  ");
  });

  it("canonicalTextSha256: pinned vectors shared with the edge agent", () => {
    expect(canonicalTextSha256("Morning brief\nLINE ONE\nLINE TWO")).toBe(PINNED_MORNING);
    expect(canonicalTextSha256("Morning brief\r\nLINE ONE\r\nLINE TWO")).toBe(PINNED_MORNING);
    expect(canonicalTextSha256("Reply ack\r\nping\u0301 ok")).toBe(PINNED_REPLY_ACK);
    expect(canonicalTextSha256("Reply ack\npinǵ ok")).toBe(PINNED_REPLY_ACK);
  });
});

describe("classifyRow", () => {
  const observedAt = "2026-09-18T12:00:00.000Z";

  it("text row, third party → status ok, NO hash (privacy rule)", () => {
    const result = classifyRow(row({ rowid: 1, isFromMe: false, text: "SECRET-THIRD-PARTY" }), observedAt);
    expect(result.event).toMatchObject({
      guid: "guid-1",
      rowid: 1,
      is_from_me: false,
      transport_handle: "+15550000001",
      service: "iMessage",
      has_text: true,
      has_attributed_body: false,
      decoded_status: "ok",
      text_length: 18,
      observed_at: observedAt,
    });
    expect(result.event.normalized_text_sha256).toBeUndefined();
    expect(result.decodeAttempted).toBe(false);
  });

  it("attributedBody-only own row → decoded, own-ok, canonical hash of the DECODED text", () => {
    const result = classifyRow(
      row({
        rowid: 2,
        isFromMe: true,
        text: null,
        attributedBody: bodyFor("Morning brief\r\nLINE ONE\r\nLINE TWO"),
      }),
      observedAt,
    );
    expect(result.event.decoded_status).toBe("own-ok");
    expect(result.event.has_text).toBe(false);
    expect(result.event.has_attributed_body).toBe(true);
    expect(result.event.normalized_text_sha256).toBe(PINNED_MORNING);
    expect(result.decodeAttempted).toBe(true);
    expect(result.decodeFailed).toBe(false);
  });

  it("malformed blob → skipped-malformed, no content fields, still a wire row", () => {
    const result = classifyRow(
      row({ rowid: 3, isFromMe: true, text: null, attributedBody: malformedBody() }),
      observedAt,
    );
    expect(result.event.decoded_status).toBe("skipped-malformed");
    expect(result.event.text_length).toBeNull();
    expect(result.event.normalized_text_sha256).toBeUndefined();
    expect(result.decodeFailed).toBe(true);
  });

  it("unknown archive encoding (bplist) → skipped-unknown", () => {
    const bplist = Uint8Array.from([
      0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, ...new Array(8).fill(0),
    ]);
    const result = classifyRow(row({ rowid: 4, text: null, attributedBody: bplist }), observedAt);
    expect(result.event.decoded_status).toBe("skipped-unknown");
  });

  it("neither text nor body → not-attempted with null length", () => {
    const result = classifyRow(row({ rowid: 5 }), observedAt);
    expect(result.event.decoded_status).toBe("not-attempted");
    expect(result.event.text_length).toBeNull();
  });

  it("missing handle join → transport_handle falls back to 'unknown'", () => {
    const result = classifyRow(
      row({ rowid: 6, text: "x", handleId: null, handleService: null }),
      observedAt,
    );
    expect(result.event.transport_handle).toBe("unknown");
  });

  it("text_length is UTF-8 byte length", () => {
    const result = classifyRow(row({ rowid: 7, text: "héllo" }), observedAt);
    expect(result.event.text_length).toBe(6);
  });
});

describe("pollOnce", () => {
  it("returns only rows above the cursor; computes the proposed cursor", () => {
    const path = createFixtureChatDb(join(fixtureDir(root, "a"), "chat.db"), {
      messages: [
        { rowid: 1, guid: "g1", isFromMe: 0, text: "one" },
        { rowid: 2, guid: "g2", isFromMe: 0, text: "two" },
        { rowid: 3, guid: "g3", isFromMe: 1, text: "three" },
      ],
    });
    const chat = openChatDb(path);
    try {
      const poll = pollOnce(chat, 1, 100);
      expect(poll.events.map((e) => e.rowid)).toEqual([2, 3]);
      expect(poll.cursorRowid).toBe(3);
      expect(poll.maxRowid).toBe(3);
      expect(poll.truncated).toBe(false);
      const again = pollOnce(chat, 3, 100);
      expect(again.events).toEqual([]);
      expect(again.cursorRowid).toBe(3);
    } finally {
      chat.close();
    }
  });

  it("caps the batch and flags truncation", () => {
    const path = createFixtureChatDb(join(fixtureDir(root, "b"), "chat.db"), {
      messages: [1, 2, 3, 4, 5].map((n) => ({
        rowid: n,
        guid: `g${n}`,
        isFromMe: 0 as const,
        text: `t${n}`,
      })),
    });
    const chat = openChatDb(path);
    try {
      const poll = pollOnce(chat, 0, 3);
      expect(poll.events.map((e) => e.rowid)).toEqual([1, 2, 3]);
      expect(poll.cursorRowid).toBe(3);
      expect(poll.truncated).toBe(true);
    } finally {
      chat.close();
    }
  });

  it("counts decoder attempts/failures with an exact trailing failure run", () => {
    const path = createFixtureChatDb(join(fixtureDir(root, "c"), "chat.db"), {
      messages: [
        { rowid: 1, guid: "g1", isFromMe: 0, text: null, attributedBody: malformedBody() },
        { rowid: 2, guid: "g2", isFromMe: 0, text: null, attributedBody: bodyFor("good") },
        { rowid: 3, guid: "g3", isFromMe: 0, text: null, attributedBody: malformedBody() },
        { rowid: 4, guid: "g4", isFromMe: 0, text: null, attributedBody: malformedBody() },
        { rowid: 5, guid: "g5", isFromMe: 0, text: "plain text row" },
      ],
    });
    const chat = openChatDb(path);
    try {
      const poll = pollOnce(chat, 0, 100);
      expect(poll.decodeAttempted).toBe(4);
      expect(poll.decodeFailed).toBe(3);
      expect(poll.hasDecodeSuccess).toBe(true);
      expect(poll.decodeFailureTailRun).toBe(2);
    } finally {
      chat.close();
    }
  });

  it("own rows: observed + hashed when decodable; flagged when not", () => {
    const path = createFixtureChatDb(join(fixtureDir(root, "d"), "chat.db"), {
      messages: [
        {
          rowid: 1,
          guid: "g1",
          isFromMe: 1,
          text: null,
          attributedBody: bodyFor("own good"),
        },
        { rowid: 2, guid: "g2", isFromMe: 1, text: null, attributedBody: malformedBody() },
      ],
    });
    const chat = openChatDb(path);
    try {
      const poll = pollOnce(chat, 0, 100);
      expect(poll.ownObserved).toBe(true);
      expect(poll.ownDecodeFailure).toBe(true);
      expect(poll.events[0]!.normalized_text_sha256).toBe(canonicalTextSha256("own good"));
      expect(poll.events[1]!.normalized_text_sha256).toBeUndefined();
    } finally {
      chat.close();
    }
  });
});
