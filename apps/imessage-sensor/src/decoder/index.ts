/**
 * Public decoder for iMessage `attributedBody` blobs (Apple old-style
 * `streamtyped` typedstream archiving an NSAttributedString).
 *
 * Contract (docs/plans/ig-phase-a-contracts.md): correct text or no text —
 * any structural surprise yields `{ ok: false }`, never partially
 * reconstructed output, and the function never throws for data input.
 */

import {
  type ObjectEntry,
  type ParsedStream,
  type Val,
  StreamError,
  TypedStreamParser,
} from "./typedstream.js";

export type DecodeResult =
  | { ok: true; text: string; parts: number; hasAttachmentPlaceholder: boolean }
  | { ok: false; reason: "malformed" | "unknown-archive"; detail?: string };

/** Attribute keys this decoder understands (anything else is tolerated). */
const PART_ATTRIBUTE = "__kIMMessagePartAttributeName";
const FILE_TRANSFER_ATTRIBUTE = "__kIMFileTransferGUIDAttributeName";
const WRITING_DIRECTION_ATTRIBUTE = "__kIMBaseWritingDirectionAttributeName";

const ATTRIBUTED_STRING_CLASSES = new Set(["NSAttributedString", "NSMutableAttributedString"]);
const STRING_CLASSES = new Set(["NSString", "NSMutableString"]);
const DICT_CLASSES = new Set(["NSDictionary", "NSMutableDictionary"]);
const NUMBER_CLASSES = new Set(["NSNumber", "NSDecimalNumber"]);

/** Marker Apple inlines in message text for attachments. */
const ATTACHMENT_PLACEHOLDER = "\uFFFC";

function objectClassName(stream: ParsedStream, idx: number): string | null {
  const entry: ObjectEntry | undefined = stream.objects[idx];
  if (!entry || entry.k !== "object") return null;
  const cls = stream.objects[entry.cls];
  if (!cls || cls.k !== "class") return null;
  return stream.strings[cls.name] ?? null;
}

/** The single string value of an NSString-family object, or null. */
function stringObjectText(stream: ParsedStream, idx: number): string | null {
  if (!STRING_CLASSES.has(objectClassName(stream, idx) ?? "")) return null;
  const entry = stream.objects[idx]!;
  if (entry.k !== "object" || entry.groups.length !== 1) return null;
  const group = entry.groups[0]!;
  if (group.length !== 1 || group[0]!.t !== "str") return null;
  return group[0]!.v;
}

/** The single integer value of an NSNumber object, or null. */
function numberObjectValue(stream: ParsedStream, idx: number): number | null {
  if (!NUMBER_CLASSES.has(objectClassName(stream, idx) ?? "")) return null;
  const entry = stream.objects[idx]!;
  if (entry.k !== "object") return null;
  let found: number | null = null;
  for (const group of entry.groups) {
    if (group.length === 1 && (group[0]!.t === "i" || group[0]!.t === "u")) {
      if (found !== null) return null; // ambiguous — refuse to guess
      found = group[0]!.v;
    }
  }
  return found;
}

interface DictEntry {
  key: string;
  valueIdx: number;
}

/** Validate an NSDictionary object's shape and return its entries. */
function dictEntries(stream: ParsedStream, idx: number): DictEntry[] | null {
  if (!DICT_CLASSES.has(objectClassName(stream, idx) ?? "")) return null;
  const entry = stream.objects[idx]!;
  if (entry.k !== "object" || entry.groups.length === 0) return null;
  const countGroup = entry.groups[0]!;
  if (countGroup.length !== 1 || countGroup[0]!.t !== "i") return null;
  const count = countGroup[0]!.v;
  if (count < 0 || entry.groups.length !== 1 + 2 * count) return null;

  const entries: DictEntry[] = [];
  for (let i = 0; i < count; i++) {
    const keyGroup = entry.groups[1 + 2 * i]!;
    const valueGroup = entry.groups[2 + 2 * i]!;
    if (keyGroup.length !== 1 || keyGroup[0]!.t !== "obj") return null;
    if (valueGroup.length !== 1 || valueGroup[0]!.t !== "obj") return null;
    const key = stringObjectText(stream, keyGroup[0]!.idx);
    if (key === null) return null;
    entries.push({ key, valueIdx: valueGroup[0]!.idx });
  }
  return entries;
}

function malformed(detail: string): DecodeResult {
  return { ok: false, reason: "malformed", detail };
}

function unknownArchive(detail: string): DecodeResult {
  return { ok: false, reason: "unknown-archive", detail };
}

