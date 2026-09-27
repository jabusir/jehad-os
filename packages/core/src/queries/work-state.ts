// Shell trust bar R1 (docs/plans/shell-trust.md) — the canonical work-state
// projection. TWO consumers, ONE collector:
//   1. the `work.status` read tool (structured, coverage-honest payload for
//      cognition — "how's the research going" becomes answerable from
//      canonical state instead of conversation history);
//   2. the truth verifier's WORK STATE section (the bounded text snapshot
//      against which work-existence/progress claims are judged — the
//      2026-09-25 14:14 phantom-research class dies here).
//
// Read-only SELECTs, principal-scoped, truncation + row caps before anything
// reaches a prompt. Deadlines render as what they ARE: the reaper's max
// lifetime bound — never a delivery promise. Existence-class facts only:
// statuses, criteria, artifact titles. The SUBSTANTIVE claims inside a
// stored artifact are NOT adopted as truth (owner amendment 1).
import type { SqlExecutor } from "../actions/audit.js";
import { BRIEF_TIMEZONE } from "../briefs/timezone.js";

export const WORK_STATUS_COVERAGE =
  "delegated work (outcomes + worker assignments) you created through me or josctl — statuses, deadlines (max lifetime / reaper bound, NOT a delivery promise), criteria, and latest artifacts; not returned ≠ nonexistent (pass ref for one outcome's detail)";

const CAP_OUTCOMES = 5;
const CAP_TITLE = 80;
const CAP_COMPLETED = 5;
const SNAPSHOT_CHAR_CAP = 1400;

export interface WorkOutcomeView {
  readonly ref: string;
  readonly title: string;
  readonly status: string;
  /** Rendered civil date or null — labeled as the reaper bound. */
  readonly deadlineDay: string | null;
  readonly waitingOn: string | null;
  readonly criteriaVerified: number;
  readonly criteriaTotal: number;
  readonly latestAssignment: {
    readonly role: string;
    readonly status: string;
    readonly artifactTitle: string | null;
  } | null;
}

export interface WorkStateView {
  readonly timezone: string;
  readonly activeTotal: number;
  readonly active: readonly WorkOutcomeView[];
  readonly activeTruncated: boolean;
  readonly completedLast24h: readonly {
    readonly ref: string;
    readonly title: string;
  }[];
}

export async function collectWorkState(
  db: SqlExecutor,
  input: { readonly principalId: string; readonly now: Date },
): Promise<WorkStateView> {
  const open = await db.query(
    `SELECT id, ref, title, status, deadline_at, waiting_on
       FROM outcomes
      WHERE principal_id = $1::uuid
        AND status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY (status = 'waiting_user') DESC, deadline_at NULLS LAST, created_at ASC`,
    [input.principalId],
  );
  const rows = open.rows as readonly Record<string, unknown>[];
  const activeIds = rows.map((row) => String(row.id));
  const criteriaRows =
    activeIds.length > 0
      ? (
          await db.query(
            `SELECT outcome_id, status, count(*)::int AS n
               FROM outcome_criteria
              WHERE outcome_id = ANY($1::uuid[])
              GROUP BY outcome_id, status`,
            [activeIds],
          )
        ).rows
      : [];
  const assignmentRows =
    activeIds.length > 0
      ? (
          await db.query(
            `SELECT DISTINCT ON (outcome_id)
                    outcome_id, role, status, result->'artifact'->>'title' AS artifact_title
               FROM assignments
              WHERE outcome_id = ANY($1::uuid[])
              ORDER BY outcome_id, created_at DESC`,
            [activeIds],
          )
        ).rows
      : [];
  const criteriaByOutcome = new Map<string, { verified: number; total: number }>();
  for (const row of criteriaRows) {
    const id = String(row.outcome_id);
    const entry = criteriaByOutcome.get(id) ?? { verified: 0, total: 0 };
    entry.total += Number(row.n ?? 0);
    if (String(row.status) === "verified") entry.verified += Number(row.n ?? 0);
    criteriaByOutcome.set(id, entry);
  }
  const assignmentByOutcome = new Map<string, { role: string; status: string; artifactTitle: string | null }>();
  for (const row of assignmentRows) {
    assignmentByOutcome.set(String(row.outcome_id), {
      role: String(row.role),
      status: String(row.status),
      artifactTitle:
        row.artifact_title === null || row.artifact_title === undefined
          ? null
          : clip(String(row.artifact_title), CAP_TITLE),
    });
  }
  const active: WorkOutcomeView[] = rows.slice(0, CAP_OUTCOMES).map((row) => {
    const id = String(row.id);
    const criteria = criteriaByOutcome.get(id) ?? { verified: 0, total: 0 };
    const deadlineAt = row.deadline_at instanceof Date ? row.deadline_at : null;
    const waitingOn = row.waiting_on;
    return {
      ref: String(row.ref),
      title: clip(String(row.title), CAP_TITLE),
      status: String(row.status),
      deadlineDay:
        deadlineAt === null
          ? null
          : new Intl.DateTimeFormat("en-US", {
              timeZone: BRIEF_TIMEZONE,
              month: "short",
              day: "numeric",
            }).format(deadlineAt),
      waitingOn:
        waitingOn === null || waitingOn === undefined || typeof waitingOn !== "string"
          ? null
          : clip(waitingOn, CAP_TITLE),
      criteriaVerified: criteria.verified,
      criteriaTotal: criteria.total,
      latestAssignment: assignmentByOutcome.get(id) ?? null,
    };
  });
  const completed = await db.query(
    `SELECT ref, title FROM outcomes
      WHERE principal_id = $1::uuid AND status = 'completed'
        AND updated_at >= $2::timestamptz
      ORDER BY updated_at DESC LIMIT $3::int`,
    [input.principalId, new Date(input.now.getTime() - 86_400_000).toISOString(), CAP_COMPLETED],
  );
  return {
    timezone: BRIEF_TIMEZONE,
    activeTotal: rows.length,
    active,
    activeTruncated: rows.length > CAP_OUTCOMES,
    completedLast24h: completed.rows.map((row: Record<string, unknown>) => ({
      ref: String(row.ref),
      title: clip(String(row.title), CAP_TITLE),
    })),
  };
}

