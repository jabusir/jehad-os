/**
 * josctl brief — renders the §31 morning brief (or, with --close, the §31
 * evening close) to stdout (plan §13). Same code path as the scheduled
 * workflows: renderMorningBrief/renderEveningClose from @jehad/core, which
 * read canonical state and persist the artifact row (personal domain) unless
 * the world is calm — a suppressed render prints nothing and exits 0.
 *
 * NOTE (same as metrics): there is no brief API route yet, so this reads the
 * canonical database DIRECTLY via a local pg pool built from DATABASE_URL.
 */

import type { Writable } from "node:stream";
import { Pool } from "pg";
import { renderEveningClose, renderMorningBrief } from "@jehad/core";

export const BRIEF_USAGE = "usage: josctl brief [--close]\n";

export interface BriefArgs {
  readonly close?: boolean;
}

/** Structural slice of pg.Pool the brief service needs (injectable for tests). */
export interface BriefDb {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export function parseBriefArgs(argv: readonly string[]): BriefArgs | null {
  const [command, ...rest] = argv.slice(2);
  if (command !== "brief") return null;
  if (rest.length === 0) return {};
  if (rest.length === 1 && rest[0] === "--close") return { close: true };
  return null;
}

export type BriefDbFactory = (databaseUrl: string) => BriefDb & { end(): Promise<void> };

const defaultFactory: BriefDbFactory = (databaseUrl) =>
  new Pool({ connectionString: databaseUrl }) as unknown as BriefDb & { end(): Promise<void> };

export interface BriefCommandDeps {
  readonly databaseUrl: string;
  readonly output?: Writable;
  readonly errOutput?: Writable;
  readonly connect?: BriefDbFactory;
}

export async function runBriefCommand(
  argv: readonly string[],
  deps: BriefCommandDeps,
): Promise<number> {
  const out = deps.output ?? process.stdout;
  const errOut = deps.errOutput ?? process.stderr;

  const parsed = parseBriefArgs(argv);
  if (parsed === null) {
    errOut.write(BRIEF_USAGE);
    return 2;
  }

  const db = (deps.connect ?? defaultFactory)(deps.databaseUrl);
  try {
    const outcome = parsed.close
      ? await renderEveningClose(db)
      : await renderMorningBrief(db);
    if (outcome.suppressed || outcome.content === null) {
      // §31: no summary when nothing meaningful changed — no artifact, no stdout.
      errOut.write("josctl: brief suppressed (nothing meaningful changed)\n");
      return 0;
    }
    out.write(outcome.content);
    return 0;
  } catch (err) {
    errOut.write(
      `josctl: brief query failed against ${deps.databaseUrl}: ${
        err instanceof Error ? err.message : String(err)
      }\nIs the database migrated and reachable? (pnpm migrate)\n`,
    );
    return 1;
  } finally {
    await db.end();
  }
}
