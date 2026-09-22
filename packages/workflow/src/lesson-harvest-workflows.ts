/**
 * SV3 nightly grounded harvest → LESSONS ("lesson-harvest",
 * feedback-and-self-verification.md §SV3, lane sv-lessons): one deterministic
 * pass over the last 24h of audit_log — NO model calls, NO transcript prose
 * scanning (v1 contract). Distills candidate lessons through proposeLesson
 * (verdict='proposed'); the owner ratifies through the W4 gate; the LESSONS
 * block injection is the answer-prompt lane's job, not this file's.
 *
 * Signals (deterministic aggregation over structured JSONB contracts):
 *  - `converse.claim_audit` ledger (SV): outputs_ref { claim_type,
 *    original_claim, verification_basis, remediation, revision_attempted,
 *    revision_passed }. Every row carrying a remediation IS a found mismatch
 *    (deterministic_replace | model_revision | safe_fallback); rows without
 *    one are passes (e.g. unverified) and never become lessons. ANY
 *    claim_type with ≥ CLAIM_MISMATCH_THRESHOLD mismatches in the window, or
 *    a single safe_fallback, proposes "answers drift on <claim_type>".
 *  - SV4 dead letters: `notification.expired` audit rows whose
 *    notificationId resolves to an expired, never-delivered ratified-kind
 *    row (calibration | grant-reminder | calendar-change — the F3 scope).
 *    ≥ EXPIRED_RATIFIED_THRESHOLD proposes one undelivered lesson.
 *  - SV4 denial spikes: `imessage.converse.rate-limited` rows carry
 *    principalId in outputs_ref; ≥ RATE_LIMIT_THRESHOLD per principal
 *    proposes a budget lesson FOR THAT PRINCIPAL.
 *
 * Idempotency: proposeLesson dedupes on ('lesson', subject) — re-running the
 * tick refreshes note/updated_at on the existing row instead of duplicating.
 *
 * Scope (labeled default, owner veto = one line): claim/dead-letter lessons
 * are attributed to every gateway conversation principal in policy.yaml
 * (gateway.principals keys, resolved to ids per tick); rate-limit lessons to
 * the principal the denial rows name. An unresolvable/empty scope is a clean
 * no-op tick, never an error.
 *
 * TIME-WINDOW SEMANTICS (brief-workflows pattern): hourly cron "30 * * * *"
 * guarded to 03:30 local (low-traffic hour, owner timezone, DST-safe via
 * Intl); every other firing is a no-op before any step. Each firing builds
 * its own pg pool from DATABASE_URL inside a memoized step.
 */

import { Pool } from "pg";
import {
  civilDateOf,
  parsePolicyV1,
  proposeLesson,
  UUID_RE,
  type SqlExecutor,
} from "@jehad/core";
import { isLocalHour } from "./brief-workflows.js";
import { defineScheduledWorkflow, type ScheduledWorkflowDefinition } from "./definition.js";

export const LESSON_HARVEST_CRON = "30 * * * *";
/** The local hour of "03:30 local" — the :30 is pinned by the cron. */
export const LESSON_HARVEST_LOCAL_HOUR = 3;
/** Rolling aggregation window (the plan's "last 24h"). */
export const LESSON_HARVEST_WINDOW_HOURS = 24;
/** A claim_type needs at least this many mismatches to earn a lesson. */
export const CLAIM_MISMATCH_THRESHOLD = 2;
/** A single safe fallback already earns the claim_type a lesson. */
export const SAFE_FALLBACK_THRESHOLD = 1;
/** Expired-undelivered ratified notifications: one is already a lesson. */
export const EXPIRED_RATIFIED_THRESHOLD = 1;
/** Rate-limit denials must repeat this often (per principal) to earn one. */
export const RATE_LIMIT_THRESHOLD = 3;
/** The F3 dead-letter scope: ratified (auto-approved) notification kinds. */
export const RATIFIED_SENTINEL_KINDS: readonly string[] = [
  "calibration",
  "grant-reminder",
  "calendar-change",
];

const SAFE_FALLBACK = "safe_fallback";

export const CLAIM_DRIFT_SUBJECT_PREFIX = "answers drift on";
export const EXPIRED_RATIFIED_SUBJECT = "ratified notifications expire undelivered";
export const RATE_LIMIT_SUBJECT = "reply budget denials repeat";

