// macOS Keychain read (E4-S). READ-ONLY retrieval of deployment state that
// must never enter git (bearer credential, capability token, iMessage target).
// This module spawns exactly one command shape: `security find-generic-password
// [-s service] [-a account] -w` — no add/delete, no other surface. Values are
// returned to the caller and never logged.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Structural runner port (tests inject a fake; the pin test allowlists it). */
export type KeychainRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export const defaultKeychainRunner: KeychainRunner = execFileAsync as KeychainRunner;

export interface KeychainLookup {
  readonly service: string;
  readonly account?: string;
}

/**
 * Returns the stored password or null (absent / locked / error). Never
 * throws for a missing entry — the caller decides how to fail.
 */
export async function readKeychainPassword(
  lookup: KeychainLookup,
  runner: KeychainRunner = defaultKeychainRunner,
): Promise<string | null> {
  const args = ["find-generic-password", "-s", lookup.service];
  if (lookup.account !== undefined) args.push("-a", lookup.account);
  args.push("-w");
  try {
    const { stdout } = await runner("security", args);
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
