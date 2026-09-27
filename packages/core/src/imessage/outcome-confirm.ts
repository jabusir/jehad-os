// Shell-trust R2 (docs/plans/shell-trust.md) — the outcome_spec confirm
// token lane. §22.4 documented a system-issued token for consequential
// parks; it was never built, which is why delegation could park but never
// apply on the single path (the other half of the 14:14 chain).
//
// Semantics (owner amendments 2 + 3):
//   - The token is calendar-grade: 5-char Crockford, normalizeConfirmToken
//     normalization, minted at park time by the outcome_spec executor.
//   - `/new` clears CONVERSATIONAL context, never a live approval: parks
//     live in thread metadata which survives thread closure, so resolution
//     spans the principal's active AND closed threads until the 24h expiry.
//   - Three resolution classes (review-ref semantics):
//       found-and-live    → apply via applyOutcomeSpec (observed result)
//       found-but-expired → honest expired notice, NO bad-ref count
//       found-nowhere     → honest unknown reply that COUNTS toward the
//                           brute lockout (3/rolling-hour, cool-down +
//                           owner alert then silent drop — audited
//                           separately from calendar refs)
//   - accepted ≠ dispatched ≠ running: the confirm reply is
//     applyOutcomeSpec's OBSERVED narration (outcome accepted [ref]; the
//     dispatch note states the executor's actual result) — canonical
//     creation alone never authorizes "underway".
import type { SqlExecutor } from "../actions/audit.js";
import { recordAudit } from "../actions/audit.js";
import { normalizeConfirmToken } from "./calendar-actions.js";
import {
  isPendingExpired,
  parseThreadMetadata,
  setThreadPendingProposals,
  type ThreadPendingProposal,
} from "./threads.js";
import { applyOutcomeSpec, coerceProposal, type ApplyOutcomeSpecResult } from "./turn-interpretation.js";
import {
  outcomesPolicyOf,
  DEFAULT_OUTCOMES_POLICY,
  type PolicyV1,
  type OutcomesPolicy,
} from "../policy/ceiling.js";

/** Mirrors the review-ref cap (3/rolling-hour) — same machinery, own audit
 *  action, so calendar refs and outcome tokens are readable apart. */
export const OUTCOME_TOKEN_MAX_BAD_REFS = 3;

const OUTCOME_TOKEN_UNKNOWN_REPLY =
  "That confirmation code doesn't match anything waiting on my side — nothing was changed. Check the code in the offer, or just ask me what's staged.";
const OUTCOME_TOKEN_EXPIRED_REPLY =
  "That offer's confirmation code has expired — nothing was changed. Ask me to re-stage it and confirm the new code.";
const OUTCOME_TOKEN_COOLDOWN_REPLY =
  "Too many wrong confirmation codes — I'm pausing code confirmations for a bit. Nothing was changed.";
const OUTCOME_TOKEN_CANCELLED_REPLY =
  "Dropped — that delegation was cancelled before anything started. Nothing is running.";
const OUTCOME_TOKEN_AMBIGUOUS_REPLY =
  "More than one delegation is staged — reply with its code, like: confirm XW1MS.";
const OUTCOME_TOKEN_NONE_REPLY = "Nothing is staged for confirmation right now.";

interface ParkHit {
  readonly threadId: string;
  readonly entry: ThreadPendingProposal;
  readonly expired: boolean;
}

async function findParkHits(
  db: SqlExecutor,
  input: { readonly principalId: string; readonly token: string | null; readonly now: Date },
): Promise<readonly ParkHit[]> {
  // Discovery window: 49h — parks live 24h, so a park minted at the last
  // instant must stay discoverable past its own expiry (honest "expired"
  // beats "unknown"); 49h covers expiry + a re-observation window.
  const windowStart = new Date(input.now.getTime() - 49 * 3_600_000).toISOString();
  const rows = await db.query(
    `SELECT id, metadata FROM interaction_threads
      WHERE principal_id = $1::uuid AND surface = 'imessage'
        AND last_activity_at >= $2::timestamptz
        AND metadata->'pendingProposals' IS NOT NULL
      ORDER BY last_activity_at DESC
      LIMIT 50`,
    [input.principalId, windowStart],
  );
  const hits: ParkHit[] = [];
  for (const row of rows.rows as readonly Record<string, unknown>[]) {
    const metadata = parseThreadMetadata(row.metadata ?? null);
    const entries = metadata?.pendingProposals ?? [];
    for (const entry of entries) {
      if (entry.type !== "outcome_spec" || entry.confirmToken === undefined) continue;
      if (input.token !== null && entry.confirmToken !== input.token) continue;
      hits.push({
        threadId: String(row.id),
        entry,
        expired: isPendingExpired(entry, input.now),
      });
    }
  }
  return hits;
}