export interface LessonHarvestResult {
  readonly proposed: number;
  readonly refreshed: number;
  readonly claimAuditRows: number;
  readonly expiredRatified: number;
  readonly rateLimited: number;
  readonly scope: readonly string[];
}

/** One claim_type's 24h mismatch evidence. */
export interface ClaimTypeEvidence {
  readonly claimType: string;
  /** Ledger rows carrying a remediation — each IS a found mismatch. */
  readonly mismatches: number;
  readonly safeFallbacks: number;
  /** Owner-local civil dates of the mismatch rows, ascending. */
  readonly dates: readonly string[];
  /** The audit_log ids behind the mismatches (lesson provenance). */
  readonly auditIds: readonly string[];
}

/** A distilled candidate the tick proposes per scope principal. */
export interface LessonCandidate {
  readonly subject: string;
  readonly note: string;
  readonly sourceRefs: readonly string[];
}

interface AuditRefRow {
  readonly id: string;
  readonly occurredAt: Date;
  readonly ref: Record<string, unknown> | null;
}

function resolveNow(now?: Date | (() => Date)): Date {
  if (now === undefined) return new Date();
  return now instanceof Date ? now : now();
}

/** Load the last-24h rows of one audit action, parsing outputs_ref defensively. */
async function loadAuditRefs(
  db: SqlExecutor,
  action: string,
  sinceIso: string,
): Promise<AuditRefRow[]> {
  const rows = await db.query(
    `SELECT id, occurred_at, outputs_ref FROM audit_log
      WHERE action = $1 AND occurred_at >= $2::timestamptz
      ORDER BY occurred_at ASC, id ASC`,
    [action, sinceIso],
  );
  return rows.rows.map((row) => {
    let ref: Record<string, unknown> | null = null;
    if (typeof row.outputs_ref === "string" && row.outputs_ref.length > 0) {
      try {
        const parsed: unknown = JSON.parse(row.outputs_ref);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          ref = parsed as Record<string, unknown>;
        }
      } catch {
        ref = null; // malformed provenance — counted, never crash the tick
      }
    }
    return { id: String(row.id), occurredAt: new Date(row.occurred_at as unknown as string), ref };
  });
}

/**
 * Ledger contract normalizer: claim_type collapses to [a-z0-9_-] so a
 * drifted vocabulary can never shape a subject; null → skip the row.
 */
export function normalizeClaimType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length === 0 ? null : cleaned;
}

