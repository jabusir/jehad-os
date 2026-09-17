import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Same source-mapping convention as the root config (tests run against
// package SOURCES, no prior build): core consumes @jehad/adapters (the
// ActionProvider port) and @jehad/db (migrations) in tests.
const pkg = (name: string): string =>
  fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@jehad/adapters", replacement: pkg("adapters") },
      { find: "@jehad/db", replacement: pkg("db") },
    ],
  },
});
