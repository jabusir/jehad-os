/**
 * josctl metrics — plan §14 weekly rollup, rendered as terminal tables.
 *
 * NOTE: there is no metrics API route yet, so this command reads the
 * canonical database DIRECTLY via a local pg pool built from DATABASE_URL
 * (same pattern as mint-credential). It moves behind the authenticated API
 * when a metrics route lands; queries themselves are read-only derived
 * aggregations from @jehad/core (computeMetrics/renderMetricsText).
 */

import type { Writable } from "node:stream";
import { Pool } from "pg";
import { computeMetrics, renderMetricsText, type MetricsDb } from "@jehad/core";

export const METRICS_USAGE = "usage: josctl metrics [--since ISO8601]\n";

export interface MetricsArgs {
  readonly since?: string;
}

export function parseMetricsArgs(argv: readonly string[]): MetricsArgs | null {
  const [command, ...rest] = argv.slice(2);
  if (command !== "metrics") return null;
  if (rest.length === 0) return {};
  if (rest.length === 2 && rest[0] === "--since") {
    const since = rest[1]!;
    if (since.length === 0 || Number.isNaN(Date.parse(since))) return null;
    return { since };
  }
  return null;
}

/** Injectable pool factory — hermetic tests substitute a fake MetricsDb. */
export type MetricsDbFactory = (databaseUrl: string) => MetricsDb & { end(): Promise<void> };

const defaultFactory: MetricsDbFactory = (databaseUrl) =>
  new Pool({ connectionString: databaseUrl }) as unknown as MetricsDb & { end(): Promise<void> };

export interface MetricsCommandDeps {
  readonly databaseUrl: string;
  readonly output?: Writable;
  readonly errOutput?: Writable;
  readonly connect?: MetricsDbFactory;
  readonly now?: () => Date;
}

export async function runMetricsCommand(
  argv: readonly string[],
  deps: MetricsCommandDeps,
): Promise<number> {
  const out = deps.output ?? process.stdout;
  const errOut = deps.errOutput ?? process.stderr;

  const parsed = parseMetricsArgs(argv);
  if (parsed === null) {
    errOut.write(METRICS_USAGE);
    return 2;
  }

  const db = (deps.connect ?? defaultFactory)(deps.databaseUrl);
  try {
    const metrics = await computeMetrics(db, { since: parsed.since, now: deps.now });
    out.write(renderMetricsText(metrics));
    return 0;
  } catch (err) {
    errOut.write(
      `josctl: metrics query failed against ${deps.databaseUrl}: ${
        err instanceof Error ? err.message : String(err)
      }\nIs the database migrated and reachable? (pnpm migrate)\n`,
    );
    return 1;
  } finally {
    await db.end();
  }
}