/** One outcome's full detail (the ref drill-down — bounded). */
export async function collectWorkOutcomeDetail(
  db: SqlExecutor,
  input: { readonly principalId: string; readonly ref: string; readonly now: Date },
): Promise<
  | {
      readonly found: true;
      readonly ref: string;
      readonly title: string;
      readonly status: string;
      readonly directive: string | null;
      readonly deadlineDay: string | null;
      readonly waitingOn: string | null;
      readonly criteria: readonly { readonly text: string; readonly status: string }[];
      readonly assignments: readonly {
        readonly role: string;
        readonly status: string;
        readonly artifactTitle: string | null;
      }[];
    }
  | { readonly found: false }
> {
  const outcome = await db.query(
    `SELECT id, ref, title, status, directive, deadline_at, waiting_on
       FROM outcomes
      WHERE principal_id = $1::uuid AND upper(ref) = upper($2)
      LIMIT 1`,
    [input.principalId, input.ref],
  );
  const row = outcome.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return { found: false };
  const id = String(row.id);
  const [criteria, assignments] = await Promise.all([
    db.query(
      `SELECT criterion, status FROM outcome_criteria
        WHERE outcome_id = $1::uuid ORDER BY ordinal ASC LIMIT 5`,
      [id],
    ),
    db.query(
      `SELECT role, status, result->'artifact'->>'title' AS artifact_title
         FROM assignments WHERE outcome_id = $1::uuid
        ORDER BY created_at ASC LIMIT 5`,
      [id],
    ),
  ]);
  const deadlineAt = row.deadline_at instanceof Date ? row.deadline_at : null;
  const waitingOn = row.waiting_on;
  return {
    found: true,
    ref: String(row.ref),
    title: clip(String(row.title), CAP_TITLE),
    status: String(row.status),
    directive: row.directive === null || row.directive === undefined ? null : clip(String(row.directive), 200),
    deadlineDay:
      deadlineAt === null
        ? null
        : new Intl.DateTimeFormat("en-US", {
            timeZone: BRIEF_TIMEZONE,
            month: "short",
            day: "numeric",
          }).format(deadlineAt),
    waitingOn:
      waitingOn === null || waitingOn === undefined || typeof waitingOn !== "string"
        ? null
        : clip(waitingOn, CAP_TITLE),
    criteria: criteria.rows.map((r: Record<string, unknown>) => ({
      text: clip(String(r.criterion), 80),
      status: String(r.status),
    })),
    assignments: assignments.rows.map((r: Record<string, unknown>) => ({
      role: String(r.role),
      status: String(r.status),
      artifactTitle:
        r.artifact_title === null || r.artifact_title === undefined
          ? null
          : clip(String(r.artifact_title), CAP_TITLE),
    })),
  };
}

/**
 * The verifier/regeneration WORK STATE text (owner amendment 1): an
 * EMPTY projection states its emptiness explicitly — "no delegated work
 * exists canonically" is the ground truth an existence claim contradicts.
 */
export function renderWorkSnapshotText(state: WorkStateView): string {
  if (state.activeTotal === 0 && state.completedLast24h.length === 0) {
    return "NO DELEGATED WORK EXISTS (canonical work state is empty)";
  }
  const lines: string[] = [];
  if (state.active.length === 0 && state.activeTotal > 0) {
    lines.push(`ACTIVE: ${state.activeTotal} outcome(s) exist (not itemized here)`);
  }
  for (const o of state.active) {
    const deadline = o.deadlineDay === null ? "" : ` deadline=${o.deadlineDay} (reaper bound, not a promise)`;
    const criteria = o.criteriaTotal > 0 ? ` criteria=${o.criteriaVerified}/${o.criteriaTotal} verified` : "";
    const assignment =
      o.latestAssignment === null
        ? ""
        : ` latest_assignment=${o.latestAssignment.role}:${o.latestAssignment.status}` +
          (o.latestAssignment.artifactTitle !== null ? ` (artifact: ${o.latestAssignment.artifactTitle})` : "");
    const waiting = o.waitingOn === null ? "" : ` waiting_on=${o.waitingOn}`;
    lines.push(
      `ACTIVE [${o.ref}] "${o.title}" status=${o.status}${deadline}${criteria}${assignment}${waiting}`,
    );
  }
  for (const c of state.completedLast24h) {
    lines.push(`COMPLETED_LAST_24H [${c.ref}] "${c.title}"`);
  }
  const text = lines.join("\n");
  return text.length <= SNAPSHOT_CHAR_CAP ? text : clip(text, SNAPSHOT_CHAR_CAP);
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap - 1) + "…";
}
