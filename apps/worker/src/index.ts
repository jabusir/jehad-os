/**
 * @jehad/worker — thin entry per ADR-0008's recorded shape: register and
 * serve workflow functions over the Inngest serve endpoint (plain
 * node:http via @jehad/workflow — no Inngest imports here, M3 criterion).
 * Not a bespoke queue daemon; the executor owns execution.
 *
 * Run correlation (delegate-watch roadmap NOW item): every firing writes
 * canonical runs/human_waits rows through the SQL correlator — the only
 * world-state writes allowed at the workflow layer (docs/workflow-runtime.md
 * §2.3/§8). Correlation is best-effort: resolution or write failures are
 * logged and never break workflow execution.
 */

import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  createSqlRunCorrelator,
  createWorkflowWorkerServer,
  logCorrelationError,
  type RunCorrelator,
  type SqlQueryExecutor,
} from "@jehad/workflow";
import { workflows } from "./workflows.js";

/**
 * Correlator attribution for runtime-initiated (cron) firings: a stable
 * service principal (same resolve-or-create shape as grant-workflows) and
 * the seeded `personal` domain (domains are the only M1 seeding).
 */
async function resolveRunCorrelator(exec: SqlQueryExecutor): Promise<RunCorrelator> {
  const principal = await exec.query(
    `WITH ins AS (
       INSERT INTO principals (type, name) VALUES ('service', 'service/workflow-runtime')
       ON CONFLICT (name) DO NOTHING RETURNING id
     )
     SELECT id FROM ins UNION ALL SELECT id FROM principals WHERE name = 'service/workflow-runtime' LIMIT 1`,
  );
  const domain = await exec.query("SELECT id FROM domains WHERE key = $1", ["personal"]);
  const principalId = principal.rows[0] as { id: string } | undefined;
  const domainId = domain.rows[0] as { id: string } | undefined;
  if (principalId === undefined || domainId === undefined) {
    throw new Error(
      "run correlation needs the seeded 'personal' domain and service principal (pnpm setup:db + pnpm migrate)",
    );
  }
  return createSqlRunCorrelator(exec, {
    principalId: principalId.id,
    domainId: domainId.id,
  });
}

export async function main(): Promise<void> {
  const port = Number(process.env.WORKER_PORT ?? 4040);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad",
  });
  let correlator: RunCorrelator | undefined;
  let runCorrelation: "enabled" | "disabled" = "disabled";
  try {
    correlator = await resolveRunCorrelator(pool);
    runCorrelation = "enabled";
  } catch (err) {
    logCorrelationError("resolve", err); // serve anyway; correlation stays off
  }
  const server = createWorkflowWorkerServer({ workflows, correlator });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      JSON.stringify({
        service: "jehad-worker",
        status: "serving",
        port,
        runCorrelation,
        workflows: workflows.map((w) => w.name),
      }),
    );
  });
  const shutdown = (): void => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
