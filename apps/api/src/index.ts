import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { setupAuth } from "./auth.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerReviewRoutes } from "./routes/review.js";
import { registerHarnessRoutes } from "./routes/harness.js";
import { registerImessageHarnessRoutes } from "./routes/harness-imessage.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerAttentionRoutes } from "./routes/attention.js";
import { registerUiRoutes } from "./routes/ui.js";
import { registerUiIconRoute } from "./routes/ui-icon.js";
import { registerAttentionActions } from "./routes/attention-actions.js";
import type { PromotionDb } from "@jehad/core";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export interface AppOptions {
  /**
   * Principal + state store. When provided, EVERY route except /healthz
   * requires an authenticated principal (ADR-0009 — the API never exists
   * unauthenticated; loopback is a network boundary, not identity). Omit
   * only for tooling that never binds a port (none today). Structural
   * pg.Pool (query + connect — review/promotion paths run transactions).
   */
  db?: PromotionDb;
  /**
   * W1.2: dispatch port for the shared delegation seam. Defaults to the real
   * WorkflowRuntime; tests inject a counting fake (no Inngest dependency).
   */
  dispatch?: import("@jehad/workflow").OutcomeDispatchPort;
}

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    logger: false,
    // Lane D (Today, ADR-0019), additive: auth.ts's publicPaths gate
    // exact-matches static paths only, so the contract's parameterized
    // /ui/outcome/:ref is rewritten onto the static /ui/outcome?ref=… shape
    // BEFORE the bearer hook runs — cookie-browsers (no Authorization
    // header) reach the session-gated view. Every other URL passes through
    // untouched; the handler serves both shapes.
    rewriteUrl(request) {
      const url = request.url ?? "/";
      const q = url.indexOf("?");
      const path = q === -1 ? url : url.slice(0, q);
      const suffix = q === -1 ? "" : url.slice(q);
      if (path.startsWith("/ui/outcome/")) {
        let ref = path.slice("/ui/outcome/".length);
        try {
          ref = decodeURIComponent(ref);
        } catch {
          // keep raw ref — the view 404s unmatchable refs fail-closed
        }
        return `/ui/outcome?ref=${encodeURIComponent(ref)}${suffix}`;
      }
      return url;
    },
  });

  if (opts.db !== undefined) {
    setupAuth(app, {
      db: opts.db,
      // Lane D (Today): /ui* are session-cookie surfaces (ADR-0019) — the
      // paste endpoint is pre-auth by design; every other /ui path enforces
      // the signed session + CSRF inside its handler. Machine principals
      // never mint sessions (session.ts enforces type === "user").
      publicPaths: [
        "/healthz",
        "/ui",
        "/ui/session",
        "/ui/recovery",
        "/ui/delegate",
        "/ui/missions",
        "/ui/action",
        "/ui/outcome",
        "/ui/icon.svg",
        // U1 (ADR-0021): session-gated in-handler like /ui/action — public
        // only in the bearer-gate sense, never in the authority sense.
        "/ui/snooze",
        "/ui/reopen",
      ],
    });
    registerEventRoutes(app, { db: opts.db });
    registerReviewRoutes(app, { db: opts.db });
    registerHarnessRoutes(app, { db: opts.db });
    registerImessageHarnessRoutes(app, { db: opts.db });
    registerNotificationRoutes(app, { db: opts.db });
    registerAttentionRoutes(app, { db: opts.db });
    registerUiRoutes(app, { db: opts.db, dispatch: opts.dispatch });
    registerAttentionActions(app, { db: opts.db });
  }

  app.get("/healthz", async () => ({ ok: true }) as const);

  // Lane D / ADR-0022: static public asset — needs no DB, registered even
  // for db-less tooling builds.
  registerUiIconRoute(app);

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