async function auditOutcomeToken(
  db: SqlExecutor,
  action: string,
  outputs: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await recordAudit(db, {
    actor: "system:imessage-gateway",
    action,
    reversible: true,
    outputsRef: JSON.stringify({ ...outputs, at: now.toISOString() }),
  });
}

async function auditCount(
  db: SqlExecutor,
  action: "imessage.outcome_token.bad_ref" | "imessage.outcome_token.cooldown",
  principalId: string,
  hourStartIso: string,
): Promise<number> {
  const result = await db.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE action = $1
        AND outputs_ref::jsonb->>'at' >= $2
        AND outputs_ref::jsonb->>'principalId' = $3`,
    [action, hourStartIso, principalId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Sole-live outcome parks (bare-verb resolution, joint with calendar's). */
export async function soleLiveOutcomeParks(
  db: SqlExecutor,
  input: { readonly principalId: string; readonly now: Date },
): Promise<
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "sole"; readonly hit: ParkHit }
> {
  const hits = (await findParkHits(db, { ...input, token: null })).filter((hit) => !hit.expired);
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous" };
  return { kind: "sole", hit: hits[0]! };
}

async function removePark(
  db: SqlExecutor,
  input: { readonly principalId: string; readonly hit: ParkHit; readonly now: Date },
): Promise<void> {
  const row = await db.query(`SELECT metadata FROM interaction_threads WHERE id = $1::uuid`, [
    input.hit.threadId,
  ]);
  const metadata = parseThreadMetadata(row.rows[0]?.metadata ?? null);
  // Identity is the STAMPED id (stable across re-parses), never object
  // identity — parseThreadMetadata mints fresh objects each read.
  const survivors = (metadata?.pendingProposals ?? []).filter(
    (entry) => (entry.id ?? `${entry.type}:${entry.at}`) !== (input.hit.entry.id ?? `${input.hit.entry.type}:${input.hit.entry.at}`),
  );
  await setThreadPendingProposals(db, {
    threadId: input.hit.threadId,
    principalId: input.principalId,
    pending: survivors.length > 0 ? survivors : null,
    now: input.now,
  });
}

export interface OutcomeTokenLaneInput {
  readonly principalId: string;
  readonly token: string | null;
  readonly now: Date;
  readonly policyFile: PolicyV1 | null;
  readonly dispatch?: (input: { outcomeId: string; ref: string }) => Promise<string>;
}

export type OutcomeTokenResult =
  | { readonly status: "unknown" | "expired" | "ambiguous" | "cooldown" | "none"; readonly reply: string }
  | { readonly status: "cancelled"; readonly reply: string }
  | { readonly status: "applied"; readonly reply: string; readonly result: ApplyOutcomeSpecResult };

/** `confirm <TOKEN>` (or bare sole-live) for an outcome_spec park. Unknown
 *  tokens count toward the lockout; expired ones never do. */
export async function confirmOutcomeToken(
  db: SqlExecutor,
  input: OutcomeTokenLaneInput,
): Promise<OutcomeTokenResult> {
  const token = input.token === null ? null : normalizeConfirmToken(input.token);
  if (input.token !== null && token === null) {
    return { status: "unknown", reply: OUTCOME_TOKEN_UNKNOWN_REPLY };
  }
  const hourStart = new Date(input.now.getTime() - 3_600_000).toISOString();
  const badCount = await auditCount(db, "imessage.outcome_token.bad_ref", input.principalId, hourStart);
  if (badCount >= OUTCOME_TOKEN_MAX_BAD_REFS) {
    const noticed = await auditCount(db, "imessage.outcome_token.cooldown", input.principalId, hourStart);
    await auditOutcomeToken(
      db,
      "imessage.outcome_token.cooldown",
      { principalId: input.principalId, badRefCount: badCount, token },
      input.now,
    );
    return noticed === 0
      ? { status: "cooldown", reply: OUTCOME_TOKEN_COOLDOWN_REPLY }
      : { status: "cooldown", reply: "" }; // silent drop (audit only)
  }

  const hits = await findParkHits(db, { principalId: input.principalId, token, now: input.now });
  const live = hits.filter((hit) => !hit.expired);
  if (live.length === 0) {
    if (token === null) return { status: "none", reply: OUTCOME_TOKEN_NONE_REPLY };
    if (hits.length > 0) {
      // found-but-expired: honest notice, never an attack count
      return { status: "expired", reply: OUTCOME_TOKEN_EXPIRED_REPLY };
    }
    await auditOutcomeToken(
      db,
      "imessage.outcome_token.bad_ref",
      { principalId: input.principalId, token },
      input.now,
    );
    return { status: "unknown", reply: OUTCOME_TOKEN_UNKNOWN_REPLY };
  }
  if (live.length > 1) return { status: "ambiguous", reply: OUTCOME_TOKEN_AMBIGUOUS_REPLY };
  const hit = live[0]!;
  // The parked payload is unknown-typed metadata — coerce exactly like the
  // legacy confirm lane (fail-closed to the honest invalid reply).
  const coerced = coerceProposal(hit.entry.payload);
  if (coerced === null || coerced.type !== "outcome_spec") {
    await removePark(db, { principalId: input.principalId, hit, now: input.now });
    await auditOutcomeToken(
      db,
      "imessage.outcome_token.confirmed",
      { principalId: input.principalId, token: hit.entry.confirmToken ?? null, applied: false, reason: "invalid-proposal" },
      input.now,
    );
    return {
      status: "applied",
      reply: "That delegation didn't parse cleanly — nothing was started.",
      result: {
        applied: false,
        reason: "invalid-proposal",
        reply: "That delegation didn't parse cleanly — nothing was started.",
        ref: null,
        outcomeId: null,
      },
    };
  }

  const policy: OutcomesPolicy =
    input.policyFile === null ? DEFAULT_OUTCOMES_POLICY : outcomesPolicyOf(input.policyFile);
  const applied = await applyOutcomeSpec(db, {
    proposal: coerced,
    principalId: input.principalId,
    policy,
    ...(input.dispatch !== undefined ? { dispatch: input.dispatch } : {}),
    sourceThreadId: hit.threadId,
    now: input.now,
  });
  // A refused apply (policy off / cap reached) keeps the offer pending so
  // the owner can resolve and retry (the legacy confirm-lane rule).
  if (applied.applied || applied.reason === "invalid-proposal") {
    await removePark(db, { principalId: input.principalId, hit, now: input.now });
  }
  await auditOutcomeToken(
    db,
    "imessage.outcome_token.confirmed",
    {
      principalId: input.principalId,
      token: hit.entry.confirmToken ?? null,
      applied: applied.applied,
      reason: applied.reason ?? null,
    },
    input.now,
  );
  return { status: "applied", reply: applied.reply, result: applied };
}

/** `cancel <TOKEN>` (or bare sole-live) — drops the park, nothing ever ran. */
export async function cancelOutcomeToken(
  db: SqlExecutor,
  input: Omit<OutcomeTokenLaneInput, "dispatch">,
): Promise<OutcomeTokenResult> {
  const token = input.token === null ? null : normalizeConfirmToken(input.token);
  if (input.token !== null && token === null) {
    return { status: "unknown", reply: OUTCOME_TOKEN_UNKNOWN_REPLY };
  }
  const hits = await findParkHits(db, { principalId: input.principalId, token, now: input.now });
  const live = hits.filter((hit) => !hit.expired);
  if (live.length === 0) {
    if (token === null) return { status: "none", reply: OUTCOME_TOKEN_NONE_REPLY };
    if (hits.length > 0) return { status: "expired", reply: OUTCOME_TOKEN_EXPIRED_REPLY };
    const hourStart = new Date(input.now.getTime() - 3_600_000).toISOString();
    const badCount = await auditCount(db, "imessage.outcome_token.bad_ref", input.principalId, hourStart);
    if (badCount >= OUTCOME_TOKEN_MAX_BAD_REFS) {
      return { status: "cooldown", reply: "" };
    }
    await auditOutcomeToken(
      db,
      "imessage.outcome_token.bad_ref",
      { principalId: input.principalId, token },
      input.now,
    );
    return { status: "unknown", reply: OUTCOME_TOKEN_UNKNOWN_REPLY };
  }
  if (live.length > 1) return { status: "ambiguous", reply: OUTCOME_TOKEN_AMBIGUOUS_REPLY };
  const hit = live[0]!;
  await removePark(db, { principalId: input.principalId, hit, now: input.now });
  await auditOutcomeToken(
    db,
    "imessage.outcome_token.cancelled",
    { principalId: input.principalId, token: hit.entry.confirmToken ?? null },
    input.now,
  );
  return { status: "cancelled", reply: OUTCOME_TOKEN_CANCELLED_REPLY };
}
