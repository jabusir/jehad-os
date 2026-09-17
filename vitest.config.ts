import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against package SOURCES (no prior build needed). Builds still
// resolve through workspace deps -> dist/ (pnpm -r build is topological).
const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@jehad/db", replacement: pkg("db") },
      { find: "@jehad/core", replacement: pkg("core") },
      { find: "@jehad/adapters", replacement: pkg("adapters") },
      { find: "@jehad/workflow", replacement: pkg("workflow") },
    ],
  },
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
