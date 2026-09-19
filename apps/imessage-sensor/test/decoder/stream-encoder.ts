/**
 * streamtyped attributedBody fixture generator (encoder).
 *
 * Emits blobs byte-compatible with real chat.db `attributedBody` archives:
 * the same shared string table, object table index assignment (placeholder
 * before class chain, cstring slots), class chains, and reference bytes
 * (0x92 + table index) that Apple's NSArchiver writes. Layout modeled on
 * hex dumps of real blobs (docs/spikes/a-prime-chatdb.md §4).
 *
 * Used by generate-fixtures.ts to produce committed .bin fixtures; tests
 * re-run it for round-trip properties. Not part of the sensor runtime.
 */

const HEADER = Uint8Array.from([
  0x04, 0x0b, ...[..."streamtyped"].map((c) => c.charCodeAt(0)), 0x81, 0xe8, 0x03,
]);

const START = 0x84;
const EMPTY = 0x85;
const END = 0x86;
const REFERENCE_TAG = 0x92;

export type AttrValue =
  | { kind: "number"; value: number; objCType?: "q" | "i" }
  | { kind: "string"; value: string }
  | { kind: "url"; value: string }
  | { kind: "dict"; entries: [string, AttrValue][] }
  | { kind: "bytes"; hex: string };

export interface RunSpec {
  /** Attribute dictionary entries for the run. */
  attrs: [string, AttrValue][];
  /** Second int of the archived range pair (UTF-16 length of the run). */
  rangeLength: number;
}

export interface MessageSpec {
  text: string;
  /** Root class flavor; real blobs vary per OS version. */
  rootClass?: "NSAttributedString" | "NSMutableAttributedString";
  runs?: RunSpec[];
}

class Encoder {
  private bytes: number[] = [];
  private strings: string[] = [];
  private objectCount = 0;
  private readonly classIdx = new Map<string, number>();

  constructor(private readonly spec: MessageSpec) {}

  build(): Uint8Array {
    const rootClass = this.spec.rootClass ?? "NSMutableAttributedString";
    this.bytes.push(...HEADER);

    this.emitShared("@"); // root type descriptor

    this.emitObjectStart(); // root attributed string (placeholder slot 0)
    if (rootClass === "NSMutableAttributedString") {
      this.emitClassChain(
        [
          ["NSMutableAttributedString", 0],
          ["NSAttributedString", 0],
          ["NSObject", 0],
        ],
        null,
      );
    } else {
      this.emitClassChain(
        [
          ["NSAttributedString", 0],
          ["NSObject", 0],
        ],
        null,
      );
    }

    // Content string object.
    this.emitShared("@");
    this.emitStringObject(this.spec.text);

    // Attribute runs: (int pair, dictionary object) each. The first int of
    // the archived range pair is a 1-based dictionary ordinal (metadata the
    // decoder does not depend on); the second is the UTF-16 run length.
    let dictOrdinal = 0;
    for (const run of this.spec.runs ?? []) {
      this.emitShared("iI");
      this.emitInt(++dictOrdinal);
      this.emitInt(run.rangeLength);
      this.emitShared("@"); // type slot for the attribute dictionary object
      this.emitAttrDict(run.attrs);
    }

    this.bytes.push(END); // end root object
    return Uint8Array.from(this.bytes);
  }

  /* ---------- shared string table ---------- */

  private refByte(index: number): number {
    const byte = REFERENCE_TAG + index;
    if (byte > 0xff) throw new Error(`table index ${index} too large for single-byte ref`);
    return byte;
  }

  /** Emit a shared string (literal on first use, reference afterwards). */
  private emitShared(text: string): void {
    const existing = this.strings.indexOf(text);
    if (existing >= 0) {
      this.bytes.push(this.refByte(existing));
      return;
    }
    this.bytes.push(START);
    this.emitRawString(text);
    this.strings.push(text);
  }

  /** Emit a length-prefixed UTF-8 string that is NOT registered. */
  private emitRawString(text: string): void {
    const encoded = Buffer.from(text, "utf8");
    this.emitLength(encoded.length);
    this.bytes.push(...encoded);
  }

  /** Length prefix / unsigned int with the archive's width tags. */
  private emitLength(value: number): void {
    if (value <= 0x7f) {
      this.bytes.push(value);
    } else if (value <= 0xffff) {
      this.bytes.push(0x81, value & 0xff, (value >> 8) & 0xff);
    } else {
      this.bytes.push(
        0x82, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff,
      );
    }
  }

  /** Signed int; single-byte negatives only directly before END. */
  private emitInt(value: number, beforeEnd = false): void {
    if (!Number.isSafeInteger(value)) throw new Error(`int ${value} not representable`);
    if (value >= 0 && value <= 0x7f) {
      this.bytes.push(value);
      return;
    }
    if (beforeEnd && value >= -0x80 && value <= -1) {
      this.bytes.push(value & 0xff);
      return;
    }
    if (value >= -0x8000 && value <= 0x7fff) {
      this.bytes.push(0x81, value & 0xff, (value >> 8) & 0xff);
      return;
    }
    this.bytes.push(
      0x82, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff,
    );
  }

