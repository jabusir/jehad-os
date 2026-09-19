/**
 * attributedBody decoder test suite: fixture matrix, structural failure
 * cases, round-trip properties and a seeded fuzz harness (no external deps).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeAttributedBody, type DecodeResult } from "../../src/decoder/index.js";
import { FIXTURES, fixtureBlob } from "./fixtures-spec.ts";
import { encodeAttributedBody } from "./stream-encoder.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

const FFFC = "\uFFFC";

function assertResultInvariants(result: DecodeResult): void {
  if (result.ok) {
    expect(result.parts).toBeGreaterThanOrEqual(1);
    expect(result.hasAttachmentPlaceholder).toBe(result.text.includes(FFFC));
    // Text must be well-formed (no lone surrogates from bad UTF-8).
    expect(() => encodeURIComponent(result.text)).not.toThrow();
  } else {
    expect(["malformed", "unknown-archive"]).toContain(result.reason);
    expect(typeof result.detail).toBe("string");
    expect(result.detail!.length).toBeGreaterThan(0);
  }
}

describe("fixture matrix (committed .bin + .json)", () => {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".bin"));

  it("covers the full contract matrix", () => {
    const names = new Set(files.map((f) => f.replace(/\.bin$/, "")));
    expect(names).toEqual(new Set(Object.keys(FIXTURES)));
    const required = [
      "ascii",
      "unicode",
      "emoji",
      "rtl",
      "multiline",
      "urls",
      "very-long",
      "empty",
      "rich-formatting",
      "data-detector-phone",
      "multi-run-formatting",
      "nsmutable-single-run",
      "malformed-truncated",
      "malformed-corrupt-length",
      "unknown-archive-bplist",
    ];
    for (const name of required) expect(names.has(name)).toBe(true);
  });

  for (const file of files) {
    const name = file.replace(/\.bin$/, "");
    it(`${name}: decodes to the pinned expectation`, () => {
      const blob = new Uint8Array(readFileSync(join(fixturesDir, file)));
      const expected: DecodeResult = JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8"));
      const result = decodeAttributedBody(blob);

      if (expected.ok) {
        expect(result).toEqual(expected);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe(expected.reason);
      }
      assertResultInvariants(result);
    });

    it(`${name}: committed bytes match the generator`, () => {
      const committed = new Uint8Array(readFileSync(join(fixturesDir, file)));
      expect(Array.from(committed)).toEqual(Array.from(fixtureBlob(name)));
    });
  }
});

describe("structural failures and edge cases", () => {
  it("empty input is malformed", () => {
    const result = decodeAttributedBody(new Uint8Array(0));
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
    assertResultInvariants(result);
  });

  it("garbage bytes are malformed, never a throw", () => {
    const result = decodeAttributedBody(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("trailing byte after a valid blob is malformed", () => {
    const blob = fixtureBlob("ascii");
    const padded = Uint8Array.from([...blob, 0x00]);
    expect(decodeAttributedBody(padded)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("XML plist archives are unknown-archive", () => {
    const xml = Uint8Array.from(
      [...'<?xml version="1.0"?><plist version="1.0"><string>hi</string></plist>'].map((c) =>
        c.charCodeAt(0),
      ),
    );
    expect(decodeAttributedBody(xml)).toMatchObject({ ok: false, reason: "unknown-archive" });
  });

  it("typedstream that parses but is not an attributed string is malformed", () => {
    // header + "@" descriptor + a bare NSObject root object with no data
    const header = [
      0x04, 0x0b, ...[..."streamtyped"].map((c) => c.charCodeAt(0)), 0x81, 0xe8, 0x03,
    ];
    const blob = Uint8Array.from([
      ...header,
      0x84, 0x01, 0x40, // types: "@"
      0x84, // root object start
      0x84, 0x84, 0x08, ...[..."NSObject"].map((c) => c.charCodeAt(0)), 0x00, // class NSObject v0
      0x85, // end of class chain
      0x86, // end of object
    ]);
    expect(decodeAttributedBody(blob)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("attributed string without a string run is malformed", () => {
    // root NSAttributedString whose first group is an int, not the string object
    const header = [
      0x04, 0x0b, ...[..."streamtyped"].map((c) => c.charCodeAt(0)), 0x81, 0xe8, 0x03,
    ];
    const blob = Uint8Array.from([
      ...header,
      0x84, 0x01, 0x40, // types: "@"
      0x84, // root object start
      0x84, 0x84, 0x12, ...[..."NSAttributedString"].map((c) => c.charCodeAt(0)), 0x00,
      0x84, 0x84, 0x08, ...[..."NSObject"].map((c) => c.charCodeAt(0)), 0x00,
      0x85,
      0x84, 0x01, 0x69, 0x07, // group: "i" = 7 (not the string object)
      0x86,
    ]);
    expect(decodeAttributedBody(blob)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("attribute dictionary without a preceding range pair is malformed", () => {
    // string object, then a dict object group directly (no int pair before it)
    const header = [
      0x04, 0x0b, ...[..."streamtyped"].map((c) => c.charCodeAt(0)), 0x81, 0xe8, 0x03,
    ];
    const blob = Uint8Array.from([
      ...header,
      0x84, 0x01, 0x40, // strings[0] "@": root type
      0x84, // root object start (obj#0)
      0x84, 0x84, 0x12, ...[..."NSAttributedString"].map((c) => c.charCodeAt(0)), 0x00,
      0x84, 0x84, 0x08, ...[..."NSObject"].map((c) => c.charCodeAt(0)), 0x00,
      0x85, // end of class chain
      0x92, // group 0 type: "@" (reference)
      0x84, // string object start (obj#3)
      0x84, 0x84, 0x08, ...[..."NSString"].map((c) => c.charCodeAt(0)), 0x01,
      0x94, // superclass pointer to NSObject (obj#2)
      0x84, 0x01, 0x2b, 0x05, ...[..."hello"].map((c) => c.charCodeAt(0)), // "+" + "hello"
      0x86, // end string object
      0x92, // group 1 type: "@" — dict object WITHOUT a range pair
      0x84, // dictionary object start (obj#6)
      0x84, 0x84, 0x0d, ...[..."NSDictionary"].map((c) => c.charCodeAt(0)), 0x00,
      0x94, // superclass pointer to NSObject
      0x84, 0x01, 0x69, 0x00, // "i" count = 0
      0x86, // end dictionary object
      0x86, // end root object
    ]);
    expect(decodeAttributedBody(blob)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("orphan range pairs (mid-sequence and trailing) decode with full text", () => {
    const text = "call +15550001234 back";
    const blob = encodeAttributedBody({
      text,
      runs: [
        { attrs: [["__kIMMessagePartAttributeName", { kind: "number", value: 0 }]], rangeFirst: 1, rangeLength: 5 },
        { attrs: null, rangeFirst: 1, rangeLength: 12 },
        {
          attrs: [["__kIMLinkAttributeName", { kind: "url", value: "tel:+15550001234" }]],
          rangeFirst: 2,
          rangeLength: 12,
        },
        { attrs: null, rangeFirst: 1, rangeLength: 5 },
      ],
    });
    expect(decodeAttributedBody(blob)).toEqual({
      ok: true,
      text,
      parts: 1,
      hasAttachmentPlaceholder: false,
    });
  });

  it("throws TypeError only for programming errors", () => {
    expect(() => decodeAttributedBody(null as unknown as Uint8Array)).toThrow(TypeError);
    expect(() => decodeAttributedBody("hi" as unknown as Uint8Array)).toThrow(TypeError);
  });

  it("accepts Buffer (Uint8Array subclass)", () => {
    const result = decodeAttributedBody(Buffer.from(fixtureBlob("ascii")));
    expect(result.ok).toBe(true);
  });
});

describe("round-trip property: encode(decode) preserves text exactly", () => {
  const corpus = [
    "",
    "a",
    "ASCII only, punctuation: !?.,;:'\"`~@#$%^&*()[]{}|\\/",
    "CJK: 汉字 日本語 한국어",
    "combining: école suı̄ naïve",
    "emoji: 👨‍👩‍👧‍👦 👍🏽 🇵🇸 ❤️ 🩷",
    "RTL: مرحبا بالعالم 123",
    "mixed bidi: hello مرحبا world",
    "newlines: a\nb\r\nc\rd",
    "tabs\tand\x00null\x1fcontrol",
    "attachment \uFFFC inline",
    "https://example.com/path?query=1&x=%20#frag",
    "4-byte code points: 𐍈 𐌰𐌸 𝟏𝟐𝟑",
    "quotes “”‘’ «» ‹› „“",
    "long run: " + "x".repeat(300) + "y".repeat(300),
    "mixed everything 漢🧑‍🚀\nمرحبا \uFFFC end",
  ];

  for (const [i, text] of corpus.entries()) {
    it(`corpus ${i}`, () => {
      const blob = encodeAttributedBody({ text });
      const result = decodeAttributedBody(blob);
      expect(result).toEqual({ ok: true, text, parts: 1, hasAttachmentPlaceholder: text.includes(FFFC) });
    });
  }
});

describe("fuzz property: any input yields ok-with-clean-text or ok:false, never a throw", () => {
  // Deterministic xorshift32.
  let state = 0x9e3779b9;
  const rand = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const randomByte = (): number => rand() & 0xff;
  const randomBytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, randomByte);

  const validBlobs = ["ascii", "unicode", "emoji", "multipart-attachment", "very-long", "empty"].map(
    (name) => fixtureBlob(name),
  );

  const mutate = (blob: Uint8Array): Uint8Array => {
    const copy = Uint8Array.from(blob);
    const kind = rand() % 4;
    if (kind === 0 && copy.length > 1) {
      return copy.subarray(0, 1 + (rand() % (copy.length - 1))); // truncate
    }
    if (kind === 1) {
      copy[rand() % copy.length] = randomByte(); // flip
      return copy;
    }
    if (kind === 2) {
      const at = rand() % (copy.length + 1);
      return Uint8Array.from([...copy.subarray(0, at), randomByte(), ...copy.subarray(at)]); // insert
    }
    const at = rand() % copy.length;
    return Uint8Array.from([...copy.subarray(0, at), ...copy.subarray(at + 1)]); // delete
  };

  it("1000 pure-random blobs", () => {
    for (let i = 0; i < 1000; i++) {
      const blob = randomBytes(rand() % 200);
      const result = decodeAttributedBody(blob);
      assertResultInvariants(result);
    }
  });

  it("500 random blobs behind a valid streamtyped header", () => {
    const header = fixtureBlob("ascii").subarray(0, 16);
    for (let i = 0; i < 500; i++) {
      const blob = Uint8Array.from([...header, ...randomBytes(rand() % 180)]);
      assertResultInvariants(decodeAttributedBody(blob));
    }
  });

  it("2000 mutations of valid blobs (no throw, deterministic)", () => {
    for (let i = 0; i < 2000; i++) {
      const base = validBlobs[rand() % validBlobs.length]!;
      const mutated = mutate(base);
      const result = decodeAttributedBody(mutated);
      assertResultInvariants(result);
      // Determinism: identical input → identical result.
      expect(decodeAttributedBody(mutated)).toEqual(result);
      // An unchanged valid blob still decodes ok after the fuzz run.
      const again = decodeAttributedBody(base);
      expect(again.ok).toBe(true);
    }
  });
});
