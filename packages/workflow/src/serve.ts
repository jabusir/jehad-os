/**
 * Worker serve surface (ADR-0008 recorded shape): the worker hosts the
 * Inngest serve endpoint over plain node:http — registering/serving
 * workflow functions, not being a bespoke queue daemon.
 *
 * This is the only module outside apps/* that constructs the HTTP
 * server; callers (apps/worker) pass workflow definitions and never
 * touch anything vendor-shaped.
 */

import http from "node:http";
import { serve } from "inngest/node";
import { createInngestClient, type WorkflowClientConfig } from "./config.js";
import { compileWorkflow, type AnyWorkflowDefinition } from "./definition.js";
import type { RunCorrelator } from "./correlator.js";

export interface WorkflowWorkerOptions {
  /** Workflows this worker serves; must be the complete set per app id. */
  workflows: readonly AnyWorkflowDefinition[];
  correlator?: RunCorrelator;
  config?: WorkflowClientConfig;
  /** Serve path; default "/api/inngest". */
  path?: string;
}

export function createWorkflowWorkerServer(options: WorkflowWorkerOptions): http.Server {
  const client = createInngestClient(options.config);
  const functions = options.workflows.map((def) =>
    compileWorkflow(client, def, options.correlator),
  );
  const handler = serve({
    client,
    functions,
    servePath: options.path ?? "/api/inngest",
  });
  return http.createServer((req, res) => handler(req, res));
}
