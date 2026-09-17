/**
 * macOS Keychain credential lookup (plan §9 / ADR-0009): the josctl bearer
 * credential is stored by `mint-credential` and read here — the secret never
 * enters git, logs, or event payloads.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = "jehad-os";
export const JOSCTL_ACCOUNT = "josctl";

export async function findGenericPassword(
  service: string,
  account: string,
): Promise<string> {
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s",
    service,
    "-a",
    account,
    "-w",
  ]);
  const credential = stdout.trim();
  if (credential.length === 0) {
    throw new Error(`keychain entry ${service}/${account} is empty`);
  }
  return credential;
}

export function readJosctlCredential(): Promise<string> {
  return findGenericPassword(KEYCHAIN_SERVICE, JOSCTL_ACCOUNT);
}
