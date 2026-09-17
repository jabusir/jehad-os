import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Same source-mapping convention as the root config (tests run against
// package SOURCES, no prior build): the brief scheduled workflows consume
// @jehad/core (renderers) in addition to the aliases the root config defines.
const pkg = (name: string): string =>
  fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@jehad/adapters", replacement: pkg("adapters") },
      { find: "@jehad/core", replacement: pkg("core") },
      { find: "@jehad/db", replacement: pkg("db") },
    ],
  },
});
