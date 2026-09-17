import { describe, expect, it } from "vitest";
import {
  CLI_CAPTURE_SOURCE,
  cliCaptureSourceAdapter,
  normalizeCliCapture,
} from "./cli-capture.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("cliCaptureSourceAdapter", () => {
  it("implements the SourceAdapter port with the cli.capture id", () => {
    expect(cliCaptureSourceAdapter.id).toBe("cli.capture");
    expect(typeof cliCaptureSourceAdapter.normalizeExternal).toBe("function");
  });

  it("normalizes a capture into a capture.recorded occurrence", () => {
    const event = normalizeCliCapture({
      kind: "capture",
      text: "  I'll send Jehad the migration plan Friday  ",
      occurredAt: "2026-09-17T10:00:00.000Z",
    });
    expect(event).toEqual({
      type: "capture.recorded",
      source: CLI_CAPTURE_SOURCE,
      externalId: expect.stringMatching(UUID_RE),
      occurredAt: "2026-09-17T10:00:00.000Z",
      domainId: "personal",
      sensitivity: "normal",
      payload: { text: "I'll send Jehad the migration plan Friday" },
    });
  });

  it("normalizes a decide into a decision.recorded occurrence", () => {
    const event = normalizeCliCapture({ kind: "decide", text: "Postgres over SQLite" });
    expect(event.type).toBe("decision.recorded");
    expect(event.payload).toEqual({ text: "Postgres over SQLite" });
  });

  it("mints a fresh uuid external id per invocation — same words are two occurrences (plan §8)", () => {
    const text = "identical words";
    const first = normalizeCliCapture({ kind: "capture", text });
    const second = normalizeCliCapture({ kind: "capture", text });
    expect(first.externalId).toMatch(UUID_RE);
    expect(second.externalId).toMatch(UUID_RE);
    expect(first.externalId).not.toBe(second.externalId);
  });

  it("honors explicit domainId and sensitivity, defaults occurredAt to now", () => {
    const before = Date.now();
    const event = normalizeCliCapture({
      kind: "capture",
      text: "x",
      domainId: "work",
      sensitivity: "sensitive",
    });
    expect(event.domainId).toBe("work");
    expect(event.sensitivity).toBe("sensitive");
    expect(Date.parse(event.occurredAt)).toBeGreaterThanOrEqual(before);
  });

  it("is reachable through the port's normalizeExternal", () => {
    const event = cliCaptureSourceAdapter.normalizeExternal({
      kind: "capture",
      text: "via the port",
    });
    expect(event.source).toBe("cli.capture");
  });

  const badInputs: unknown[] = [
    null,
    "capture",
    { kind: "import", text: "x" },
    { kind: "capture" },
    { kind: "capture", text: "   " },
    { kind: "capture", text: 7 },
    { kind: "capture", text: "x", domainId: "" },
    { kind: "capture", text: "x", occurredAt: "yesterday" },
    { kind: "capture", text: "x", sensitivity: "ultra" },
  ];

  for (const [i, raw] of badInputs.entries()) {
    it(`rejects malformed input #${i} with TypeError`, () => {
      expect(() => normalizeCliCapture(raw)).toThrow(TypeError);
    });
  }
});
