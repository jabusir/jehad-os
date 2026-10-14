import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Same source-mapping convention as the root config (tests run against
// package SOURCES, no prior build): the api consumes @jehad/db, @jehad/core,
// @jehad/workflow, and @jehad/adapters from this checkout's sources in tests.
// Root-level aliases do not propagate into project resolution, and the
// workspace-symlink fallback lands on a dist/ that can be stale relative to
// parallel lane branches — so the api project pins the mapping itself
// (packages/core/vitest.config.ts precedent).
const pkg = (name: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@jehad/db", replacement: pkg("db") },
      { find: "@jehad/core", replacement: pkg("core") },
      { find: "@jehad/workflow", replacement: pkg("workflow") },
      { find: "@jehad/adapters", replacement: pkg("adapters") },
    ],
  },
});
