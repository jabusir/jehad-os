import { pathToFileURL } from "node:url";

export async function main(): Promise<void> {
  // Wiring placeholder for the M3 WorkflowRuntime registration (ADR-0008):
  // import the workflow-function registration surface from packages/workflow
  // once it exists beyond the empty export. Dynamic import keeps the test
  // suite hermetic before the first `pnpm build`.
  await import("@jehad/workflow");

  console.log(JSON.stringify({ service: "jehad-worker", status: "stub" }));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
