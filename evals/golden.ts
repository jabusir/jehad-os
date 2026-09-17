/**
 * Shared golden-set loading + envelope construction (used by BOTH eval
 * tiers so hermetic and live score the exact same items through the exact
 * same pipeline — docs/evals.md §3.1). golden-set.json itself is read-only
 * data; this module only loads/validates it.
 *
 * v2 (lane W6B): version 2 expected shape — temporal_expression /
 * resolved_due_date / resolution_status instead of due_date, plus
 * commitment_state on every item (candidate-contract.ts).
 */

import { readFileSync } from "node:fs";
import type { EventEnvelope } from "@jehad/core";
import type { GoldenItem, GoldenSet, ResolutionStatus } from "./metrics.js";

export const GOLDEN_SET_VERSION = 2;

const RESOLUTION_STATUSES: readonly ResolutionStatus[] = ["resolved", "ambiguous", "unsupported", "none"];
const COMMITMENT_STATES: readonly string[] = [
  "prospective",
  "active",
  "completed",
  "historical",
  "renegotiated",
  "cancelled",
  "hypothetical",
];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function loadGoldenSet(path: string): GoldenSet {
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null) throw new Error("golden set: not an object");
  const set = raw as Partial<GoldenSet>;
  if (set.version !== GOLDEN_SET_VERSION || !Array.isArray(set.items) || set.items.length === 0) {
    throw new Error(`golden set: expected version ${GOLDEN_SET_VERSION} with a non-empty items array`);
  }
  for (const item of set.items) {
    if (
      typeof item.id !== "string" ||
      typeof item.category !== "string" ||
      typeof item.occurredAt !== "string" ||
      typeof item.text !== "string" ||
      typeof item.expected?.is_commitment !== "boolean"
    ) {
      throw new Error(`golden set: item missing required fields: ${JSON.stringify(item).slice(0, 80)}`);
    }
    const e = item.expected;
    if (
      e.commitment_state === undefined ||
      typeof e.commitment_state !== "string" ||
      !COMMITMENT_STATES.includes(e.commitment_state)
    ) {
      throw new Error(`golden set: item ${item.id}: commitment_state must be one of ${COMMITMENT_STATES.join("|")}`);
    }
    if (e.resolution_status === undefined || !RESOLUTION_STATUSES.includes(e.resolution_status)) {
      throw new Error(`golden set: item ${item.id}: resolution_status must be one of ${RESOLUTION_STATUSES.join("|")}`);
    }
    if (e.temporal_expression === undefined || typeof e.temporal_expression !== "string") {
      if (e.temporal_expression !== null) {
        throw new Error(`golden set: item ${item.id}: temporal_expression must be a string or null`);
      }
    }
    if (e.resolved_due_date !== null && e.resolved_due_date !== undefined && !ISO_DATE.test(e.resolved_due_date)) {
      throw new Error(`golden set: item ${item.id}: resolved_due_date must be an ISO date or null`);
    }
    if (e.resolution_status === "resolved" && typeof e.resolved_due_date !== "string") {
      throw new Error(`golden set: item ${item.id}: resolved status requires a resolved_due_date`);
    }
    if (e.resolution_status !== "resolved" && e.resolved_due_date !== null) {
      throw new Error(`golden set: item ${item.id}: non-resolved status requires resolved_due_date null`);
    }
    if (e.resolution_status === "none" && e.temporal_expression !== null) {
      throw new Error(`golden set: item ${item.id}: none status requires temporal_expression null`);
    }
  }
  return raw as GoldenSet;
}

export function loadDefaultGoldenSet(): GoldenSet {
  return loadGoldenSet(new URL("./golden-set.json", import.meta.url).pathname);
}

/**
 * The synthetic capture event for a golden item. `runId` is null for the
 * hermetic tier; the live tier passes its isolated-db run row id so every
 * callModel dispatch lands in the model_calls ledger (plan §7/§14).
 */
export function envelopeFor(item: GoldenItem, index: number, runId: string | null = null): EventEnvelope {
  const suffix = String(index + 1).padStart(4, "0");
  return {
    id: `018f0000-0000-7000-8000-00000000${suffix}`,
    type: "capture.recorded",
    schemaVersion: 1,
    source: "cli.capture",
    occurredAt: item.occurredAt,
    recordedAt: item.occurredAt,
    domainId: "personal",
    idempotencyKey: `eval-${suffix}`,
    sensitivity: "normal",
    payload: { text: item.text },
    runId,
  };
}
