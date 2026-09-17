/**
 * Metrics rollup (M6D; plan §14 observability — the §28 north-star metric is
 * DERIVED here, never stored on runs).
 *
 * Read-only derived queries over the canonical tables (runs, human_waits,
 * escalations, events, model_calls, outbox, action_attempts). No canonical
 * writes; no new deps; percentiles computed from raw intervals so multiple
 * waits per run and cause analysis by escalation reason both work (review
 * §14 — the reason human_blocked_ms is not a runs column).
 *
 * Percentile method: nearest-rank on ascending durations (smallest value
 * whose cumulative count reaches p% of n) — deterministic and testable.
 * All rates are 0 (not NaN) when their denominator is 0.
 */

/**
 * Structural read-only slice of pg.Pool — everything computeMetrics needs.
 * A real Pool satisfies this; tests may substitute any query-only object.
 */
export interface MetricsDb {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface Percentiles {
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
}

export interface HumanBlockedByReason {
  readonly reason: string;
  readonly waits: number;
  readonly totalMs: number;
  readonly percentiles: Percentiles;
}

export interface HumanBlockedPerRun {
  readonly runId: string;
  readonly waits: number;
  readonly totalMs: number;
}

export interface HumanBlockedMetrics {
  /** SUM of resolved (resolved_at − started_at) across all waits in window. */
  readonly totalMs: number;
  /** Currently-open waits (resolved_at IS NULL) — a now-snapshot, unwindowed. */
  readonly openWaits: number;
  readonly byReason: readonly HumanBlockedByReason[];
  readonly perRun: readonly HumanBlockedPerRun[];
}

export interface InterruptionsMetrics {
  readonly resolvedWaits: number;
  readonly distinctDays: number;
  /** resolvedWaits / distinctDays (0 when no days). */
  readonly perDay: number;
}

export interface AutonomousCompletionMetrics {
  readonly completedRuns: number;
  readonly endedRuns: number;
  readonly cancelledExcluded: number;
  /** completedRuns / endedRuns (0 when no ended non-cancelled runs). */
  readonly rate: number;
}

export interface FalseEscalationMetrics {
  readonly resolved: number;
  readonly notNeeded: number;
  /** notNeeded / resolved (0 when no resolved escalations). */
  readonly rate: number;
}

export interface ModelCostByProviderModel {
  readonly provider: string;
  readonly model: string;
  readonly calls: number;
  readonly costUsd: number;
}

export interface ModelCostPerRun {
  readonly runId: string;
  readonly costUsd: number;
}

export interface ModelCostMetrics {
  readonly totalUsd: number;
  readonly calls: number;
  readonly byProviderModel: readonly ModelCostByProviderModel[];
  readonly topRuns: readonly ModelCostPerRun[];
}

export interface WorkflowStatusSnapshot {
  /** Runs grouped by status — current state, deliberately unwindowed. */
  readonly statuses: readonly { readonly status: string; readonly runs: number }[];
}

export interface OutboxErrorSignature {
  /** Sanitized first line of outbox.last_error (whitespace collapsed, ≤100 chars). */
  readonly signature: string;
  readonly count: number;
}

export interface FailureMetrics {
  readonly actionAttempts: { readonly failed: number; readonly unknown: number };
  readonly outboxErrors: readonly OutboxErrorSignature[];
}

export interface MetricsReport {
  readonly window: { readonly since: string | null; readonly generatedAt: string };
  readonly humanBlocked: HumanBlockedMetrics;
  readonly interruptions: InterruptionsMetrics;
  readonly autonomousCompletion: AutonomousCompletionMetrics;
  readonly falseEscalation: FalseEscalationMetrics;
  readonly modelCost: ModelCostMetrics;
  readonly workflowStatus: WorkflowStatusSnapshot;
  readonly failures: FailureMetrics;
}

export interface ComputeMetricsOptions {
  /** Start of the window (inclusive); omit for all time. */
  readonly since?: Date | string;
  readonly now?: () => Date;
  /** Per-run cost / busiest-run table size. */
  readonly topRuns?: number;
  /** Outbox error signature table size. */
  readonly topErrorSignatures?: number;
}

/** Weekly rollup window (plan §14): the last 7 days (cron registration via
 *  @jehad/workflow comes at integration — this is the workflow-ready body). */
export const ROLLUP_WINDOW_DAYS = 7;

function normalizeSince(since?: Date | string): Date | null {
  if (since === undefined) return null;
  const date = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`computeMetrics: invalid since timestamp: ${String(since)}`);
  }
  return date;
}

function toCount(value: unknown): number {
  return Number(value ?? 0);
}

function toMs(value: unknown): number {
  return Math.round(Number(value ?? 0));
}

function toUsd(value: unknown): number {
  return Number(value ?? 0);
}

