// Self-contained brief artifact persistence (plan §13: "brief artifact
// (postgres)"; §11 Option A). No shared artifact service exists yet, so this
// helper owns its full write path as a direct INSERT per the artifacts table
// (kind brief/close, storage_backend postgres, content = rendered text,
// domain personal, source_event_id null — there is no source event; the
// brief derives from many). artifacts.run_id is NOT NULL (schema v1), so the
// helper mints a provenance runs row under a dedicated service principal
// ("service/briefs"), completed at render time. It is replaced wholesale when
// the shared artifact service lands.
//
// NOTE: no brief.generated event is emitted in Phase 1 — the event would
// immediately feed the next whatChanged delta and make the world
// un-suppressible; catalog wiring lands with the shared artifact service.

import type { QueryExecutor } from "../queries/executor.js";

const BRIEF_PRINCIPAL_NAME = "service/briefs";

const UPSERT_PRINCIPAL_SQL = `
  WITH ins AS (
    INSERT INTO principals (type, name) VALUES ('service', $1)
    ON CONFLICT (name) DO NOTHING
    RETURNING id
  )
  SELECT id FROM ins
  UNION ALL
  SELECT id FROM principals WHERE name = $1
  LIMIT 1
`;

export interface BriefArtifactInput {
  readonly kind: "brief" | "close";
  readonly content: string;
  /** runs.workflow_id provenance (e.g. "brief-morning" or a CLI label). */
  readonly workflowId: string;
  /** Domain key; defaults to personal. */
  readonly domainId?: string;
  readonly now?: Date;
}

/**
 * Persists one rendered brief/close as a postgres-backend artifact row and
 * returns its id. Throws BriefDomainNotFoundError when the domain is not
 * seeded (pnpm setup:db / seed-domains).
 */
export async function persistBriefArtifact(
  db: QueryExecutor,
  input: BriefArtifactInput,
): Promise<string> {
  const now = input.now ?? new Date();
  const domainKey = input.domainId ?? "personal";

  const domain = await db.query(`SELECT id FROM domains WHERE key = $1`, [domainKey]);
  const domainId = domain.rows[0]?.id;
  if (domainId === undefined) {
    throw new BriefDomainNotFoundError(domainKey);
  }

  const principal = await db.query(UPSERT_PRINCIPAL_SQL, [BRIEF_PRINCIPAL_NAME]);
  const principalId = principal.rows[0]?.id;
  if (principalId === undefined) {
    throw new Error("persistBriefArtifact: could not resolve the briefs service principal");
  }

  const run = await db.query(
    `INSERT INTO runs (kind, workflow_id, principal_id, status, intent, domain_id,
                       started_at, ended_at, created_at, updated_at)
     VALUES ('workflow', $1, $2::uuid, 'completed', $3, $4::uuid,
             $5::timestamptz, $5::timestamptz, $5::timestamptz, $5::timestamptz)
     RETURNING id`,
    [input.workflowId, principalId, `render ${input.kind}`, domainId, now.toISOString()],
  );
  const runId = run.rows[0]?.id;
  if (runId === undefined) {
    throw new Error("persistBriefArtifact: runs insert returned no row");
  }

  const artifact = await db.query(
    `INSERT INTO artifacts (run_id, kind, storage_backend, content, domain_id, sensitivity,
                            created_at, updated_at)
     VALUES ($1::uuid, $2, 'postgres', $3, $4::uuid, 'normal',
             $5::timestamptz, $5::timestamptz)
     RETURNING id`,
    [runId, input.kind, input.content, domainId, now.toISOString()],
  );
  const artifactId = artifact.rows[0]?.id;
  if (artifactId === undefined) {
    throw new Error("persistBriefArtifact: artifacts insert returned no row");
  }
  return String(artifactId);
}

export class BriefDomainNotFoundError extends Error {
  readonly code = "BRIEF_DOMAIN_NOT_FOUND";
  constructor(readonly domainKey: string) {
    super(`domain "${domainKey}" is not seeded; run pnpm setup:db / pnpm migrate first`);
    this.name = "BriefDomainNotFoundError";
  }
}
