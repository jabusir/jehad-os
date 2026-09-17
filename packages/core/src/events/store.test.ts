import { describe, expect, it } from "vitest";
import { rowToEventEnvelope } from "./store.js";

function envelopeRow(): Record<string, unknown> {
  return {
    id: "0191ec3f-7c2a-7b3e-a9b4-3f2e1d0c9b8a",
    type: "decision.recorded",
    source: "cli.capture",
    occurred_at: new Date("2026-09-17T09:00:00.000Z"),
    recorded_at: new Date("2026-09-17T09:00:01.500Z"),
    idempotency_key: "73ca3f10da75d843521c98ce55a161778d3498bc965567571cce87274a3d5edc",
    payload: { text: "ship M2 this week" },
    sensitivity: "normal",
    run_id: null,
    schema_version: 1,
    domain_key: "personal",
  };
}

describe("rowToEventEnvelope (the envelope↔column mapping point)", () => {
  it("maps snake_case columns to the camelCase envelope", () => {
    const envelope = rowToEventEnvelope(envelopeRow());
    expect(envelope).toEqual({
      id: "0191ec3f-7c2a-7b3e-a9b4-3f2e1d0c9b8a",
      type: "decision.recorded",
      schemaVersion: 1,
      source: "cli.capture",
      occurredAt: "2026-09-17T09:00:00.000Z",
      recordedAt: "2026-09-17T09:00:01.500Z",
      domainId: "personal",
      idempotencyKey: "73ca3f10da75d843521c98ce55a161778d3498bc965567571cce87274a3d5edc",
      sensitivity: "normal",
      payload: { text: "ship M2 this week" },
      runId: null,
    });
  });

  it("maps a present run_id uuid", () => {
    const row = envelopeRow();
    row.run_id = "12345678-1234-4234-8234-123456789abc";
    expect(rowToEventEnvelope(row).runId).toBe("12345678-1234-4234-8234-123456789abc");
  });

  it("accepts ISO strings where a driver did not parse timestamps", () => {
    const row = envelopeRow();
    row.occurred_at = "2026-09-17T09:00:00Z";
    expect(rowToEventEnvelope(row).occurredAt).toBe("2026-09-17T09:00:00.000Z");
  });

  it("refuses rows outside catalog v1 / the sensitivity vocabulary (corruption guard)", () => {
    expect(() => rowToEventEnvelope({ ...envelopeRow(), type: "email.received" })).toThrow(
      /non-catalog-v1 type/,
    );
    expect(() =>
      rowToEventEnvelope({ ...envelopeRow(), sensitivity: "ultra" }),
    ).toThrow(/unknown sensitivity/);
    expect(() => rowToEventEnvelope({ ...envelopeRow(), payload: null })).toThrow(
      /non-object payload/,
    );
  });
});
