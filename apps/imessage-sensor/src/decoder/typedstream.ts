/**
 * Parser for Apple's legacy `streamtyped` typedstream format (NeXTSTEP
 * NXTypedStream / NSArchiver), as used by chat.db `attributedBody` blobs.
 *
 * Pure, dependency-free (node stdlib only). Structural failures throw an
 * internal {@link StreamError}; the public decoder converts those into
 * `ok:false` results and never throws for data input.
 *
 * Format facts (confirmed against real attributedBody blobs): header
 * `\x04\x0bstreamtyped\x81\xe8\x03`, one shared string table for type
 * descriptors / class names / cstring values, an object table for objects,
 * classes and cstring slots, little-endian multi-byte integers, single-byte
 * references = 0x92 + table index.
 */

/** Internal structural failure — never escapes this module's public wrapper. */
export class StreamError extends Error {}

/* Tag bytes (Apple/NeXTSTEP typedstream constants). */
const I16 = 0x81; // 2-byte little-endian integer follows
const I32 = 0x82; // 4-byte little-endian integer follows
const I64 = 0x87; // 8-byte little-endian integer follows
const DECIMAL = 0x83; // IEEE-754 float/double follows
const START = 0x84; // start of a new object / literal shared string
const EMPTY = 0x85; // no more data (nil / end of class chain)
const END = 0x86; // last byte of an object
const REFERENCE_TAG = 0x92; // byte >= this: table index (byte - tag)

/** One slot of a parsed type descriptor. */
type Slot =
  | { k: "object" }
  | { k: "utf8string" }
  | { k: "cstring" }
  | { k: "selector" }
  | { k: "atom" }
  | { k: "class" }
  | { k: "int" }
  | { k: "uint" }
  | { k: "float" }
  | { k: "double" }
  | { k: "array"; n: number };

/** A decoded data value. */
export type Val =
  | { t: "str"; v: string }
  | { t: "obj"; idx: number }
  | { t: "null" }
  | { t: "i"; v: number }
  | { t: "u"; v: number }
  | { t: "f"; v: number }
  | { t: "d"; v: number }
  | { t: "bytes"; v: Uint8Array };

export type ObjectEntry =
  | { k: "object"; cls: number; groups: Val[][] }
  | { k: "class"; name: number; parent: number | null; version: number }
  | { k: "cstring"; strIdx: number }
  | { k: "placeholder" };

export interface ParsedStream {
  rootIdx: number;
  strings: string[];
  objects: ObjectEntry[];
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Max object-nesting depth the parser will follow (DoS / stack guard). */
const MAX_DEPTH = 512;

function scalarType(byte: number): Slot | null {
  switch (byte) {
    case 0x40 /* @ */:
      return { k: "object" };
    case 0x23 /* # */:
      return { k: "class" };
    case 0x3a /* : */:
      return { k: "selector" };
    case 0x25 /* % */:
      return { k: "atom" };
    case 0x2a /* * */:
      return { k: "cstring" };
    case 0x2b /* + */:
      return { k: "utf8string" };
    case 0x66 /* f */:
      return { k: "float" };
    case 0x64 /* d */:
      return { k: "double" };
    case 0x63: /* c */
    case 0x69: /* i */
    case 0x6c: /* l */
    case 0x71: /* q */
    case 0x73: /* s */
      return { k: "int" };
    case 0x43: /* C */
    case 0x49: /* I */
    case 0x4c: /* L */
    case 0x51: /* Q */
    case 0x53: /* S */
    case 0x42: /* B */
      return { k: "uint" };
    default:
      return null;
  }
}

/**
 * Parse an Objective-C type-encoding descriptor into its value slots
 * (e.g. `@`, `+`, `iI`, `{_NSRange=QQ}` -> two uints, `[4c]` -> one slot of
 * 4 raw bytes). `maxSlots` bounds array expansion by the stream bytes left.
 */
export function parseDescriptor(text: string, maxSlots: number): Slot[] {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new StreamError(`descriptor char out of range: ${text}`);
    bytes[i] = code;
  }
  let pos = 0;

