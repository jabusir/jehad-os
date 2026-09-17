import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { setupAuth } from "./auth.js";
import { registerEventRoutes } from "./routes/events.js";
import type { SqlExecutor } from "@jehad/db";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export interface AppOptions {
  /**
   * Principal store. When provided, EVERY route except /healthz requires an
   * authenticated principal (ADR-0009 — the API never exists unauthenticated;
   * loopback is a network boundary, not identity). Omit only for tooling that
   * never binds a port (none today).
   */
  db?: SqlExecutor;
}

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: false });

  if (opts.db !== undefined) {
    setupAuth(app, { db: opts.db, publicPaths: ["/healthz"] });
    registerEventRoutes(app, { db: opts.db });
  }

  app.get("/healthz", async () => ({ ok: true }) as const);

  return app;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL is required (infra/dev/setup-db.sh, ADR-0009)");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const app = await buildApp({ db: pool });
  await app.listen({ host: HOST, port });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
