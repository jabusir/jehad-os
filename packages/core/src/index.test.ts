import { describe, expect, it } from "vitest";

describe("@jehad/core", () => {
  it("module loads (M0 smoke; M2 exports the events surface)", async () => {
    const mod = await import("./index.js");
    expect(Object.keys(mod).sort()).toEqual([
      "DomainNotFoundError",
      "EVENT_CATALOG_V1",
      "LATEST_PAYLOAD_SCHEMA_VERSION",
      "SENSITIVITY_V1",
      "SOURCE_RE",
      "UUID_RE",
      "acceptEvent",
      "getEventById",
      "getEventEnvelopesByIds",
      "idempotencyKeyFor",
      "isCatalogV1EventTypeName",
      "mintEventId",
      "rowToEventEnvelope",
      "validateEventIngest",
    ]);
  });
});