  const parseOne = (): Slot[] => {
    // Skip method qualifiers (const/in/out/...) — NSArchiver strips them.
    while (
      pos < bytes.length &&
      [0x72, 0x6e, 0x4e, 0x6f, 0x4f, 0x52, 0x56].includes(bytes[pos]!)
    ) {
      pos++;
    }
    if (pos >= bytes.length) throw new StreamError("descriptor ended early");
    const byte = bytes[pos]!;
    pos++;

    if (byte === 0x5b /* [ */) {
      let count = 0;
      let sawDigit = false;
      while (pos < bytes.length && bytes[pos]! >= 0x30 && bytes[pos]! <= 0x39) {
        count = count * 10 + (bytes[pos]! - 0x30);
        if (!Number.isSafeInteger(count) || count > 0xffff_ffff) {
          throw new StreamError("array count overflow");
        }
        sawDigit = true;
        pos++;
      }
      if (!sawDigit) throw new StreamError("array without count");
      // A char array stays whole: N raw bytes in one slot.
      if (
        (bytes[pos] === 0x63 || bytes[pos] === 0x43) &&
        bytes[pos + 1] === 0x5d /* ] */
      ) {
        pos += 2;
        return [{ k: "array", n: count }];
      }
      const element = parseOne();
      if (bytes[pos] !== 0x5d /* ] */) throw new StreamError("unterminated array");
      pos++;
      if (count * element.length > maxSlots) throw new StreamError("array overruns stream");
      const slots: Slot[] = [];
      for (let i = 0; i < count; i++) slots.push(...element);
      return slots;
    }
    if (byte === 0x7b /* { */) {
      // { name = member member ... } — skip the name, flatten members.
      while (pos < bytes.length) {
        const b = bytes[pos]!;
        pos++;
        if (b === 0x3d /* = */) break;
        if (b === 0x7d /* } */) return [];
      }
      const slots: Slot[] = [];
      for (;;) {
        if (pos >= bytes.length) throw new StreamError("unterminated struct");
        if (bytes[pos] === 0x7d /* } */) {
          pos++;
          return slots;
        }
        slots.push(...parseOne());
      }
    }
    if ([0x28, 0x62, 0x5e, 0x76, 0x3f].includes(byte)) {
      // ( union, b bitfield, ^ pointer, v void, ? — never written by NSArchiver
      throw new StreamError(`unencodable descriptor char: ${String.fromCharCode(byte)}`);
    }
    const scalar = scalarType(byte);
    if (!scalar) throw new StreamError(`invalid descriptor char: ${String.fromCharCode(byte)}`);
    return [scalar];
  };

  const out: Slot[] = [];
  while (pos < bytes.length) out.push(...parseOne());
  return out;
}

/** Shared-string table entry: the text plus its parsed descriptor view. */
interface SharedString {
  text: string;
  desc: Slot[] | null;
}

export class TypedStreamParser {
  private pos = 0;
  private readonly strings: SharedString[] = [];
  private readonly objects: ObjectEntry[] = [];
  private depth = 0;

  private constructor(private readonly data: Uint8Array) {}

  /** Parse a full typedstream; throws {@link StreamError} on structural failure. */
  static parse(data: Uint8Array): ParsedStream {
    if (data.length === 0) throw new StreamError("empty blob");
    return new TypedStreamParser(data).oxidize();
  }

  /* ---------- byte-level readers ---------- */

  private byteAt(idx: number): number {
    if (idx < 0 || idx >= this.data.length) {
      throw new StreamError(`out of bounds: byte ${idx} of ${this.data.length}`);
    }
    return this.data[idx]!;
  }

  private bytesAt(idx: number, n: number): Uint8Array {
    if (n < 0 || idx < 0 || idx + n > this.data.length) {
      throw new StreamError(`out of bounds: ${n} bytes at ${idx} of ${this.data.length}`);
    }
    return this.data.subarray(idx, idx + n);
  }

