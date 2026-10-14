/**
 * GET /ui/icon.svg — app identity for Today (ADR-0019 surface, added by the
 * UX overhaul Lane D / ADR-0022). A minimal static mark: a rounded dark
 * square holding a 2×2 dot grid — filled blue (needs you), outline (in
 * motion), dim outline (snoozed), filled green (done). Served as a PUBLIC
 * path: it contains no data, no principal, and no user content of any kind.
 * No auth beyond public-path reachability; static bytes, cacheable.
 */

import type { FastifyInstance } from "fastify";

export const TODAY_ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Today">` +
  `<rect width="64" height="64" rx="14" fill="#1c1c1e"/>` +
  `<circle cx="23" cy="23" r="7" fill="#0a84ff"/>` +
  `<circle cx="41" cy="23" r="6" fill="none" stroke="#f2f2f7" stroke-width="2.5"/>` +
  `<circle cx="23" cy="41" r="6" fill="none" stroke="#8e8e93" stroke-width="2.5"/>` +
  `<circle cx="41" cy="41" r="7" fill="#30d158"/>` +
  `</svg>`;

export function registerUiIconRoute(app: FastifyInstance): void {
  app.get("/ui/icon.svg", async (_request, reply) => {
    return await reply
      .code(200)
      .header("content-type", "image/svg+xml; charset=utf-8")
      .header("cache-control", "public, max-age=604800")
      .send(TODAY_ICON_SVG);
  });
}
