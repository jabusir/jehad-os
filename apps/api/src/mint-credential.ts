import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  isPrincipalType,
  sha256Hex,
  upsertPrincipalCredential,
  type PrincipalType,
} from "@jehad-os/db";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "jehad-os";

export interface MintArgs {
  name: string;
  type: PrincipalType;
}

const USAGE =
  "usage: mint-credential <principal-name> [type: user|harness|service|workflow]\n";

export function parseArgs(argv: readonly string[]): MintArgs | null {
  const args = argv.slice(2);
  if (args.length < 1 || args.length > 2) return null;
  const name = args[0];
  if (name.length === 0 || name.trim() !== name) return null;
  const type = args.length === 2 ? args[1] : "user";
  if (!isPrincipalType(type)) return null;
  return { name, type };
}

async function storeInKeychain(
  principal: string,
  credential: string,
): Promise<void> {
  await execFileAsync("security", [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    principal,
    "-w",
    credential,
  ]);
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    process.stderr.write(USAGE);
    return 2;
  }
  const credential = randomBytes(32).toString("hex");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await upsertPrincipalCredential(pool, {
      type: parsed.type,
      name: parsed.name,
      credentialHash: sha256Hex(credential),
    });
  } catch (err) {
    process.stderr.write(
      `mint-credential: failed to store credential hash for principal "${parsed.name}": ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    await pool.end();
    return 1;
  }
  try {
    await storeInKeychain(parsed.name, credential);
  } catch (err) {
    process.stderr.write(
      `mint-credential: hash stored for principal "${parsed.name}" but macOS Keychain write failed; re-run to rotate: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    await pool.end();
    return 1;
  }
  await pool.end();
  process.stdout.write(
    `mint-credential: credential for principal "${parsed.name}" (type ${parsed.type}) stored in Keychain; retrieve with: security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${parsed.name} -w\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
