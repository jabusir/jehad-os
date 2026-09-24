/**
 * Deterministic memory-candidate ids, shared by the live candidate writers
 * (imessage capture, turn interpretation, gmail extraction). The M5B
 * model-call batch-extraction lane was deleted (intelligence-reset §11 C10);
 * the promotion pipeline and candidate contract live elsewhere.
 */

import { createHash } from "node:crypto";
import type { MemoryCandidateContract } from "../memory/candidate-contract.js";

/**
 * Deterministic candidate id: sha256(source event id + proposed class +
 * assertion kind + payload). Same source event + same extraction output →
 * same id → the INSERT's ON CONFLICT DO NOTHING makes redelivery a no-op.
 */
export function deterministicCandidateId(contract: MemoryCandidateContract): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        contract.provenance.sourceEventId,
        contract.proposedClass,
        contract.assertionKind,
        contract.payload,
      ]),
      "utf-8",
    )
    .digest("hex");
  const hex = hash.slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
