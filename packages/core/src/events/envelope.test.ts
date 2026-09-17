import { describe, expect, it } from "vitest";
import {
  idempotencyKeyFor,
  mintEventId,
  validateEventIngest,
  UUID_RE,
  type EventValidationErrorCode,
} from "./envelope.js";

function validBody(): Record<string, unknown> {
  return {
    type: "capture.recorded",
    schemaVersion: 1,
    source: "cli.capture",
    externalId: "0f0e0d0c-0b0a-4909-8908-070605040302",
    occurredAt: "2026-09-17T10:00:00.000Z",
    domainId: "personal",
    sensitivity: "normal",
    payload: { text: "I'll send Jehad the migration plan Friday" },
  };
}

describe("validateEventIngest", () => {
  it("accepts a well-formed occurrence and normalizes occurredAt to UTC ISO", () => {
    const body = validBody();
    body.occurredAt = "2026-09-17T12:00:00+02:00";
    const result = validateEventIngest(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe("capture.recorded");
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.occurredAt).toBe("2026-09-17T10:00:00.000Z");
      expect(result.value.runId).toBeNull();
    }
  });

  it("accepts a uuid runId and additive/unknown fields (contract rule 3)", () => {
    const body = validBody();
    body.runId = "12345678-1234-4234-8234-123456789abc";
    body.futureField = { tolerated: true };
    expect(validateEventIngest(body).ok).toBe(true);
  });

  const cases: Array<[string, unknown, EventValidationErrorCode]> = [
    ["body is an array", [], "ENVELOPE_MALFORMED"],
    ["body is a string", "capture", "ENVELOPE_MALFORMED"],
    ["body is null", null, "ENVELOPE_MALFORMED"],
    [
      "type not in catalog v1",
      { ...validBody(), type: "email.received" },
      "TYPE_NOT_IN_CATALOG",
    ],
    ["type missing", { ...validBody(), type: undefined }, "TYPE_NOT_IN_CATALOG"],
    ["schemaVersion 0", { ...validBody(), schemaVersion: 0 }, "SCHEMA_VERSION_UNSUPPORTED"],
    ["schemaVersion -1", { ...validBody(), schemaVersion: -1 }, "SCHEMA_VERSION_UNSUPPORTED"],
    ["schemaVersion 2 (unreleased)", { ...validBody(), schemaVersion: 2 }, "SCHEMA_VERSION_UNSUPPORTED"],
    ["schemaVersion fractional", { ...validBody(), schemaVersion: 1.5 }, "SCHEMA_VERSION_UNSUPPORTED"],
    ["schemaVersion string", { ...validBody(), schemaVersion: "1" }, "SCHEMA_VERSION_UNSUPPORTED"],
    ["source unknown", { ...validBody(), source: "gmail" }, "SOURCE_INVALID"],
    ["source bare adapter", { ...validBody(), source: "adapter" }, "SOURCE_INVALID"],
    ["source empty adapter id", { ...validBody(), source: "adapter:" }, "SOURCE_INVALID"],
    ["externalId empty", { ...validBody(), externalId: "" }, "EXTERNAL_ID_INVALID"],
    ["externalId non-string", { ...validBody(), externalId: 42 }, "EXTERNAL_ID_INVALID"],
    ["occurredAt relative", { ...validBody(), occurredAt: "yesterday" }, "OCCURRED_AT_INVALID"],
    ["occurredAt date-only", { ...validBody(), occurredAt: "2026-09-17" }, "OCCURRED_AT_INVALID"],
    ["occurredAt missing", { ...validBody(), occurredAt: undefined }, "OCCURRED_AT_INVALID"],
    ["domainId empty", { ...validBody(), domainId: "" }, "DOMAIN_ID_INVALID"],
    ["domainId padded", { ...validBody(), domainId: " personal " }, "DOMAIN_ID_INVALID"],
    ["sensitivity unknown", { ...validBody(), sensitivity: "top-secret" }, "SENSITIVITY_INVALID"],
    ["payload array", { ...validBody(), payload: ["text"] }, "PAYLOAD_INVALID"],
    ["payload null", { ...validBody(), payload: null }, "PAYLOAD_INVALID"],
    ["payload string", { ...validBody(), payload: "text" }, "PAYLOAD_INVALID"],
    ["runId non-uuid", { ...validBody(), runId: "not-a-uuid" }, "RUN_ID_INVALID"],
  ];

  for (const [name, body, code] of cases) {
    it(`rejects ${name} with deterministic ${code}`, () => {
      const result = validateEventIngest(body);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    });
  }

  it("rejects with a stable code+message pair (deterministic 400s)", () => {
    const first = validateEventIngest({ ...validBody(), type: "nope.nope" });
    const second = validateEventIngest({ ...validBody(), type: "nope.nope" });
    expect(first).toEqual(second);
  });
});

describe("idempotencyKeyFor", () => {
  it("derives sha256(source + externalId) — fixed vectors", () => {
    expect(idempotencyKeyFor("cli.capture", "abc")).toBe(
      "73ca3f10da75d843521c98ce55a161778d3498bc965567571cce87274a3d5edc",
    );
    expect(idempotencyKeyFor("internal", "11111111-1111-4111-8111-111111111111")).toBe(
      "690e3a03af7c80c572d21ef78cc6a74fc94c3c963f8be3dc50b1497698f425cb",
    );
  });

  it("is stable across retries and distinct across occurrences", () => {
    const retry = idempotencyKeyFor("cli.capture", "same-external-id");
    expect(idempotencyKeyFor("cli.capture", "same-external-id")).toBe(retry);
    expect(idempotencyKeyFor("cli.capture", "other-external-id")).not.toBe(retry);
    expect(idempotencyKeyFor("adapter:github", "same-external-id")).not.toBe(retry);
  });
});

describe("mintEventId", () => {
  const at = new Date("2026-09-17T12:34:56.789Z");

  it("mints a UUID with version 7 and RFC 4122 variant", () => {
    const id = mintEventId(at);
    expect(id).toMatch(UUID_RE);
    expect(id).toMatch(/-7[0-9a-f]{3}-/);
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("encodes the 48-bit unix millisecond timestamp in the prefix", () => {
    const id = mintEventId(at);
    const prefix = id.slice(0, 13).replace("-", "");
    expect(Number.parseInt(prefix, 16)).toBe(at.getTime());
  });

  it("mints distinct ids within the same millisecond", () => {
    const a = mintEventId(at);
    const b = mintEventId(at);
    expect(a).not.toBe(b);
    expect(a.slice(0, 13)).toBe(b.slice(0, 13));
  });

  it("is monotonic in time-ordered prefix", () => {
    const earlier = mintEventId(new Date(at.getTime() - 1000));
    const later = mintEventId(at);
    expect(earlier.slice(0, 13) < later.slice(0, 13)).toBe(true);
  });

  it("rejects timestamps outside the 48-bit range", () => {
    expect(() => mintEventId(new Date(2 ** 49))).toThrow(RangeError);
  });
});
