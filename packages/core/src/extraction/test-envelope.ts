// Shared hermetic test fixture: a well-formed capture envelope.
import type { EventEnvelope } from "../events/envelope.js";

export function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "018f0000-0000-7000-8000-000000000001",
    type: "capture.recorded",
    schemaVersion: 1,
    source: "cli.capture",
    occurredAt: "2026-09-17T09:00:00.000Z",
    recordedAt: "2026-09-17T09:00:01.000Z",
    domainId: "personal",
    idempotencyKey: "a".repeat(64),
    sensitivity: "normal",
    payload: { text: "I'll send Jehad the migration plan Friday." },
    runId: null,
    ...overrides,
  };
}
