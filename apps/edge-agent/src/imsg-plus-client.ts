// Wave T (imsg-plus edition): typing-indicator client over the imsg-plus
// dylib's FILE-BASED IPC — no child processes, no Accessibility, no UI
// scripting. The contract is extracted from imsg-plus's IMsgInjected.m (the
// dylib injected into Messages.app) and MessagesLauncher.swift:
//
//   command file  ~/Library/Containers/com.apple.MobileSMS/Data/
//                   .imsg-plus-command.json
//                 {"id": <epochMs>, "action": "typing",
//                  "params": {"handle": "...", "typing": true|false}}
//   response file  .imsg-plus-response.json — poll until it has content AND
//                  the command file was cleared; then parse {id, success,…}
//                  and clear it.
//   liveness       .imsg-plus-ready exists ⇔ the dylib is running inside
//                  Messages.app (it holds an open fd on it and removes it on
//                  exit).
//
// STILL SEND-ONLY: this writes OUR OWN IPC command file and polls OUR OWN
// response file — it never reads Messages state. Requires the owner's
// one-time host decision (SIP off + Messages relaunched with the dylib);
// until then the liveness check fails fast and typing is skipped, never
// blocking a reply.

import { closeSync, constants, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ImsgPlusClientOptions {
  /** Override for tests; default os.homedir(). */
  readonly homeDir?: string;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DATA_DIR_SEGMENTS = ["Library", "Containers", "com.apple.MobileSMS", "Data"];

function dataDir(homeDir?: string): string {
  return path.join(homeDir ?? homedir(), ...DATA_DIR_SEGMENTS);
}

export function imsgPlusHelperAlive(homeDir?: string): boolean {
  return existsSync(path.join(dataDir(homeDir), ".imsg-plus-ready"));
}

export class ImsgPlusUnavailableError extends Error {}
export class ImsgPlusTimeoutError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Set or clear the typing indicator for one handle via the imsg-plus IPC.
 * Throws ImsgPlusUnavailableError when the helper is not running (caller
 * skips, never blocks) and ImsgPlusTimeoutError when the helper does not
 * answer in time.
 */
export async function imsgPlusSetTyping(
  handle: string,
  state: boolean,
  options: ImsgPlusClientOptions = {},
): Promise<void> {
  const dir = dataDir(options.homeDir);
  if (!imsgPlusHelperAlive(options.homeDir)) {
    throw new ImsgPlusUnavailableError("imsg-plus helper is not running (no ready marker)");
  }
  const commandFile = path.join(dir, ".imsg-plus-command.json");
  const responseFile = path.join(dir, ".imsg-plus-response.json");
  const lockFile = path.join(dir, ".imsg-plus-command.lock");
  const timeoutMs = options.timeoutMs ?? 4000;
  const id = Date.now();

  // Advisory cross-process lock (O_EXCL create). The dylib holds its own
  // flock on this path; collisions are rare (single claimant + occasional
  // manual CLI) and fail soft via the timeout below.
  let lockFd: number | null = null;
  const lockDeadline = Date.now() + 2000;
  while (lockFd === null) {
    try {
      lockFd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch {
      if (Date.now() > lockDeadline) {
        throw new ImsgPlusTimeoutError("command channel lock busy");
      }
      await sleep(40);
    }
  }
  try {
    // Clear the response slot, then publish the command.
    writeFileSync(responseFile, "");
    writeFileSync(
      commandFile,
      JSON.stringify({ id, action: "typing", params: { handle, typing: state } }),
    );

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(options.pollIntervalMs ?? 50);
      let responseRaw = "";
      let commandCleared = false;
      try {
        responseRaw = readFileSync(responseFile, "utf8");
        commandCleared = readFileSync(commandFile, "utf8").length <= 2;
      } catch {
        continue;
      }
      if (responseRaw.length <= 2 || !commandCleared) continue;
      let response: { id?: unknown; success?: unknown } = {};
      try {
        response = JSON.parse(responseRaw) as typeof response;
      } catch {
        throw new ImsgPlusTimeoutError("invalid helper response");
      } finally {
        writeFileSync(responseFile, "");
      }
      if (response.id !== id) continue;
      if (response.success !== true) {
        throw new ImsgPlusUnavailableError(
          `helper rejected typing command: ${JSON.stringify(response).slice(0, 160)}`,
        );
      }
      return;
    }
    throw new ImsgPlusTimeoutError("timeout waiting for typing response");
  } finally {
    closeSync(lockFd);
    rmSync(lockFile, { force: true });
  }
}
