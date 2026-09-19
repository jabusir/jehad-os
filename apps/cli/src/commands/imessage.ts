/**
 * josctl imessage — pairing + identity admin (multi-principal Lane P;
 * docs/plans/ig-multiprincipal-contracts.md "josctl").
 *
 *   josctl imessage pair --principal <name> [--add-handle]
 *        Prints a 6-digit code ONCE (never persisted plaintext). The first
 *        handle that proves it consumes it — single-use, 5-minute TTL.
 *   josctl imessage identities
 *        Lists verified transport identities per principal.
 *
 * NOTE (same Phase-1 pattern as metrics/brief/feedback): direct canonical-DB
 * access via DATABASE_URL until API routes land. `pair --principal <name>`
 * creates the principal when missing (type user, NO credential — the
 * transport identity IS her auth; there is no credential to mint).
 */

import type { Writable } from "node:stream";
import { Pool } from "pg";
import { createPairingSession, type ImessageDb } from "@jehad/core";

export const IMESSAGE_USAGE =
  "usage: josctl imessage pair --principal <name> [--add-handle]\n" +
  "       josctl imessage identities\n";

export interface ImessagePairArgs {
  readonly command: "pair";
  readonly principal: string;
  readonly purpose: "pair" | "add-handle";
}

export interface ImessageIdentitiesArgs {
  readonly command: "identities";
}

export type ImessageArgs = ImessagePairArgs | ImessageIdentitiesArgs;

export function parseImessageArgs(argv: readonly string[]): ImessageArgs | null {
  const [command, sub, ...rest] = argv.slice(2);
  if (command !== "imessage") return null;
  if (sub === "identities") {
    if (rest.length > 0) return null;
    return { command: "identities" };
  }
  if (sub !== "pair") return null;
  let principal: string | undefined;
  let addHandle = false;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token === "--add-handle") {
      addHandle = true;
    } else if (token === "--principal") {
      principal = rest[i + 1];
      i += 1;
    } else {
      return null;
    }
  }
  if (principal === undefined || principal.trim().length === 0) return null;
  return { command: "pair", principal: principal.trim(), purpose: addHandle ? "add-handle" : "pair" };
}

/** Injectable pool factory — hermetic tests substitute a fake db. */
export type ImessageDbFactory = (databaseUrl: string) => ImessageDb & { end(): Promise<void> };

const defaultFactory: ImessageDbFactory = (databaseUrl) =>
  new Pool({ connectionString: databaseUrl }) as unknown as ImessageDb & { end(): Promise<void> };

export interface ImessageCommandDeps {
  readonly databaseUrl: string;
  readonly output?: Writable;
  readonly errOutput?: Writable;
  readonly connect?: ImessageDbFactory;
}

/**
 * Resolves the principal by name, creating it when missing (type user,
 * credential NULL — NO credential minting; the pairing code + transport
 * identity is the entire auth surface). Returns {id, created}.
 */
export async function resolvePairingPrincipal(
  db: { query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  name: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await db.query("SELECT id::text AS id FROM principals WHERE name = $1", [name]);
  if (existing.rows[0] !== undefined) return { id: String(existing.rows[0].id), created: false };
  const inserted = await db.query(
    "INSERT INTO principals (type, name, credential_hash) VALUES ('user', $1, NULL) RETURNING id::text AS id",
    [name],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error("resolvePairingPrincipal: insert returned no row");
  return { id: String(id), created: true };
}

export async function runImessageCommand(
  argv: readonly string[],
  deps: ImessageCommandDeps,
): Promise<number> {
  const out = deps.output ?? process.stdout;
  const errOut = deps.errOutput ?? process.stderr;

  const parsed = parseImessageArgs(argv);
  if (parsed === null) {
    errOut.write(IMESSAGE_USAGE);
    return 2;
  }

  const db = (deps.connect ?? defaultFactory)(deps.databaseUrl);
  try {
    if (parsed.command === "identities") {
      const rows = await db.query(
        `SELECT p.name AS principal_name, p.type AS principal_type, ti.handle, ti.verified_at
           FROM transport_identities ti JOIN principals p ON p.id = ti.principal_id
          WHERE ti.transport = 'imessage'
          ORDER BY p.name, ti.handle`,
      );
      if (rows.rows.length === 0) {
        out.write("no verified iMessage identities\n");
        return 0;
      }
      for (const row of rows.rows) {
        out.write(
          `${String(row.principal_name)} (${String(row.principal_type)}): ${String(row.handle)} — verified ${new Date(String(row.verified_at)).toISOString()}\n`,
        );
      }
      return 0;
    }

    const { id, created } = await resolvePairingPrincipal(db, parsed.principal);
    if (created) {
      out.write(`created principal ${parsed.principal} (type user, no credential — the transport identity is the auth)\n`);
    }
    const session = await createPairingSession(
      db,
      { principalId: id, purpose: parsed.purpose },
      { actor: `user:${parsed.principal}` },
    );
    out.write(
      `pairing code: ${session.code}\n` +
      "SINGLE-USE: the first handle that proves it consumes it. Expires in 5 minutes.\n" +
      "Text the code from the phone to pair; the code is never shown again.\n",
    );
    return 0;
  } catch (err) {
    errOut.write(
      `josctl: imessage command failed against ${deps.databaseUrl}: ${
        err instanceof Error ? err.message : String(err)
      }\nIs the database migrated and reachable? (pnpm migrate)\n`,
    );
    return 1;
  } finally {
    await db.end();
  }
}
