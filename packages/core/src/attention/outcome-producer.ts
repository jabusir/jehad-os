// Outcome attention producer (W1; ADR-0018 §4, w1-contract "Producer seam";
// W1.1 findings 1+3+4). DURABLE part only: emitOutcomeAttention runs inside
// the transition transaction (resolve-first + the 3-branch write) and returns
// the delivery decision — the ENQUEUE itself happens after the durable truth
// commits, best-effort (deliverOutcomeAttentionNow), because a delivery
// failure must never make a committed canonical transition appear failed;
// attention-liveness recovers any missed enqueue (retryEligibleUndelivered).
//
// Kill switch (W1.1 finding 4): policy.yaml attention.enabled=false stops
// production BEFORE any durable write — canonical outcomes flow unchanged,
// no item, no notification. Existing rows untouched; restart-with-true
// resumes (notifications-config lifecycle, attention/policy.ts).
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
import { loadAttentionPolicy, type AttentionPolicy } from "./policy.js";
import { recordAudit } from "../actions/audit.js";
import type { AttentionItemRow, OpenAttentionInput } from "./types.js";

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
export interface ProducedAttention {
  readonly item: AttentionItemRow;
  readonly deliverNow: boolean;
}

export async function emitOutcomeAttention(
  db: AttentionDb,
  outcome: OutcomeRow,
  toStatus: OutcomeStatus,
  opts: { now: Date; actor: string; policy?: AttentionPolicy },
): Promise<ProducedAttention | null> {
  // Kill switch first (W1.1 finding 4): a disabled subsystem produces
  // nothing — before ANY durable write, before any resolve.
  const policy = opts.policy ?? (await loadAttentionPolicy());
  if (!policy.enabled) return null;
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
  if (spec === undefined) return null; // completed/cancelled/everything else: no item (ADR-0018 §1.2)
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
    // W1 controls (W1.1 finding 3): the full direct-control set an outcome
    // card needs in Today — open the canonical outcome, resolve, snooze,
    // dismiss, and one-tap verdicts. Rendered through the action registry;
    // /ui/action authorizes against THESE stored refs (finding 5).
    actions: [
      { key: "outcome.open", args: { ref: outcome.ref } },
      { key: "attention.resolve" },
      { key: "attention.snooze" },
      { key: "attention.dismiss" },
      { key: "attention.feedback", args: { verdict: "useful" } },
      { key: "attention.feedback", args: { verdict: "noise" } },
      { key: "attention.feedback", args: { verdict: "interruptive" } },
    ],
    // Occurrence identity = outcome id + status (ADR-0018 §1.4): replays of
    // the same occurrence never re-notify; a re-entry with a fresh timestamp
    // does.
    changeFingerprint: `${outcome.id}:${toStatus}:${opts.now.toISOString()}`,
  };
  const result = await openOrBumpOrReopen(db, input, { now: opts.now, actor: opts.actor });
  return { item: result.item, deliverNow: result.deliverNow };
}

/**
 * Best-effort delivery AFTER the durable truth is committed (W1.1 finding 1):
 * a failed enqueue is caught and made observable (audit) — the committed
 * transition never appears failed, and attention-liveness re-enqueues any
 * item that was never delivered (retryEligibleUndelivered). On the
 * caller-owned-transaction path the caller may instead run this INSIDE its
 * transaction so the notification rolls back with the truth; either way a
 * throw here never propagates.
 */
export async function deliverOutcomeAttentionNow(
  db: AttentionDb,
  item: AttentionItemRow,
  opts: { now: Date; policy?: AttentionPolicy },
): Promise<void> {
  try {
    await notifyAttentionItem(db, item, { now: opts.now });
  } catch (err) {
    await recordAudit(db, {
      actor: "system/attention-delivery",
      action: "attention.enqueue_failed",
      reversible: true,
      outputsRef: JSON.stringify({ itemId: item.id, error: (err as Error)?.message ?? "unknown" }),
    });
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
