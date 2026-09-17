/**
 * CLI capture SourceAdapter (plan §13; plan §15 M2) — the Phase-1 concrete
 * implementation of the SourceAdapter port. `josctl capture` / `josctl decide`
 * normalize explicit user capture into catalog-v1 events
 * (`capture.recorded` / `decision.recorded`).
 *
 * Idempotency rule (plan §8): the adapter mints a FRESH uuid external id per
 * invocation — identical words captured twice are two real-world occurrences,
 * two events, never a dedupe. Redelivery/retry is the caller's concern (it
 * reuses the returned externalId), not this adapter's.
 */

import { randomUUID } from "node:crypto";
import type {
  NormalizedExternalEvent,
  Sensitivity,
  SourceAdapter,
} from "../ports/source-adapter.js";

export const CLI_CAPTURE_SOURCE = "cli.capture";

export type CliCaptureKind = "capture" | "decide";

export interface CliCaptureInput {
  /** capture → capture.recorded; decide → decision.recorded. */
  readonly kind: CliCaptureKind;
  readonly text: string;
  /** Domain key; defaults to "personal" (first vertical slice). */
  readonly domainId?: string;
  /** ISO 8601; defaults to now. */
  readonly occurredAt?: string;
  readonly sensitivity?: Sensitivity;
}

const EVENT_TYPE_BY_KIND: Readonly<Record<CliCaptureKind, string>> = {
  capture: "capture.recorded",
  decide: "decision.recorded",
};

/** Normalizes one CLI capture invocation; throws TypeError on bad input. */
export function normalizeCliCapture(raw: unknown): NormalizedExternalEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("cli-capture: input must be a CliCaptureInput object");
  }
  const input = raw as Partial<CliCaptureInput>;

  const kind = input.kind;
  if (kind !== "capture" && kind !== "decide") {
    throw new TypeError(`cli-capture: kind must be "capture" or "decide"`);
  }

  if (typeof input.text !== "string") {
    throw new TypeError("cli-capture: text must be a string");
  }
  const text = input.text.trim();
  if (text.length === 0) {
    throw new TypeError("cli-capture: text must not be empty");
  }

  const domainId = input.domainId ?? "personal";
  if (
    typeof domainId !== "string" ||
    domainId.trim().length === 0 ||
    domainId !== domainId.trim()
  ) {
    throw new TypeError("cli-capture: domainId must be a non-empty domain key");
  }

  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (typeof occurredAt !== "string" || !occurredAt.includes("T") || !Number.isFinite(Date.parse(occurredAt))) {
    throw new TypeError("cli-capture: occurredAt must be an ISO 8601 datetime string");
  }

  const sensitivity = input.sensitivity ?? "normal";
  if (sensitivity !== "normal" && sensitivity !== "sensitive" && sensitivity !== "secret") {
    throw new TypeError('cli-capture: sensitivity must be "normal", "sensitive", or "secret"');
  }

  return {
    type: EVENT_TYPE_BY_KIND[kind],
    source: CLI_CAPTURE_SOURCE,
    externalId: randomUUID(),
    occurredAt,
    domainId,
    sensitivity,
    payload: { text },
  };
}

/** The SourceAdapter port implementation for josctl capture/decide. */
export const cliCaptureSourceAdapter: SourceAdapter = {
  id: CLI_CAPTURE_SOURCE,
  normalizeExternal: normalizeCliCapture,
};
