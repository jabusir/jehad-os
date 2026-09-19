/**
 * Fixture matrix for the attributedBody decoder — single source of truth.
 *
 * Each entry is a message spec (encoded by stream-encoder.ts into a valid
 * streamtyped blob) plus the expected DecodeResult, or a derived mutation
 * for the failure cases. generate-fixtures.ts writes the committed .bin +
 * .json files; decoder.test.ts asserts against them and re-encodes to guard
 * against fixture drift.
 */

import type { DecodeResult } from "../../src/decoder/index.js";
import { attachmentGuid, encodeAttributedBody, type MessageSpec } from "./stream-encoder.ts";

export interface FixtureSpec {
  /** Valid message spec (encoded to bytes), or a hand-built blob. */
  spec?: MessageSpec;
  blob?: Uint8Array;
  /** Post-processing of the encoded spec bytes (malformed cases). */
  derive?: (blob: Uint8Array) => Uint8Array;
  expected: DecodeResult;
}

const ok = (text: string, parts: number, hasAttachmentPlaceholder = false): DecodeResult => ({
  ok: true,
  text,
  parts,
  hasAttachmentPlaceholder,
});

const LONG_TEXT =
  "The quick brown fox jumps over the lazy dog. " +
  "敏捷的棕色狐狸跳过了懒狗。".repeat(2) +
  "Pack my box with five dozen liquor jugs. ".repeat(8) +
  "أبجد هوز حطي كلمن سعفص قرشت ".repeat(4) +
  "🧑‍🚀🧑‍🚀🧑‍🚀 ".repeat(6) +
  "How vexingly quick daft zebras jump! ".repeat(28);

// Single source for spec text + expectation (avoids NFC/NFD drift between the two).
const UNICODE_TEXT = "你好，世界！ école suī 平仮名";

