import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M3 acceptance criterion (plan §15 M3; ADR-0008): no Inngest imports
 * outside packages/workflow. This is the executable grep-proof — it
 * scans every workspace source file except packages/workflow itself
 * (and the read-only spike quarantine inside it).
 */

const INNGEST_IMPORT_RE = /from\s+["']inngest(\/[^"']*)?["']/;

async function findRepoRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root (pnpm-workspace.yaml) not found");
}

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* tsFiles(full);
    } else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe("M3 boundary: Inngest imports stay inside packages/workflow", () => {
  it("no file outside packages/workflow imports inngest", async () => {
    const root = await findRepoRoot();
    const offenders: string[] = [];

    for (const pkg of ["packages", "apps"]) {
      const pkgRoot = join(root, pkg);
      if (!existsSync(pkgRoot)) continue;
      for await (const file of await (async function* () {
        for (const entry of await readdir(pkgRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name === "node_modules") continue;
          yield* tsFiles(join(pkgRoot, entry.name));
        }
      })()) {
        const rel = file.slice(root.length + 1);
        if (rel.startsWith("packages/workflow/")) continue; // the allowed home (incl. read-only spike)
        const content = await readFile(file, "utf8");
        if (INNGEST_IMPORT_RE.test(content)) offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});
