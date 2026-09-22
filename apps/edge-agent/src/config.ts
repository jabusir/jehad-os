// imessage-edge configuration (E4-S — TEMPORARY local edge; see index.ts).
//
// Every knob is an environment variable; NOTHING secret-shaped is ever
// logged (credentials/tokens/target are read at use time and passed through
// headers or the transport only). Contact identifiers live in runtime state
// (macOS Keychain / env), never in this repo — the target is a logical id
// resolved at runtime.
//
// ┌──────────────────────────┬───────────────────────────────────────────────┐
// │ EDGE_API_URL             │ Jehad OS API base. Default http://127.0.0.1:3000 │
// │ EDGE_POLL_SECONDS        │ Claim poll cadence in seconds. Default 60.    │
// │ EDGE_PRINCIPAL           │ Harness principal name — the macOS Keychain   │
// │                          │ account under service `jehad-os` holding the  │
// │                          │ bearer credential. Default `imessage-local`. │
// │ EDGE_CAPABILITY_TOKEN    │ Capability token override. When unset the     │
// │                          │ token is read from Keychain service           │
// │                          │ `jehad-os-grants`, account                    │
// │                          │ `send_channel:imessage`.                      │
// │ EDGE_IMESSAGE_TARGET     │ iMessage target override (email or +E.164     │
// │                          │ phone). When unset, read from Keychain        │
// │                          │ service `jehad-imessage-target`.              │
// │ EDGE_TYPING_SIMULATION   │ "1" = UI-scripted typing bubbles before send  │
// │                          │ (Wave T). Needs Accessibility for the agent;  │
// │                          │ auto-falls-back to direct send on failure.    │
// │                          │ Default off.                                  │
// └──────────────────────────┴───────────────────────────────────────────────┘
//
// CLI: `--once` runs exactly one claim/deliver cycle (testing); the default
// is a long-running loop with SIGINT/SIGTERM graceful shutdown.

export interface EdgeAgentConfig {
  readonly apiUrl: string;
  readonly pollSeconds: number;
  readonly principal: string;
  /** Wave T: UI-scripted typing bubbles (Accessibility + focus-steal on the
   *  dedicated Mac). DEFAULT OFF — enable with EDGE_TYPING_SIMULATION=1. */
  readonly typingSimulation: boolean;
  /** Wave T (preferred): REAL protocol typing bubbles via the imsg-plus
   *  dylib IPC. Requires the one-time host decision (SIP off + injected
   *  Messages relaunch). DEFAULT OFF — enable with EDGE_TYPING_INDICATOR=1. */
  readonly typingIndicator: boolean;
  readonly once: boolean;
}

const DEFAULT_API_URL = "http://127.0.0.1:3000";
const DEFAULT_POLL_SECONDS = 60;
const DEFAULT_PRINCIPAL = "imessage-local";

export const KEYCHAIN_BEARER_SERVICE = "jehad-os";
export const KEYCHAIN_GRANT_SERVICE = "jehad-os-grants";
export const KEYCHAIN_GRANT_ACCOUNT = "send_channel:imessage";
export const KEYCHAIN_TARGET_SERVICE = "jehad-imessage-target";

export function loadConfig(
  env: Record<string, string | undefined>,
  argv: readonly string[],
): EdgeAgentConfig {
  const apiUrl = (env["EDGE_API_URL"] ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const pollRaw = env["EDGE_POLL_SECONDS"] ?? String(DEFAULT_POLL_SECONDS);
  const pollSeconds = Number(pollRaw);
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1) {
    throw new Error(`config: EDGE_POLL_SECONDS must be a number >= 1 (got "${pollRaw}")`);
  }
  const principal = env["EDGE_PRINCIPAL"] ?? DEFAULT_PRINCIPAL;
  if (principal.trim().length === 0) {
    throw new Error("config: EDGE_PRINCIPAL must not be blank");
  }
  return {
    apiUrl,
    pollSeconds,
    principal,
    typingSimulation: env["EDGE_TYPING_SIMULATION"] === "1",
    typingIndicator: env["EDGE_TYPING_INDICATOR"] === "1",
    once: argv.includes("--once"),
  };
}
