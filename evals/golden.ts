/**
 * Shared golden-set loading + envelope construction (used by BOTH eval
 * tiers so hermetic and live score the exact same items through the exact
 * same pipeline — docs/evals.md §3.1). golden-set.json itself is read-only
 * data; this module only loads/validates it.
 */

import { readFileSync } from "node:fs";
import type { EventEnvelope } from "@jehad/core";
import type { GoldenItem, GoldenSet } from "./metrics.js";

export function loadGoldenSet(path: string): GoldenSet {
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null) throw new Error("golden set: not an object");
  const set = raw as Partial<GoldenSet>;
  if (set.version !== 1 || !Array.isArray(set.items) || set.items.length === 0) {
    throw new Error("golden set: expected version 1 with a non-empty items array");
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
