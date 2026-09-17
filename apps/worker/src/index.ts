/**
 * @jehad/worker — thin entry per ADR-0008's recorded shape: register and
 * serve workflow functions over the Inngest serve endpoint (plain
 * node:http via @jehad/workflow — no Inngest imports here, M3 criterion).
 * Not a bespoke queue daemon; the executor owns execution.
 */

import { pathToFileURL } from "node:url";
import { createWorkflowWorkerServer } from "@jehad/workflow";
import { workflows } from "./workflows.js";

export function main(): void {
  const port = Number(process.env.WORKER_PORT ?? 4040);
  const server = createWorkflowWorkerServer({ workflows });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      JSON.stringify({
        service: "jehad-worker",
        status: "serving",
        port,
        workflows: workflows.map((w) => w.name),
      }),
    );
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
