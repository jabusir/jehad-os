import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// This project has its own config: the josctl e2e test boots the real API
// app from source, so it needs the @jehad/api alias (which the root config
// deliberately does not define) alongside the package-source aliases.
const pkgSrc = (name: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@jehad/db", replacement: pkgSrc("db") },
      { find: "@jehad/core", replacement: pkgSrc("core") },
      { find: "@jehad/adapters", replacement: pkgSrc("adapters") },
      {
        find: "@jehad/api",
        replacement: fileURLToPath(new URL("../api/src/index.ts", import.meta.url)),
      },
    ],
  },
});