/** Detect non-streamtyped archive encodings we do not handle. */
function classifyOtherArchive(blob: Uint8Array): DecodeResult | null {
  const startsWith = (prefix: string): boolean => {
    if (blob.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (blob[i] !== prefix.charCodeAt(i)) return false;
    }
    return true;
  };
  if (startsWith("bplist00") || startsWith("bplist15")) {
    return unknownArchive("binary property list (modern NSKeyedArchiver), not streamtyped");
  }
  if (startsWith("<?xml") || startsWith("<plist")) {
    return unknownArchive("XML property list archive, not streamtyped");
  }
  return null;
}

/** Interpret a parsed attributed string; throws StreamError on shape violations. */
function interpret(stream: ParsedStream): DecodeResult {
  const root = stream.objects[stream.rootIdx]!;
  const rootClass = objectClassName(stream, stream.rootIdx);
  if (!rootClass || !ATTRIBUTED_STRING_CLASSES.has(rootClass) || root.k !== "object") {
    throw new StreamError(`root object class ${rootClass ?? "unknown"}, expected NSAttributedString`);
  }

  const groups = root.groups;
  if (groups.length < 1) throw new StreamError("attributed string has no content run");

  // Group 0 is the message string object.
  const stringGroup = groups[0]!;
  if (stringGroup.length !== 1 || stringGroup[0]!.t !== "obj") {
    throw new StreamError("first group is not the string object");
  }
  const text = stringObjectText(stream, stringGroup[0]!.idx);
  if (text === null) throw new StreamError("content string object has unexpected shape");

  // Remaining groups: a flat sequence of attribute runs. Each run is an int
  // pair (range); a run carrying attributes follows with its dictionary
  // object group. Real-world archives (data-detector/notification blobs)
  // also emit runs whose dictionary is absent — an orphan int pair — both
  // between and after attributed runs. The text always comes from the
  // content string object above; an orphan run contributes no attributes.
  let maxPart: number | null = null;
  let i = 1;
  for (let r = 0; i < groups.length; r++) {
    const rangeGroup = groups[i]!;
    if (
      rangeGroup.length !== 2 ||
      !rangeGroup.every((v: Val) => v.t === "i" || v.t === "u")
    ) {
      throw new StreamError(`run ${r}: range group is not an int pair`);
    }
    i++;
    const dictGroup = i < groups.length ? groups[i]! : undefined;
    if (dictGroup !== undefined && dictGroup.length === 1 && dictGroup[0]!.t === "obj") {
      const entries = dictEntries(stream, dictGroup[0]!.idx);
      if (entries === null) throw new StreamError(`run ${r}: attribute dictionary malformed`);
      i++;
      for (const { key, valueIdx } of entries) {
        if (key === PART_ATTRIBUTE) {
          const part = numberObjectValue(stream, valueIdx);
          if (part === null || !Number.isSafeInteger(part) || part < 0) {
            throw new StreamError(`run ${r}: ${PART_ATTRIBUTE} value is not a valid part index`);
          }
          maxPart = maxPart === null ? part : Math.max(maxPart, part);
        } else if (key === FILE_TRANSFER_ATTRIBUTE) {
          if (stringObjectText(stream, valueIdx) === null) {
            throw new StreamError(`run ${r}: ${FILE_TRANSFER_ATTRIBUTE} value is not a string`);
          }
        } else if (key === WRITING_DIRECTION_ATTRIBUTE) {
          if (numberObjectValue(stream, valueIdx) === null) {
            throw new StreamError(`run ${r}: ${WRITING_DIRECTION_ATTRIBUTE} value is not a number`);
          }
        }
        // Other attributes (links, formatting, data-detectors, …) are carried
        // along the archive but do not affect text extraction; tolerate them.
      }
    }
  }

  return {
    ok: true,
    text,
    parts: maxPart === null ? 1 : maxPart + 1,
    hasAttachmentPlaceholder: text.includes(ATTACHMENT_PLACEHOLDER),
  };
}

/**
 * Decode an Apple `streamtyped` typedstream `attributedBody` blob into its
 * message text, part count and attachment-placeholder flag. Pure: no I/O,
 * no dependencies beyond the Node standard library. Correct text or no text;
 * never throws for data input.
 */
export function decodeAttributedBody(blob: Uint8Array): DecodeResult {
  if (!(blob instanceof Uint8Array)) {
    throw new TypeError("decodeAttributedBody expects a Uint8Array");
  }
  const other = classifyOtherArchive(blob);
  if (other) return other;
  try {
    return interpret(TypedStreamParser.parse(blob));
  } catch (err) {
    const detail = err instanceof StreamError ? err.message : `unexpected parse failure: ${String(err)}`;
    return malformed(detail);
  }
}