function civilDatesOf(rows: readonly AuditRefRow[]): string[] {
  return [...new Set(rows.map((row) => civilDateOf(row.occurredAt)))].sort();
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/**
 * Pure distillation: claim-audit refs → per-claim_type evidence →
 * candidates. Exported for deterministic tests. A claim_type passes when it
 * hit CLAIM_MISMATCH_THRESHOLD mismatches OR any single safe fallback.
 */
export function aggregateClaimAudits(refs: readonly AuditRefRow[]): {
  claimAuditRows: number;
  evidence: readonly ClaimTypeEvidence[];
  candidates: readonly LessonCandidate[];
} {
  const byType = new Map<
    string,
    { mismatches: AuditRefRow[]; safeFallbacks: number }
  >();
  for (const row of refs) {
    const claimType = normalizeClaimType(row.ref?.claim_type);
    if (claimType === null) continue;
    const remediation = row.ref?.remediation;
    if (typeof remediation !== "string" || remediation.length === 0) continue; // a pass — never a lesson
    let entry = byType.get(claimType);
    if (entry === undefined) {
      entry = { mismatches: [], safeFallbacks: 0 };
      byType.set(claimType, entry);
    }
    entry.mismatches.push(row);
    if (remediation === SAFE_FALLBACK) entry.safeFallbacks += 1;
  }
  const evidence: ClaimTypeEvidence[] = [...byType.entries()]
    .map(([claimType, entry]) => ({
      claimType,
      mismatches: entry.mismatches.length,
      safeFallbacks: entry.safeFallbacks,
      dates: civilDatesOf(entry.mismatches),
      auditIds: entry.mismatches.map((row) => row.id),
    }))
    .sort((a, b) => (a.claimType < b.claimType ? -1 : a.claimType > b.claimType ? 1 : 0));
  const candidates: LessonCandidate[] = [];
  for (const item of evidence) {
    if (
      item.mismatches >= CLAIM_MISMATCH_THRESHOLD ||
      item.safeFallbacks >= SAFE_FALLBACK_THRESHOLD
    ) {
      const fallbackPart =
        item.safeFallbacks > 0
          ? `; ${item.safeFallbacks} safe fallback${item.safeFallbacks === 1 ? "" : "s"}`
          : "";
      candidates.push({
        subject: `${CLAIM_DRIFT_SUBJECT_PREFIX} ${item.claimType}`,
        note:
          `${item.mismatches} ${item.claimType}-claim ` +
          `${plural(item.mismatches, "mismatch", "mismatches")} on ` +
          `${item.dates.join(", ")}${fallbackPart}`,
        sourceRefs: item.auditIds,
      });
    }
  }
  return { claimAuditRows: refs.length, evidence, candidates };
}

/** Expired-undelivered ratified-kind dead letters (the F3 scope) → candidate. */
export async function aggregateExpiredRatified(
  db: SqlExecutor,
  refs: readonly AuditRefRow[],
): Promise<{ expiredRatified: number; candidates: readonly LessonCandidate[] }> {
  const kindByNotificationId = new Map<string, string>();
  const idToRefs = new Map<string, AuditRefRow[]>();
  for (const row of refs) {
    const notificationId = row.ref?.notificationId;
    if (typeof notificationId !== "string" || !UUID_RE.test(notificationId)) continue;
    kindByNotificationId.set(notificationId, "");
    const bucket = idToRefs.get(notificationId) ?? [];
    bucket.push(row);
    idToRefs.set(notificationId, bucket);
  }
  const ids = [...kindByNotificationId.keys()];
  if (ids.length === 0) return { expiredRatified: 0, candidates: [] };
  // Expired rows persist forever, so the join is resolvable well past the
  // audit window; only never-delivered ratified kinds count (a delivered
  // row that later expired is not a dead letter).
  const rows = await db.query(
    `SELECT id::text AS id, kind FROM notifications
      WHERE id = ANY($1::uuid[]) AND kind = ANY($2::text[])
        AND status = 'expired' AND delivered_at IS NULL`,
    [ids, RATIFIED_SENTINEL_KINDS],
  );
  for (const row of rows.rows) kindByNotificationId.set(String(row.id), String(row.kind));
  const dead: AuditRefRow[] = [];
  const kinds = new Set<string>();
  for (const [notificationId, kind] of kindByNotificationId) {
    if (kind === "") continue;
    for (const ref of idToRefs.get(notificationId) ?? []) {
      dead.push(ref);
      kinds.add(kind);
    }
  }
  if (dead.length < EXPIRED_RATIFIED_THRESHOLD) {
    return { expiredRatified: dead.length, candidates: [] };
  }
  const kindList = [...kinds].sort().join(", ");
  return {
    expiredRatified: dead.length,
    candidates: [
      {
        subject: EXPIRED_RATIFIED_SUBJECT,
        note:
          `${dead.length} ratified-kind ${plural(dead.length, "notification")} expired undelivered on ` +
          `${civilDatesOf(dead).join(", ")} (${kindList})`,
        sourceRefs: dead.map((row) => row.id),
      },
    ],
  };
}

/** Rate-limit denials per principal → candidate for that principal only. */
export function aggregateRateLimits(
  refs: readonly AuditRefRow[],
): {
  rateLimited: number;
  perPrincipal: ReadonlyMap<string, readonly LessonCandidate[]>;
} {
  const byPrincipal = new Map<string, AuditRefRow[]>();
  for (const row of refs) {
    const principalId = row.ref?.principalId;
    if (typeof principalId !== "string" || !UUID_RE.test(principalId)) continue;
    const bucket = byPrincipal.get(principalId) ?? [];
    bucket.push(row);
    byPrincipal.set(principalId, bucket);
  }
  const perPrincipal = new Map<string, readonly LessonCandidate[]>();
  for (const [principalId, rows] of byPrincipal) {
    if (rows.length < RATE_LIMIT_THRESHOLD) continue;
    perPrincipal.set(principalId, [
      {
        subject: RATE_LIMIT_SUBJECT,
        note:
          `${rows.length} reply-budget ${plural(rows.length, "denial")} on ` +
          `${civilDatesOf(rows).join(", ")}`,
        sourceRefs: rows.map((row) => row.id),
      },
    ]);
  }
  return { rateLimited: refs.length, perPrincipal };
}

/**
 * One harvest tick against an injected executor. `principalIds` is the
 * attribution scope (the nightly workflow resolves it from policy.yaml's
 * gateway principals; tests pass ids directly). Re-runs are idempotent by
 * the proposeLesson subject dedupe.
 */
export async function runLessonHarvestTick(
  db: SqlExecutor,
  opts: { readonly principalIds: readonly string[]; now?: Date | (() => Date) },
): Promise<LessonHarvestResult> {
  const now = resolveNow(opts.now);
  const scope = [...new Set(opts.principalIds)];
  if (scope.length === 0) {
    console.log(JSON.stringify({ workflow: "lesson-harvest", status: "no-scope" }));
    return { proposed: 0, refreshed: 0, claimAuditRows: 0, expiredRatified: 0, rateLimited: 0, scope: [] };
  }
  const sinceIso = new Date(now.getTime() - LESSON_HARVEST_WINDOW_HOURS * 3_600_000).toISOString();

  const claim = aggregateClaimAudits(
    await loadAuditRefs(db, "converse.claim_audit", sinceIso),
  );
  const expired = await aggregateExpiredRatified(
    db,
    await loadAuditRefs(db, "notification.expired", sinceIso),
  );
  const rate = aggregateRateLimits(await loadAuditRefs(db, "imessage.converse.rate-limited", sinceIso));

  let proposed = 0;
  let refreshed = 0;
  for (const principalId of scope) {
    const candidates = [
      ...claim.candidates,
      ...expired.candidates,
      ...(rate.perPrincipal.get(principalId) ?? []),
    ].sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
    for (const candidate of candidates) {
      const { created } = await proposeLesson(
        db,
        {
          principalId,
          subject: candidate.subject,
          note: candidate.note,
          sourceAuditIds: candidate.sourceRefs,
        },
        { now },
      );
      if (created) proposed += 1;
      else refreshed += 1;
      console.log(
        JSON.stringify({
          workflow: "lesson-harvest",
          principal: principalId,
          subject: candidate.subject,
          created,
        }),
      );
    }
  }
  const result: LessonHarvestResult = {
    proposed,
    refreshed,
    claimAuditRows: claim.claimAuditRows,
    expiredRatified: expired.expiredRatified,
    rateLimited: rate.rateLimited,
    scope,
  };
  console.log(JSON.stringify({ workflow: "lesson-harvest", ...result }));
  return result;
}

/** Mirrors loadCalibrationPolicy EXACTLY (module-relative, env override, any failure → null). */
async function loadPolicyDoc(): Promise<ReturnType<typeof parsePolicyV1> | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // Module-relative like every other policy loader (cwd-independent —
    // the LaunchAgent worker runs from /). THREE ups from src/ = repo root.
    const moduleDefault = resolve(
      fileURLToPath(new URL("../../../policy.yaml", import.meta.url)),
    );
    const file = process.env.POLICY_YAML_PATH ?? moduleDefault;
    return parsePolicyV1(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function scopedPrincipalIds(db: SqlExecutor): Promise<string[]> {
  const policy = await loadPolicyDoc();
  const names = Object.keys(policy?.gateway?.principals ?? {});
  const ids: string[] = [];
  for (const name of names) {
    const found = await db.query("SELECT id FROM principals WHERE name = $1 LIMIT 1", [name]);
    const id = found.rows[0]?.id;
    if (id !== undefined) ids.push(String(id));
  }
  return ids;
}

async function harvestWithPool(): Promise<LessonHarvestResult | { status: string }> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  try {
    const scope = await scopedPrincipalIds(pool);
    return await runLessonHarvestTick(pool, { principalIds: scope, now: new Date() });
  } finally {
    await pool.end();
  }
}

export const lessonHarvestWorkflow: ScheduledWorkflowDefinition = defineScheduledWorkflow({
  name: "lesson-harvest",
  cron: LESSON_HARVEST_CRON,
  fn: async (ctx): Promise<LessonHarvestResult | { status: string } | { skippedWindow: true }> => {
    if (!isLocalHour(new Date(), LESSON_HARVEST_LOCAL_HOUR)) return { skippedWindow: true };
    return ctx.step.run("lesson-harvest-tick", () => harvestWithPool());
  },
});

/** Registration export for the worker (brief-workflows wire-up pattern). */
export const lessonHarvestWorkflows: readonly ScheduledWorkflowDefinition[] = [
  lessonHarvestWorkflow,
];
