// iMessage SEND-ONLY transport (E4-S — TEMPORARY local edge; moves to tito
// UNCHANGED, host swap only).
//
// THE ONLY PRIVILEGED OPERATION IN THIS APP: one osascript invocation with
// the FIXED send shape (see buildSendCommand — send text to buddy target).
//
// AppleScript string-escaping (backslash, then double quote; newlines as
// `\" & linefeed & \"` concatenation) is applied to BOTH text and target, so
// notification content is always INERT TEXT inside a quoted AppleScript
// string — never code, never instructions. The target is additionally
// validated (email or +E.164-ish phone) BEFORE any command runs.
//
// SEND-ONLY: there is no read, no reply, no Messages-database access
// anywhere in this app — pinned by test/send-only.test.ts.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Structural runner port (tests capture argv; the pin test allowlists it). */
export type OsascriptRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export const defaultOsascriptRunner: OsascriptRunner = execFileAsync as OsascriptRunner;

/** Email-shaped target (conservative charset; no shell metacharacters). */
export const EMAIL_TARGET_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** E.164-ish phone target: `+` followed by up to 15 digits. */
export const PHONE_TARGET_RE = /^\+[1-9][0-9]{1,14}$/;

export function isValidImessageTarget(target: string): boolean {
  return EMAIL_TARGET_RE.test(target) || PHONE_TARGET_RE.test(target);
}

/**
 * AppleScript string escaping: backslash first, then double quote; newline
 * (LF/CRLF/CR) becomes `" & linefeed & "` — note UNescaped quotes: they
 * close the AppleScript string, concatenate the `linefeed` constant, and
 * reopen it. (Escaped `\"` here would embed literal quote characters inside
 * the string and ship `" & linefeed & "` as message text — bug found by the
 * A′ spike, 2026-09-18.)
 */
export function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '" & linefeed & "');
}

/** The one and only AppleScript this app can ever run. */
export function buildSendCommand(target: string, text: string): string {
  return `tell application "Messages" to send "${escapeAppleScriptString(text)}" to buddy "${escapeAppleScriptString(target)}"`;
}

/**
 * Sends one iMessage. Throws on an invalid target (nothing is spawned) or a
 * non-zero osascript exit (Messages.app unreachable, buddy not found, …) —
 * the caller logs to stderr and does NOT mark the notification delivered
 * (the row expires via its TTL).
 */
export async function sendImessage(
  target: string,
  text: string,
  runner: OsascriptRunner = defaultOsascriptRunner,
): Promise<void> {
  if (!isValidImessageTarget(target)) {
    throw new Error(
      "imessage transport: invalid target — an email address or +E.164 phone is required",
    );
  }
  await runner("osascript", ["-e", buildSendCommand(target, text)]);
}
