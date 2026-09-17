/**
 * ADR-0008 M3 spike — worker/app process (THROWAWAY SCAFFOLDING).
 *
 * Serves the spike Inngest function over plain node:http (inngest/node
 * adapter, zero extra deps). This is the "app/worker" that gets kill -9'd.
 * The Inngest dev server syncs this endpoint (-u flag) and invokes it to
 * execute/replay steps. Not wired into apps/worker — spike-only.
 */
import http from "node:http";
import { serve } from "inngest/node";
import { APP_PORT, inngestClient, spikeWorkflow } from "./spike";

const handler = serve({ client: inngestClient, functions: [spikeWorkflow] });

const server = http.createServer((req, res) => {
  console.log(`[worker] ${new Date().toISOString()} ${req.method} ${req.url}`);
  return handler(req, res);
});

server.listen(APP_PORT, "127.0.0.1", () => {
  console.log(`[worker] serving inngest app "${inngestClient.id}" on http://127.0.0.1:${APP_PORT}`);
});
