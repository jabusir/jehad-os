// poll.ts tests — classification, canonical hash (pinned vectors, the
// SAME contract as apps/edge-agent/test/loop.test.ts), drift counters,
// privacy (content never on the wire), and the multi-principal
// paired-handle rule (content only for paired handles; pairing hash
// otherwise; own rows unchanged).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openChatDb } from "../src/db.js";
import { PairedHandleCache } from "../src/paired.js";
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

describe("multi-principal classification (paired handles)", () => {
  const observedAt = "2026-09-18T12:00:00.000Z";

  function cacheWith(...canonicalHandles: string[]): PairedHandleCache {
    const cache = new PairedHandleCache();
    cache.refresh(canonicalHandles);
    return cache;
  }

  it("paired handle + text column → content IS forwarded, no pairing hash, no loop hash", () => {
    const result = classifyRow(
      row({ rowid: 1, isFromMe: false, text: "PAIRED-SECRET" }),
      observedAt,
      cacheWith("+15550000001"),
    );
    expect(result.event.content).toBe("PAIRED-SECRET");
    expect(result.event.pairing_attempt_hash).toBeUndefined();
    expect(result.event.normalized_text_sha256).toBeUndefined();
    expect(result.event.text_length).toBe(13);
    expect(result.event.decoded_status).toBe("ok");
  });

  it("paired handle + attributedBody-only → content is the DECODED text", () => {
    const result = classifyRow(
      row({ rowid: 2, isFromMe: false, text: null, attributedBody: bodyFor("PAIRED-DECODED\r\nBODY") }),
      observedAt,
      cacheWith("+15550000001"),
    );
    expect(result.event.content).toBe("PAIRED-DECODED\r\nBODY");
    expect(result.event.pairing_attempt_hash).toBeUndefined();
  });

  it("unpaired handle → pairing_attempt_hash of the SAME canonical normalize, NEVER content", () => {
    const result = classifyRow(
      row({ rowid: 3, isFromMe: false, text: "UNPAIRED\r\nSECRET" }),
      observedAt,
      cacheWith("+19999999999"),
    );
    expect(result.event.pairing_attempt_hash).toBe(canonicalTextSha256("UNPAIRED\r\nSECRET"));
    expect(result.event.content).toBeUndefined();
    expect(result.event.normalized_text_sha256).toBeUndefined();
  });

  it("empty cache (fail closed) → every non-own content row is hash-only", () => {
    const result = classifyRow(
      row({ rowid: 4, isFromMe: false, text: "NO-CONFIG-SECRET" }),
      observedAt,
      cacheWith(),
    );
    expect(result.event.pairing_attempt_hash).toBe(canonicalTextSha256("NO-CONFIG-SECRET"));
    expect(result.event.content).toBeUndefined();
  });

  // ADVERSARIAL (heartbeat-response poisoning): the sensor's ONLY trust
  // root for the paired-handle cache is the health response itself (the
  // request is bearer+capability authenticated; the RESPONSE body is
  // unsigned). A poisoned response listing an attacker handle makes this
  // process put that handle's CONTENT on the wire. This pin documents that
  // local fact — the security boundary is server-side: the attacker
  // handle is unpaired in transport_identities, so ingest discards +
  // audits (imessage.content_violation; pinned in
  // packages/core/src/imessage/routing.integration.test.ts). Content
  // transits one authenticated hop; it never persists.
  it("adversarial: poisoned paired_handles cache DOES forward attacker content locally — server is the boundary", () => {
    const poisoned = cacheWith("+15550000001", "+1555ATTACK9"); // MITM-injected entry
    const result = classifyRow(
      row({ rowid: 99, isFromMe: false, text: "POISONED-FORWARD", handleId: "+1555ATTACK9" }),
      observedAt,
      poisoned,
    );
    expect(result.event.content).toBe("POISONED-FORWARD");
    expect(result.event.pairing_attempt_hash).toBeUndefined();
    // The un-poisoned cache with the same server list stays hash-only.
    const clean = cacheWith("+15550000001");
    const cleanResult = classifyRow(
      row({ rowid: 100, isFromMe: false, text: "POISONED-FORWARD", handleId: "+1555ATTACK9" }),
      observedAt,
      clean,
    );
    expect(cleanResult.event.content).toBeUndefined();
    expect(cleanResult.event.pairing_attempt_hash).toBe(canonicalTextSha256("POISONED-FORWARD"));
  });

  it("paired decode-failure row → NO content field, decoded_status records the failure", () => {
    const result = classifyRow(
      row({ rowid: 5, isFromMe: false, text: null, attributedBody: malformedBody() }),
      observedAt,
      cacheWith("+15550000001"),
    );
    expect(result.event.decoded_status).toBe("skipped-malformed");
    expect(result.event.content).toBeUndefined();
    expect(result.event.pairing_attempt_hash).toBeUndefined();
    expect(result.event.text_length).toBeNull();
    expect(result.decodeFailed).toBe(true);
  });

  it("own rows unchanged: loop hash ONLY — never content, never a pairing hash (even when the handle is paired)", () => {
    const result = classifyRow(
      row({ rowid: 6, isFromMe: true, text: "OWN-ROW-CONTENT" }),
      observedAt,
      cacheWith("+15550000001"), // own row's handle would match if content-rule applied
    );
    expect(result.event.normalized_text_sha256).toBe(canonicalTextSha256("OWN-ROW-CONTENT"));
    expect(result.event.content).toBeUndefined();
    expect(result.event.pairing_attempt_hash).toBeUndefined();
    expect(result.event.decoded_status).toBe("own-ok");
  });

  it("no lookup passed (legacy call) → fail closed: hash-only for non-own rows", () => {
    const result = classifyRow(row({ rowid: 7, isFromMe: false, text: "LEGACY-CALL" }), observedAt);
    expect(result.event.pairing_attempt_hash).toBe(canonicalTextSha256("LEGACY-CALL"));
    expect(result.event.content).toBeUndefined();
  });

  it("handle comparison canonicalizes case/format on BOTH sides (one shared normalizer)", () => {
    const cache = cacheWith("+15550000001", "yusra@icloud.com");
    // chat.db formatting variants of the same canonical handles → paired.
    expect(classifyRow(row({ rowid: 8, text: "A", handleId: "+1 (555) 000-0001" }), observedAt, cache).event.content).toBe("A");
    expect(classifyRow(row({ rowid: 9, text: "B", handleId: "15550000001" }), observedAt, cache).event.content).toBe("B");
    expect(classifyRow(row({ rowid: 10, text: "C", handleId: "  Yusra@ICLOUD.com " }), observedAt, cache).event.content).toBe("C");
    // Different handle, or unmatched local 10-digit form → hash-only.
    expect(classifyRow(row({ rowid: 11, text: "D", handleId: "+15550000002" }), observedAt, cache).event.pairing_attempt_hash).toBeDefined();
    expect(classifyRow(row({ rowid: 12, text: "E", handleId: "5550000001" }), observedAt, cache).event.pairing_attempt_hash).toBeDefined();
    // Null handle (transport_handle "unknown") → never paired.
    expect(classifyRow(row({ rowid: 13, text: "F", handleId: null }), observedAt, cache).event.pairing_attempt_hash).toBeDefined();
  });

  it("pollOnce threads the paired lookup through batch classification", () => {
    const path = createFixtureChatDb(join(fixtureDir(root, "mp"), "chat.db"), {
      handles: [
        { rowid: 1, id: "+15550000001" },
        { rowid: 2, id: "+15550000002" },
      ],
      messages: [
        { rowid: 1, guid: "m1", isFromMe: 0, text: "PAIRED-BATCH", handleRowid: 1 },
        { rowid: 2, guid: "m2", isFromMe: 0, text: "UNPAIRED-BATCH", handleRowid: 2 },
        { rowid: 3, guid: "m3", isFromMe: 1, text: "own batch", handleRowid: 1 },
      ],
    });
    const chat = openChatDb(path);
    try {
      const poll = pollOnce(chat, 0, 100, () => new Date(0), cacheWith("+15550000001"));
      expect(poll.events[0]).toMatchObject({ guid: "m1", content: "PAIRED-BATCH" });
      expect(poll.events[1]).toMatchObject({ guid: "m2", pairing_attempt_hash: canonicalTextSha256("UNPAIRED-BATCH") });
      expect(poll.events[1]!.content).toBeUndefined();
      expect(poll.events[2]!.normalized_text_sha256).toBe(canonicalTextSha256("own batch"));
      expect(poll.events[2]!.content).toBeUndefined();
    } finally {
      chat.close();
    }
  });
});