function toString_(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Nearest-rank percentile over ascending-sorted values; 0 for empty input. */
export function percentile(sortedAsc: readonly number[], p: 50 | 90 | 99): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sortedAsc.length), 1), sortedAsc.length);
  return sortedAsc[rank - 1]!;
}

function percentilesOf(sortedAsc: readonly number[]): Percentiles {
  return {
    p50: percentile(sortedAsc, 50),
    p90: percentile(sortedAsc, 90),
    p99: percentile(sortedAsc, 99),
  };
}

function sanitizeErrorSignature(raw: string): string {
  const firstLine = raw.split("\n")[0]!.replace(/\s+/g, " ").trim();
  return firstLine.slice(0, 100);
}

/**
 * Computes the §14 derived aggregates. Every query is read-only; the window
 * applies per-table to the semantically right timestamp (waits: started_at,
 * runs: ended_at, escalations: updated_at, model_calls: created_at, outbox:
 * updated_at, attempts: started_at). The status snapshot and open-wait count
 * describe current state and are intentionally unwindowed.
 */
export async function computeMetrics(
  db: MetricsDb,
  opts: ComputeMetricsOptions = {},
): Promise<MetricsReport> {
  const since = normalizeSince(opts.since);
  const now = opts.now?.() ?? new Date();
  const topRuns = opts.topRuns ?? 5;
  const topErrorSignatures = opts.topErrorSignatures ?? 5;
  const args = [since];

  const [waits, openWaits, interruptions, completion, escalations, costByModel, costTotal, costTopRuns, statusSnapshot, outboxErrors, attempts] =
    await Promise.all([
      db.query(
        `SELECT hw.run_id::text AS run_id,
                COALESCE(e.reason, hw.reason, 'unknown') AS reason,
                ROUND(EXTRACT(EPOCH FROM (hw.resolved_at - hw.started_at)) * 1000)::bigint AS duration_ms
         FROM human_waits hw
         LEFT JOIN escalations e ON e.id = hw.escalation_id
         WHERE hw.resolved_at IS NOT NULL
           AND ($1::timestamptz IS NULL OR hw.started_at >= $1::timestamptz)`,
        args,
      ),
      db.query("SELECT count(*)::int AS n FROM human_waits WHERE resolved_at IS NULL", []),
      db.query(
        `SELECT count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
                count(DISTINCT (started_at AT TIME ZONE 'UTC')::date)::int AS days
         FROM human_waits
         WHERE ($1::timestamptz IS NULL OR started_at >= $1::timestamptz)`,
        args,
      ),
      db.query(
        `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                count(*)::int AS ended_total
         FROM runs
         WHERE ended_at IS NOT NULL
           AND ($1::timestamptz IS NULL OR ended_at >= $1::timestamptz)`,
        args,
      ),
      db.query(
        // No resolution column yet (M6C resolve payload hasn't landed): a
        // resolution of not_needed is heuristically the escalation.resolved
        // event whose payload carries the escalationId and 'not_needed'.
        `SELECT count(*)::int AS resolved_total,
                count(*) FILTER (WHERE ev.id IS NOT NULL)::int AS not_needed
         FROM escalations esc
         LEFT JOIN events ev
           ON ev.type = 'escalation.resolved'
          AND ev.payload->>'escalationId' = esc.id::text
          AND ev.payload::text LIKE '%not_needed%'
         WHERE esc.status = 'resolved'
           AND ($1::timestamptz IS NULL OR esc.updated_at >= $1::timestamptz)`,
        args,
      ),
      db.query(
        `SELECT provider, model, count(*)::int AS calls, SUM(cost_usd) AS cost_usd
         FROM model_calls
         WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
         GROUP BY provider, model
         ORDER BY SUM(cost_usd) DESC, provider ASC, model ASC`,
        args,
      ),
      db.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total_usd, count(*)::int AS calls
         FROM model_calls
         WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)`,
        args,
      ),
      db.query(
        `SELECT run_id::text AS run_id, SUM(cost_usd) AS cost_usd
         FROM model_calls
         WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
         GROUP BY run_id
         ORDER BY SUM(cost_usd) DESC, run_id ASC
         LIMIT $2`,
        [since, topRuns],
      ),
      db.query("SELECT status, count(*)::int AS runs FROM runs GROUP BY status ORDER BY status ASC", []),
      db.query(
        `SELECT last_error
         FROM outbox
         WHERE status = 'failed' AND last_error IS NOT NULL
           AND ($1::timestamptz IS NULL OR updated_at >= $1::timestamptz)`,
        args,
      ),
      db.query(
        `SELECT outcome, count(*)::int AS n
         FROM action_attempts
         WHERE outcome IN ('failed', 'unknown')
           AND ($1::timestamptz IS NULL OR started_at >= $1::timestamptz)
         GROUP BY outcome`,
        args,
      ),
    ]);

  // human_blocked_ms: per-run sums (multi-wait runs sum BOTH waits) + total
  // + p50/p90/p99 of individual wait durations grouped by escalation reason.
  const perRunMap = new Map<string, { waits: number; totalMs: number }>();
  const reasonMap = new Map<string, number[]>();
  let totalMs = 0;
  for (const row of waits.rows) {
    const runId = toString_(row.run_id);
    const reason = toString_(row.reason) || "unknown";
    const durationMs = toMs(row.duration_ms);
    totalMs += durationMs;
    const perRun = perRunMap.get(runId) ?? { waits: 0, totalMs: 0 };
    perRun.waits += 1;
    perRun.totalMs += durationMs;
    perRunMap.set(runId, perRun);
    const durations = reasonMap.get(reason) ?? [];
    durations.push(durationMs);
    reasonMap.set(reason, durations);
  }

  const resolvedWaits = toCount(interruptions.rows[0]?.resolved);
  const distinctDays = toCount(interruptions.rows[0]?.days);

  const endedTotal = toCount(completion.rows[0]?.ended_total);
  const cancelled = toCount(completion.rows[0]?.cancelled);
  const completed = toCount(completion.rows[0]?.completed);
  const endedRuns = endedTotal - cancelled;

  const resolvedEscalations = toCount(escalations.rows[0]?.resolved_total);
  const notNeeded = toCount(escalations.rows[0]?.not_needed);

  const signatureCounts = new Map<string, number>();
  for (const row of outboxErrors.rows) {
    const signature = sanitizeErrorSignature(toString_(row.last_error));
    if (signature.length === 0) continue;
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }
  const topErrors = [...signatureCounts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
    .slice(0, topErrorSignatures);

  return {
    window: { since: since ? since.toISOString() : null, generatedAt: now.toISOString() },
    humanBlocked: {
      totalMs,
      openWaits: toCount(openWaits.rows[0]?.n),
      byReason: [...reasonMap.entries()]
        .map(([reason, durations]) => ({
          reason,
          waits: durations.length,
          totalMs: durations.reduce((sum, d) => sum + d, 0),
          percentiles: percentilesOf([...durations].sort((a, b) => a - b)),
        }))
        .sort((a, b) => b.totalMs - a.totalMs || a.reason.localeCompare(b.reason)),
      perRun: [...perRunMap.entries()]
        .map(([runId, agg]) => ({ runId, ...agg }))
        .sort((a, b) => b.totalMs - a.totalMs || a.runId.localeCompare(b.runId)),
    },
    interruptions: {
      resolvedWaits,
      distinctDays,
      perDay: distinctDays === 0 ? 0 : resolvedWaits / distinctDays,
    },
    autonomousCompletion: {
      completedRuns: completed,
      endedRuns,
      cancelledExcluded: cancelled,
      rate: endedRuns === 0 ? 0 : completed / endedRuns,
    },
    falseEscalation: {
      resolved: resolvedEscalations,
      notNeeded,
      rate: resolvedEscalations === 0 ? 0 : notNeeded / resolvedEscalations,
    },
    modelCost: {
      totalUsd: toUsd(costTotal.rows[0]?.total_usd),
      calls: toCount(costTotal.rows[0]?.calls),
      byProviderModel: costByModel.rows.map((row) => ({
        provider: toString_(row.provider),
        model: toString_(row.model),
        calls: toCount(row.calls),
        costUsd: toUsd(row.cost_usd),
      })),
      topRuns: costTopRuns.rows.map((row) => ({
        runId: toString_(row.run_id),
        costUsd: toUsd(row.cost_usd),
      })),
    },
    workflowStatus: {
      statuses: statusSnapshot.rows.map((row) => ({
        status: toString_(row.status),
        runs: toCount(row.runs),
      })),
    },
    failures: {
      actionAttempts: {
        failed: toCount(attempts.rows.find((row) => toString_(row.outcome) === "failed")?.n),
        unknown: toCount(attempts.rows.find((row) => toString_(row.outcome) === "unknown")?.n),
      },
      outboxErrors: topErrors,
    },
  };
}

/**
 * Weekly rollup body (plan §14): computeMetrics over the last 7 days.
 * Workflow-ready — cron registration via @jehad/workflow lands at integration;
 * callers inject `now` for deterministic windows.
 */
export async function computeWeeklyRollup(
  db: MetricsDb,
  opts: Omit<ComputeMetricsOptions, "since"> = {},
): Promise<MetricsReport> {
  const now = opts.now?.() ?? new Date();
  const since = new Date(now.getTime() - ROLLUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return computeMetrics(db, { ...opts, since });
}
