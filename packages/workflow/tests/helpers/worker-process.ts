/**
 * Standalone worker process for the dev-server integration suite:
 * the ADR-0008 recorded shape — host the Inngest serve endpoint over
 * plain node:http with the registered workflow functions + runs/human_waits
 * correlation. Spawned/killed (-9) by tests/devserver.test.ts.
 *
 * Env: WORKER_PORT, INNGEST_BASE_URL, WORKFLOW_MARKER_DIR,
 *      WORKFLOW_TEST_DB_URL, WORKFLOW_PRINCIPAL_ID, WORKFLOW_DOMAIN_ID.
 */

import { Pool } from "pg";
import {
  createSqlRunCorrelator,
  createWorkflowWorkerServer,
} from "../../src/index.js";
import {
  approvalFlowWorkflow,
  quickWorkflow,
  signalFlowWorkflow,
  tickerWorkflow,
} from "./test-workflows.js";

const pool = new Pool({ connectionString: process.env.WORKFLOW_TEST_DB_URL });
const correlator = createSqlRunCorrelator(pool, {
  principalId: process.env.WORKFLOW_PRINCIPAL_ID!,
  domainId: process.env.WORKFLOW_DOMAIN_ID!,
});

const server = createWorkflowWorkerServer({
  workflows: [quickWorkflow, signalFlowWorkflow, approvalFlowWorkflow, tickerWorkflow],
  correlator,
});

const port = Number(process.env.WORKFLOW_PORT ?? 4397);
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ service: "workflow-test-worker", port, status: "listening" }));
});

const shutdown = (): void => {
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