export const FIXTURES: Record<string, FixtureSpec> = {
  ascii: {
    spec: {
      text: "Noter test",
      runs: [{ attrs: [["__kIMMessagePartAttributeName", { kind: "number", value: 0 }]], rangeLength: 10 }],
    },
    expected: ok("Noter test", 1),
  },
  unicode: {
    spec: {
      rootClass: "NSAttributedString",
      text: UNICODE_TEXT,
      runs: [{ attrs: [["__kIMMessagePartAttributeName", { kind: "number", value: 0 }]], rangeLength: UNICODE_TEXT.length }],
    },
    expected: ok(UNICODE_TEXT, 1),
  },
  emoji: {
    spec: {
      text: "family 👨‍👩‍👧‍👦 thumbs 👍🏽 flag 🇵🇸 heart ❤️",
      runs: [{ attrs: [["__kIMMessagePartAttributeName", { kind: "number", value: 0 }]], rangeLength: 33 }],
    },
    expected: ok("family 👨‍👩‍👧‍👦 thumbs 👍🏽 flag 🇵🇸 heart ❤️", 1),
  },
  rtl: {
    spec: {
      text: "أهلاً بكم في النظام",
      runs: [
        {
          attrs: [
            ["__kIMBaseWritingDirectionAttributeName", { kind: "number", value: -1 }],
            ["__kIMMessagePartAttributeName", { kind: "number", value: 0 }],
          ],
          rangeLength: 19,
        },
      ],
    },
    expected: ok("أهلاً بكم في النظام", 1),
  },
  multiline: {
    spec: {
      text: "line one\nline two\n\nline three\ttabbed",
      runs: [{ attrs: [["__kIMMessagePartAttributeName", { kind: "number", value: 0 }]], rangeLength: 32 }],
    },
    expected: ok("line one\nline two\n\nline three\ttabbed", 1),
  },
  urls: {
    spec: {
      text: "docs https://example.com/a?b=c#frag and https://github.com/ReagentX/imessage-exporter",
      runs: [
        {
          attrs: [
            ["__kIMLinkAttributeName", { kind: "url", value: "https://example.com/a?b=c#frag" }],
            ["__kIMMessagePartAttributeName", { kind: "number", value: 0 }],
          ],
          rangeLength: 71,
        },
      ],
    },
    expected: ok(
      "docs https://example.com/a?b=c#frag and https://github.com/ReagentX/imessage-exporter",
      1,
    ),
  },
  "very-long": {
    spec: {
      text: LONG_TEXT,
      runs: [{ attrs: [["__kIMMessagePartAttributeName", { kind: "number", value: 0 }]], rangeLength: LONG_TEXT.length }],
    },
    expected: ok(LONG_TEXT, 1),
  },
  empty: {
    spec: { text: "" },
    expected: ok("", 1),
  },
  "rich-formatting": {
    spec: {
      text: "bold text must survive formatting",
      runs: [
        {
          attrs: [
            ["__kIMTextEffectAttributeName", { kind: "string", value: "bold" }],
            [
              "NSFontAttributeName",
              { kind: "dict", entries: [["NSFontNameAttribute", { kind: "string", value: "Helvetica-Bold" }]] },
            ],
            ["__kIMMessagePartAttributeName", { kind: "number", value: 0 }],
          ],
          rangeLength: 32,
        },
      ],
    },
    expected: ok("bold text must survive formatting", 1),
  },
  "multipart-attachment": {
    spec: {
      text: "photo \uFFFC caption \uFFFC end",
      runs: [
        {
          attrs: [["__kIMMessagePartAttributeName", { kind: "number", value: 0 }]],
          rangeLength: 7,
        },
        {
          attrs: [
            ["__kIMFileTransferGUIDAttributeName", { kind: "string", value: attachmentGuid(0) }],
            ["__kIMMessagePartAttributeName", { kind: "number", value: 1 }],
          ],
          rangeLength: 1,
        },
        {
          attrs: [
            ["__kIMFileTransferGUIDAttributeName", { kind: "string", value: attachmentGuid(2) }],
            ["__kIMMessagePartAttributeName", { kind: "number", value: 2 }],
          ],
          rangeLength: 10,
        },
      ],
    },
    expected: ok("photo \uFFFC caption \uFFFC end", 3, true),
  },
  "malformed-truncated": {
    spec: {
      text: "this message will be truncated mid-stream",
      runs: [{ attrs: [["__kIMMessagePartAttributeName", { kind: "number", value: 0 }]], rangeLength: 40 }],
    },
    derive: (blob) => blob.subarray(0, Math.floor(blob.length * 0.6)),
    expected: { ok: false, reason: "malformed" },
  },
  "malformed-corrupt-length": {
    spec: {
      text: "corrupt my length prefix",
      runs: [{ attrs: [["__kIMMessagePartAttributeName", { kind: "number", value: 0 }]], rangeLength: 24 }],
    },
    derive: (blob) => {
      const textBytes = Buffer.from("corrupt my length prefix", "utf8");
      let at = -1;
      outer: for (let i = 0; i + textBytes.length <= blob.length; i++) {
        for (let j = 0; j < textBytes.length; j++) {
          if (blob[i + j] !== textBytes[j]) continue outer;
        }
        at = i;
        break;
      }
      if (at <= 0) throw new Error("text not found for corruption");
      const patched = Uint8Array.from(blob);
      patched[at - 1] = 0x7f; // length prefix now promises 127 bytes near EOF
      return patched;
    },
    expected: { ok: false, reason: "malformed" },
  },
  "unknown-archive-bplist": {
    blob: Uint8Array.from([
      ...[..."bplist00"].map((c) => c.charCodeAt(0)),
      0xd0, 0x0f, 0x00, 0x06, 0x00, 0x1e, 0x84, 0x70, ...Array(24).fill(0x00),
      0x08, 0x0b, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x1e,
    ]),
    expected: { ok: false, reason: "unknown-archive" },
  },
};

/** Encode a fixture entry to its final blob bytes. */
export function fixtureBlob(name: string): Uint8Array {
  const fixture = FIXTURES[name]!;
  let blob = fixture.blob;
  if (blob === undefined) {
    if (!fixture.spec) throw new Error(`fixture ${name} has neither spec nor blob`);
    blob = encodeAttributedBody(fixture.spec);
  }
  return fixture.derive ? fixture.derive(blob) : blob;
}