  /**
   * Read an integer at the current position without advancing. Widths: no tag
   * = 1 byte, `0x81` = i16 LE, `0x82` = i32 LE, `0x87` = i64 LE. A leading
   * byte above the reference tag that is not followed by END is skipped
   * (reference-tag quirk of the archive format).
   */
  private readIntAt(offset: number, unsigned: boolean): { v: number; consumed: number } {
    for (;;) {
      const cur = this.byteAt(this.pos + offset);
      const rest = this.pos + offset + 1;
      if (cur === I16) {
        const b = this.bytesAt(rest, 2);
        const raw = b[0]! | (b[1]! << 8);
        return { v: unsigned ? raw : (raw << 16) >> 16, consumed: 3 };
      }
      if (cur === I32) {
        const b = this.bytesAt(rest, 4);
        const raw = b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24);
        return { v: unsigned ? raw >>> 0 : raw | 0, consumed: 5 };
      }
      if (cur === I64) {
        const b = this.bytesAt(rest, 8);
        const lo = (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) | 0;
        const hi = (b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24)) | 0;
        const v = hi * 0x1_0000_0000 + (lo >>> 0);
        if (!Number.isSafeInteger(v)) throw new StreamError("i64 out of safe integer range");
        return { v: hi < 0 ? v - 0x1_0000_0000_0000_0000 : v, consumed: 9 };
      }
      if (cur > REFERENCE_TAG && this.byteAt(this.pos + offset + 1) !== END) {
        offset++;
        continue;
      }
      return { v: unsigned ? cur : (cur << 24) >> 24, consumed: 1 };
    }
  }

  private readInt(unsigned: boolean): number {
    const { v, consumed } = this.readIntAt(0, unsigned);
    this.pos += consumed;
    return v;
  }

  /** Read a length-prefixed raw UTF-8 string (not registered in any table). */
  private readRawString(): string {
    const len = this.readIntAt(0, true);
    const start = this.pos + len.consumed;
    const raw = this.bytesAt(start, len.v);
    this.pos = start + len.v;
    try {
      return utf8Decoder.decode(raw);
    } catch {
      throw new StreamError("invalid UTF-8 in string data");
    }
  }

  /* ---------- table readers ---------- */

  /** Read a shared string (literal or reference); returns its table index. */
  private readSharedString(): number {
    const b = this.byteAt(this.pos);
    this.pos++;
    if (b === START) {
      const text = this.readRawString();
      this.strings.push({ text, desc: null });
      return this.strings.length - 1;
    }
    if (b === EMPTY) throw new StreamError("empty shared string");
    const idx = b - REFERENCE_TAG;
    if (idx < 0 || idx >= this.strings.length) {
      throw new StreamError(`shared string pointer ${idx} out of range (${this.strings.length})`);
    }
    return idx;
  }

  /**
   * Read a class chain: a sequence of new classes (child first) terminated by
   * EMPTY or a pointer to an existing superclass. Returns the object-table
   * index of the bottom-most (actual) class, or null for a pointer-only or
   * nil chain.
   */
  private readClass(): number | null {
    let firstNew: number | null = null;
    let prevNew: number | null = null;
    let finalParent: number | null = null;

    for (;;) {
      const b = this.byteAt(this.pos);
      this.pos++;
      if (b === START) {
        const nameIdx = this.readSharedString();
        const version = this.readInt(true);
        const idx = this.objects.length;
        this.objects.push({ k: "class", name: nameIdx, parent: null, version });
        if (prevNew !== null) {
          const prev = this.objects[prevNew];
          if (prev?.k === "class") prev.parent = idx;
        }
        firstNew ??= idx;
        prevNew = idx;
        continue;
      }
      if (b === EMPTY) {
        finalParent = null;
        break;
      }
      const idx = b - REFERENCE_TAG;
      if (idx < 0 || idx >= this.objects.length) {
        throw new StreamError(`class pointer ${idx} out of range (${this.objects.length})`);
      }
      finalParent = idx;
      break;
    }

    if (firstNew === null) return finalParent;
    const outer = this.objects[prevNew!];
    if (outer?.k === "class") outer.parent = finalParent;
    return firstNew;
  }

  /**
   * Read an object: START (inline; a placeholder slot is reserved before the
   * class chain, matching the encoder's table layout), EMPTY (nil), or a
   * pointer to an existing object. The trailing END/EMPTY/pointer byte is
   * left for the caller to consume.
   */
  private readObject(): number | null {
    const b = this.byteAt(this.pos);
    if (b === START) {
      if (++this.depth > MAX_DEPTH) throw new StreamError("object nesting too deep");
      const placeholderIdx = this.objects.length;
      this.objects.push({ k: "placeholder" });
      this.pos++;
      const cls = this.readClass();
      if (cls !== null) {
        const groups: Val[][] = [];
        while (this.pos < this.data.length && this.byteAt(this.pos) !== END) {
          const typeIdx = this.readType();
          if (typeIdx !== null) groups.push(this.readTypes(typeIdx));
        }
        this.objects[placeholderIdx] = { k: "object", cls, groups };
      }
      this.depth--;
      return placeholderIdx;
    }
    if (b === EMPTY) return null;
    const idx = b - REFERENCE_TAG;
    if (idx < 0 || idx >= this.objects.length) {
      throw new StreamError(`object pointer ${idx} out of range (${this.objects.length})`);
    }
    return idx;
  }

  /** Read one value for a descriptor slot. */
  private readValue(slot: Slot): Val {
    switch (slot.k) {
      case "utf8string":
        return { t: "str", v: this.readRawString() };
      case "object": {
        const idx = this.readObject();
        this.pos++; // consume the END / EMPTY / pointer byte
        return idx === null ? { t: "null" } : { t: "obj", idx };
      }
      case "array": {
        const raw = this.bytesAt(this.pos, slot.n);
        this.pos += slot.n;
        return { t: "bytes", v: raw };
      }
      case "selector":
      case "atom": {
        if (this.byteAt(this.pos) === EMPTY) {
          this.pos++;
          return { t: "null" };
        }
        const idx = this.readSharedString();
        return { t: "str", v: this.strings[idx]!.text };
      }
      case "cstring": {
        const b = this.byteAt(this.pos);
        this.pos++;
        if (b === EMPTY) return { t: "null" };
        if (b === START) {
          const strIdx = this.readSharedString();
          this.objects.push({ k: "cstring", strIdx });
          return { t: "str", v: this.strings[strIdx]!.text };
        }
        const slotIdx = b - REFERENCE_TAG;
        const entry = slotIdx >= 0 && slotIdx < this.objects.length ? this.objects[slotIdx] : undefined;
        if (!entry || entry.k !== "cstring") {
          throw new StreamError(`cstring pointer ${slotIdx} does not name a cstring`);
        }
        return { t: "str", v: this.strings[entry.strIdx]!.text };
      }
      case "class": {
        const cls = this.readClass();
        return cls === null ? { t: "null" } : { t: "obj", idx: cls };
      }
      case "int":
        return { t: "i", v: this.readInt(false) };
      case "uint":
        return { t: "u", v: this.readInt(true) };
      case "float":
      case "double": {
        const isFloat = slot.k === "float";
        if (this.byteAt(this.pos) === DECIMAL) {
          const size = isFloat ? 4 : 8;
          const raw = this.bytesAt(this.pos + 1, size);
          this.pos += size + 1;
          const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          return {
            t: isFloat ? "f" : "d",
            v: isFloat ? view.getFloat32(0, true) : view.getFloat64(0, true),
          };
        }
        return { t: isFloat ? "f" : "d", v: this.readInt(false) };
      }
    }
  }

  /** Read one value per slot of the descriptor at `typeIndex` into a group. */
  private readTypes(typeIndex: number): Val[] {
    const entry = this.strings[typeIndex]!;
    if (entry.desc === null) {
      entry.desc = parseDescriptor(entry.text, this.data.length - this.pos);
    }
    const group: Val[] = [];
    for (const slot of entry.desc) group.push(this.readValue(slot));
    return group;
  }

  /**
   * Read a type descriptor: a literal (registered into the shared table) or a
   * reference to an earlier shared string. Returns null at END/EMPTY where a
   * descriptor was optional.
   */
  private readType(): number | null {
    const b = this.byteAt(this.pos);
    this.pos++;
    let index: number;
    if (b === START) {
      const text = this.readRawString();
      this.strings.push({ text, desc: null });
      index = this.strings.length - 1;
    } else if (b === END || b === EMPTY) {
      return null;
    } else {
      index = b - REFERENCE_TAG;
      if (index < 0 || index >= this.strings.length) {
        throw new StreamError(`type pointer ${index} out of range (${this.strings.length})`);
      }
    }
    const entry = this.strings[index]!;
    if (entry.desc === null) {
      entry.desc = parseDescriptor(entry.text, this.data.length - this.pos);
    }
    return index;
  }

  /* ---------- top level ---------- */

  private oxidize(): ParsedStream {
    // Header: version 4 (single byte), "streamtyped", system version 1000.
    if (this.byteAt(0) !== 0x04) throw new StreamError("header: not typedstream version 4");
    this.pos = 1;
    const signature = this.readRawString();
    if (signature !== "streamtyped") {
      throw new StreamError(
        `header: signature ${JSON.stringify(signature.slice(0, 16))} is not "streamtyped"`,
      );
    }
    if (this.readInt(false) !== 1000) throw new StreamError("header: system version != 1000");

    // The root must be an object.
    const typeIdx = this.readType();
    if (typeIdx === null) throw new StreamError("no root descriptor");
    const group = this.readTypes(typeIdx);
    const first = group[0];
    if (!first || first.t !== "obj") throw new StreamError("root is not an object");

    // A well-formed attributedBody consumes the whole buffer.
    if (this.pos !== this.data.length) {
      throw new StreamError(`trailing ${this.data.length - this.pos} bytes after root object`);
    }

    return {
      rootIdx: first.idx,
      strings: this.strings.map((s) => s.text),
      objects: this.objects,
    };
  }
}
