import { pathToFileURL } from "node:url";
import Fastify from "fastify";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export async function buildApp() {
  const app = Fastify({ logger: false });

  // TODO(auth — Lane B, M0): mount the principal-authentication hook here.
  // ADR-0009: every call requires an authenticated principal (local bearer
  // credential, one per principal; deny by default; loopback binding is a
  // network boundary, not identity). Intended mount point:
  //   app.addHook("onRequest", requirePrincipal);
  // Until it lands, /healthz is intentionally the only route.

  app.get("/healthz", async () => ({ ok: true }) as const);

  return app;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const app = await buildApp();
  await app.listen({ host: HOST, port });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