  /* ---------- objects ---------- */

  private emitObjectStart(): number {
    const idx = this.objectCount;
    this.objectCount++;
    this.bytes.push(START);
    return idx;
  }

  private emitClassNew(name: string, version: number): void {
    this.bytes.push(START);
    this.emitShared(name);
    this.emitInt(version);
    this.classIdx.set(name, this.objectCount);
    this.objectCount++;
  }

  /** Child-first new-class chain, then EMPTY or a superclass reference. */
  private emitClassChain(chain: [string, number][], parent: string | null = null): void {
    for (const [name, version] of chain) this.emitClassNew(name, version);
    if (parent === null) {
      this.bytes.push(EMPTY);
    } else {
      const idx = this.classIdx.get(parent);
      if (idx === undefined) throw new Error(`unknown parent class ${parent}`);
      this.bytes.push(this.refByte(idx));
    }
  }

  private emitNSStringObject(text: string): void {
    this.emitObjectStart();
    if (this.classIdx.has("NSString")) {
      this.bytes.push(this.refByte(this.classIdx.get("NSString")!));
    } else {
      this.emitClassChain([["NSString", 1]], "NSObject");
    }
    this.emitShared("+");
    this.emitRawString(text);
    this.bytes.push(END);
  }

  private emitStringObject(text: string): void {
    if ((this.spec.rootClass ?? "NSMutableAttributedString") === "NSMutableAttributedString") {
      this.emitObjectStart();
      this.emitClassChain(
        [
          ["NSMutableString", 1],
          ["NSString", 1],
        ],
        "NSObject",
      );
    } else {
      this.emitNSStringObject(text);
      return;
    }
    this.emitShared("+");
    this.emitRawString(text);
    this.bytes.push(END);
  }

  private emitNumberObject(value: number, objCType: "q" | "i"): void {
    this.emitObjectStart();
    if (this.classIdx.has("NSNumber")) {
      // Pointer-only chain: the reference names the object's class itself.
      this.emitClassChain([], "NSNumber");
    } else {
      this.emitClassChain([["NSNumber", 0], ["NSValue", 0]], "NSObject");
    }
    this.emitShared("*");
    this.bytes.push(START); // cstring slot takes an object-table entry
    this.objectCount++;
    this.emitShared(objCType);
    this.emitShared(objCType); // same shared string doubles as value descriptor
    this.emitInt(value, true); // value group is last before END
    this.bytes.push(END);
  }

  private emitUrlObject(url: string): void {
    this.emitObjectStart();
    this.emitClassChain([["NSURL", 0]], "NSObject");
    this.emitShared("c");
    this.emitInt(0);
    this.emitShared("@");
    this.emitNSStringObject(url);
    this.bytes.push(END);
  }

  private emitBytesObject(hex: string): void {
    this.emitObjectStart();
    this.emitClassChain([["NSData", 0]], "NSObject");
    this.emitDescriptor(`[${hex.length / 2}c]`);
    const raw = Buffer.from(hex, "hex");
    this.bytes.push(...raw);
    this.bytes.push(END);
  }

  /** Register (or reference) a descriptor string and emit its type slot. */
  private emitDescriptor(desc: string): void {
    this.emitShared(desc);
  }

  private emitAttrValue(value: AttrValue): void {
    this.emitShared("@");
    switch (value.kind) {
      case "number":
        this.emitNumberObject(value.value, value.objCType ?? "q");
        return;
      case "string":
        this.emitNSStringObject(value.value);
        return;
      case "url":
        this.emitUrlObject(value.value);
        return;
      case "dict":
        this.emitAttrDict(value.entries);
        return;
      case "bytes":
        this.emitBytesObject(value.hex);
        return;
    }
  }

  private emitAttrDict(entries: [string, AttrValue][]): void {
    this.emitObjectStart();
    if (this.classIdx.has("NSDictionary")) {
      this.emitClassChain([], "NSDictionary");
    } else {
      this.emitClassChain([["NSDictionary", 0]], "NSObject");
    }
    this.emitShared("i");
    this.emitInt(entries.length);
    for (const [key, value] of entries) {
      this.emitShared("@");
      this.emitNSStringObject(key);
      this.emitAttrValue(value);
    }
    this.bytes.push(END);
  }
}

/** Encode a message spec into a valid attributedBody streamtyped blob. */
export function encodeAttributedBody(spec: MessageSpec): Uint8Array {
  return new Encoder(spec).build();
}

/** GUID-shaped attachment transfer id, like Apple's `at_0_<UUID>`. */
export function attachmentGuid(n: number): string {
  const hex = "f0668f79-20c2-49c9-a87f-1b007abb0ced";
  return `at_${n}_${hex}`;
}
