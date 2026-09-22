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

// ---------------------------------------------------------------------------
// Wave T — typing simulation (opt-in; docs/plans/feedback-and-self-verification.md).
//
// Apple exposes NO typing-indicator API: the recipient's "…" bubble appears
// only while text is physically being typed into a Messages compose field.
// This mode UI-scripts that compose: activate Messages, new message to the
// target, type the text in human-paced chunks (Option+Return for newlines so
// the message can never send mid-text), then Return to send.
//
// Still SEND-ONLY: activation + keystrokes — zero reads of any Messages
// state (pinned by test/send-only.test.ts).
//
// Requires the Accessibility permission for the edge-agent process, and
// keystrokes steal focus on this (dedicated) Mac. ANY UI-scripting failure
// falls back immediately to the fixed direct send; 3 consecutive failures
// disable the mode for the process lifetime. Known v1 trade-off: an error
// landing exactly on the final Return could double-send (the fallback fires
// after a possible send) — the final Return is deliberately the last
// statement to make that window as small as the platform allows.
// ---------------------------------------------------------------------------

export interface TypingTransportOptions {
  readonly runner?: OsascriptRunner;
  /** Pause between typed chunks (ms) — human pacing for the bubble. */
  readonly chunkDelayMs?: number;
  readonly maxConsecutiveFailures?: number;
}

/** Typing script for one message. Newlines become Option+Return (soft break
 *  inside the compose field); the final hard Return is the LAST statement. */
export function buildTypingSendScript(
  target: string,
  text: string,
  chunkDelayMs = 120,
): string {
  if (!isValidImessageTarget(target)) {
    throw new Error(
      "imessage typing transport: invalid target — an email address or +E.164 phone is required",
    );
  }
  const delay = (ms: number): string => `delay ${Math.max(ms, 0) / 1000}`;
  const lines = text.replace(/\r\n|\r/g, "\n").split("\n");
  const statements: string[] = [
    'tell application "Messages" to activate',
    delay(500),
    'tell application "System Events"',
    '  keystroke "n" using command down',
    delay(800),
    `  keystroke "${escapeAppleScriptString(target)}"`,
    delay(1000),
    "  keystroke return",
    delay(500),
    "  keystroke tab",
    delay(300),
  ];
  lines.forEach((line, index) => {
    if (line.length > 0) {
      statements.push(`  keystroke "${escapeAppleScriptString(line)}"`);
      statements.push(delay(chunkDelayMs));
    }
    if (index < lines.length - 1) {
      statements.push("  keystroke return using option down");
      statements.push(delay(120));
    }
  });
  statements.push(delay(300));
  statements.push("  keystroke return");
  statements.push("end tell");
  return statements.join("\n");
}

/**
 * The Wave T transport: typing simulation with automatic fallback to the
 * fixed direct send on ANY UI-scripting failure, auto-disabled after
 * `maxConsecutiveFailures` consecutive typing failures (process lifetime).
 */
export function makeTypingAwareTransport(
  options: TypingTransportOptions = {},
): (target: string, text: string) => Promise<void> {
  const runner = options.runner ?? defaultOsascriptRunner;
  const chunkDelayMs = options.chunkDelayMs ?? 120;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  let consecutiveFailures = 0;
  let disabled = false;
  return async (target: string, text: string): Promise<void> => {
    if (!disabled) {
      try {
        await runner("osascript", ["-e", buildTypingSendScript(target, text, chunkDelayMs)]);
        consecutiveFailures = 0;
        return;
      } catch (err) {
        consecutiveFailures += 1;
        console.log(
          JSON.stringify({
            edge: "typing-simulation",
            phase: "fallback",
            consecutiveFailures,
            error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
          }),
        );
        if (consecutiveFailures >= maxConsecutiveFailures) {
          disabled = true;
          console.log(JSON.stringify({ edge: "typing-mode-disabled", reason: "consecutive-failures" }));
        }
      }
    }
    await sendImessage(target, text, runner);
  };
}
