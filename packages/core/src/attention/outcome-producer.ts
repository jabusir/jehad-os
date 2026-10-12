// Outcome attention producer (W1; ADR-0018 §4, w1-contract "Producer seam").
// Maps outcome transitions onto the durable attention set IN the transition
// transaction (the hook in outcomes/service.ts runs on the same db executor,
// so an attention failure rolls the transition back — no transition ever
// lands without its attention truth).
//
// The transition map (ADR-0018 §1.2 — completed outcomes open NO item):
//   waiting_user → outcome.ready item        blocked → outcome.blocked item
//   failed       → outcome.failed item       completed/cancelled → no item
// Leaving any attention-holding state resolves the held item (producer,
// reason `outcome_<toStatus>`); the failed item never auto-resolves — owner
// ack only — which is why the resolve runs BEFORE the open below.
//
// This module ALSO registers the `outcome` liveness resolver at module load
// (w1-contract "Resolvers"): importing outcomes/service.ts loads this file,
// so the resolver is registered before any attention flow can run.

import type { OutcomeRow, OutcomeStatus } from "../outcomes/service.js";
import type { AttentionDb } from "./service.js";
import { registerAttentionResolver } from "./resolvers.js";
import { openOrBumpOrReopen, resolveAttentionBySource } from "./service.js";
import type { AttentionResolver } from "./resolvers.js";
import { notifyAttentionItem } from "./delivery.js";
import type { OpenAttentionInput } from "./types.js";

/** Per-status producer spec: kind, identity fingerprint segment, copy. */
const PRODUCED_KINDS = {
  waiting_user: {
    kind: "outcome.ready",
    segment: "ready",
    titleSuffix: " — ready for your judgment",
    whyItMatters: "Delegated work needs your decision to continue.",
  },
  blocked: {
    kind: "outcome.blocked",
    segment: "blocked",
    titleSuffix: " — blocked",
    whyItMatters: "Delegated work is blocked and needs your attention.",
  },
  failed: {
    kind: "outcome.failed",
    segment: "failed",
    titleSuffix: " — failed",
    whyItMatters: "Delegated work failed.",
  },
} as const satisfies Record<
  "waiting_user" | "blocked" | "failed",
  { kind: "outcome.ready" | "outcome.blocked" | "outcome.failed"; segment: string; titleSuffix: string; whyItMatters: string }
>;

/**
 * The ONE producer seam, called by transitionOutcome after its canonical
 * event (same executor ⇒ atomic with the transition).
 *
 * db is transitionOutcome's OutcomeDb — a pg Pool (own transaction via
 * AttentionDb.connect) or a bare transaction client (the write rides the
 * caller's transaction; AttentionDb.connect is optional, service.ts header).
 */
export async function emitOutcomeAttention(
  db: AttentionDb,
  outcome: OutcomeRow,
  toStatus: OutcomeStatus,
  opts: { now: Date; actor: string },
): Promise<void> {
  // Resolve-first, LEAVING-only (ADR-0018 §1.5): each held item closes when
  // the outcome LEAVES its state — entering blocked resolves the ready item;
  // entering waiting_user resolves a held blocked item; any other status
  // resolves every held item of the outcome. A producer dispatch that does
  // not change the held state (the common replay) resolves nothing —
  // resolve-then-reopen would re-deliver on identical occurrences.
  // Resolving before the open guarantees the just-opened item (in
  // particular outcome.failed) is never the row resolved here.
  const heldFingerprint = (segment: string): string => `outcome:${outcome.id}:${segment}`;
  if (toStatus === "blocked") {
    await resolveAttentionBySource(db, outcome.principalId, "outcome", outcome.id, {
      now: opts.now, actor: opts.actor, by: "producer",
      reason: `outcome_${toStatus}`, fingerprint: heldFingerprint("ready"),
    });
  } else if (toStatus === "waiting_user") {
    await resolveAttentionBySource(db, outcome.principalId, "outcome", outcome.id, {
      now: opts.now, actor: opts.actor, by: "producer",
      reason: `outcome_${toStatus}`, fingerprint: heldFingerprint("blocked"),
    });
  } else {
    await resolveAttentionBySource(db, outcome.principalId, "outcome", outcome.id, {
      now: opts.now, actor: opts.actor, by: "producer",
      reason: `outcome_${toStatus}`,
    });
  }
  const spec = PRODUCED_KINDS[toStatus as keyof typeof PRODUCED_KINDS];
  if (spec === undefined) return; // completed/cancelled/everything else: no item (ADR-0018 §1.2)
  const summary = outcome.directive.trim().length > 0 ? outcome.directive.trim() : outcome.title;
  const input: OpenAttentionInput = {
    principalId: outcome.principalId,
    sourceType: "outcome",
    sourceObjectId: outcome.id,
    fingerprint: `outcome:${outcome.id}:${spec.segment}`,
    kind: spec.kind,
    level: "inbox",
    title: `${outcome.title}${spec.titleSuffix}`,
    summary,
    whyItMatters: spec.whyItMatters,
    evidenceRefs: [{ type: "outcome", id: outcome.ref }],
    actions: [
      { key: "outcome.open", args: { ref: outcome.ref } },
      { key: "attention.resolve" },
    ],
    // Occurrence identity = outcome id + status (ADR-0018 §1.4): replays of
    // the same occurrence never re-notify; a re-entry with a fresh timestamp
    // does.
    changeFingerprint: `${outcome.id}:${toStatus}:${opts.now.toISOString()}`,
  };
  const result = await openOrBumpOrReopen(db, input, { now: opts.now, actor: opts.actor });
  if (result.deliverNow) {
    await notifyAttentionItem(db, result.item, { now: opts.now });
  }
}

// ------------------------------------------------- liveness resolver (W1)

const outcomeAttentionResolver: AttentionResolver = async (db, item) => {
  if (item.kind !== "outcome.ready" && item.kind !== "outcome.blocked" && item.kind !== "outcome.failed") {
    return "unknown"; // not an outcome-held condition — never closed by this resolver
  }
  const found = await db.query(`SELECT status FROM outcomes WHERE id = $1::uuid LIMIT 1`, [
    item.sourceObjectId,
  ]);
  const row = found.rows[0] as { status: string } | undefined;
  if (row === undefined) return "unknown"; // unknown outcome — never closes (fail-closed)
  if (item.kind === "outcome.failed") return "live"; // owner-ack only
  if (item.kind === "outcome.ready") return row.status === "waiting_user" ? "live" : "gone";
  return row.status === "blocked" ? "live" : "gone";
};

// Module-load registration (idempotent per the resolvers contract): every
// importer of this module — outcomes/service.ts first among them — arms the
// outcome resolver before any liveness sweep can run.
registerAttentionResolver("outcome", outcomeAttentionResolver);
