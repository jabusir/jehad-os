/**
 * Run correlation — the ONLY world-state writes the workflow runtime layer
 * is allowed (task constraint; ADR-0008 authority split): a `runs` row per
 * run and `human_waits` rows for approval waits. Everything else mutates
 * through core services, which do not exist yet for workflows.
 *
 * The SQL executor is injected structurally (pg.Pool satisfies it), so
 * packages/workflow takes no database dependency at runtime.
 */

import type { DetailedWorkflowStatus } from "./names.js";

export interface RunStartedInfo {
  /** Correlation id: trigger event id (started runs) or executor run id (cron firings). */
  readonly runId: string;
  readonly workflow: string;
  readonly intent?: string;
}

export interface RunCorrelator {
  runStarted(info: RunStartedInfo): Promise<void>;
  runStatus(info: { runId: string; status: DetailedWorkflowStatus }): Promise<void>;
  approvalOpened(info: { runId: string; approvalId: string; reason?: string }): Promise<void>;
  approvalResolved(info: { runId: string; approvalId: string }): Promise<void>;
  /** Closes every still-open wait for a run (cancel path). */
  openWaitsResolved(info: { runId: string }): Promise<void>;
}

export interface SqlQueryExecutor {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

const TERMINAL_STATUSES: readonly DetailedWorkflowStatus[] = ["completed", "cancelled", "failed"];

export function createSqlRunCorrelator(
  exec: SqlQueryExecutor,
  opts: { principalId: string; domainId: string },
): RunCorrelator {
  const { principalId, domainId } = opts;

  const runStarted = async (info: RunStartedInfo): Promise<void> => {
    await exec.query(
      `INSERT INTO runs (kind, workflow_id, principal_id, status, intent, domain_id)
       SELECT 'workflow', $1, $2, 'running', $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM runs WHERE workflow_id = $1)`,
      [info.runId, principalId, info.intent ?? info.workflow, domainId],
    );
  };

  const runStatus = async (info: {
    runId: string;
    status: DetailedWorkflowStatus;
  }): Promise<void> => {
    const terminal = TERMINAL_STATUSES.includes(info.status);
    await exec.query(
      `UPDATE runs
       SET status = $2,
           ended_at = CASE WHEN $3 THEN now() ELSE ended_at END,
           updated_at = now()
       WHERE workflow_id = $1`,
      [info.runId, info.status, terminal],
    );
  };

  const approvalOpened = async (info: {
    runId: string;
    approvalId: string;
    reason?: string;
  }): Promise<void> => {
    // human_waits carries no approval-id column; the wait is keyed by
    // run + reason (`approval:<id>` prefix keeps concurrent waits distinct).
    const reason = `approval:${info.approvalId}${info.reason ? ` ${info.reason}` : ""}`;
    await exec.query(
      `INSERT INTO human_waits (run_id, started_at, reason)
       SELECT r.id, now(), $2 FROM runs r
       WHERE r.workflow_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM human_waits hw JOIN runs r2 ON hw.run_id = r2.id
           WHERE r2.workflow_id = $1 AND hw.reason = $2 AND hw.resolved_at IS NULL
         )`,
      [info.runId, reason],
    );
  };

  const approvalResolved = async (info: {
    runId: string;
    approvalId: string;
  }): Promise<void> => {
    const reason = `approval:${info.approvalId}`;
    await exec.query(
      `UPDATE human_waits hw SET resolved_at = now(), updated_at = now()
       FROM runs r
       WHERE hw.run_id = r.id AND r.workflow_id = $1
         AND hw.reason LIKE $2 AND hw.resolved_at IS NULL`,
      [info.runId, `${reason}%`],
    );
  };

  const openWaitsResolved = async (info: { runId: string }): Promise<void> => {
    await exec.query(
      `UPDATE human_waits hw SET resolved_at = now(), updated_at = now()
       FROM runs r
       WHERE hw.run_id = r.id AND r.workflow_id = $1 AND hw.resolved_at IS NULL`,
      [info.runId],
    );
  };

  return { runStarted, runStatus, approvalOpened, approvalResolved, openWaitsResolved };
}

/** Correlation is best-effort: never let it break workflow execution. */
export function logCorrelationError(operation: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // Structured JSON log (plan §14 correlation shape: run/workflow ids travel
  // in the message context; no secrets are involved in correlation writes).
  console.error(
    JSON.stringify({ logger: "workflow-correlator", operation, error: message }),
  );
}
