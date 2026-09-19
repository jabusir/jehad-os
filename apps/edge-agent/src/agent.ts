// The delivery loop core (E4-S — TEMPORARY local edge). One cycle:
//
//   resolve credentials (Keychain/env) → POST /harness/notifications/claim
//   (bearer + capability token) → render text → INJECTED transport (default
//   osascript send) → POST /harness/notifications/:id/delivered.
//
// Failure contract: a send failure logs to stderr and does NOT mark the row
// delivered — the notification expires via its TTL (documented, tested). The
// loop survives every per-cycle error and keeps polling.
//
// Everything impure (fetch, transport, credential resolution, sleep, clock)
// is injected, so the loop tests are fully hermetic.

import type { EdgeAgentConfig } from "./config.js";
import { renderNotificationText, renderedTextSha256, type DeliverableNotification } from "./render.js";

export interface EdgeAgentCredentials {
  readonly bearer: string;
  readonly capabilityToken: string;
  readonly target: string;
}

export interface AgentDeps {
  readonly fetchFn: typeof fetch;
  /** The ONLY privileged operation: send one iMessage (send-only transport). */
  readonly transport: (target: string, text: string) => Promise<void>;
  readonly resolveCredentials: () => Promise<EdgeAgentCredentials>;
  /** stderr logger; must never receive secret-shaped values. */
  readonly log?: (message: string) => void;
}

export interface CycleResult {
  readonly claimed: boolean;
  readonly delivered: boolean;
}

interface ClaimResponse {
  readonly notification: DeliverableNotification | null;
}

function authHeaders(credentials: EdgeAgentCredentials): Record<string, string> {
  return {
    authorization: `Bearer ${credentials.bearer}`,
    "x-capability-token": credentials.capabilityToken,
  };
}

async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: string; error?: string };
    if (typeof body.code === "string") return `${response.status} (${body.code})`;
    if (typeof body.error === "string") return `${response.status} (${body.error})`;
  } catch {
    // not JSON — status alone
  }
  return String(response.status);
}

/** One claim → send → delivered cycle. Never throws. */
export async function runOnce(deps: AgentDeps, config: EdgeAgentConfig): Promise<CycleResult> {
  const log = deps.log ?? (() => {});
  const none: CycleResult = { claimed: false, delivered: false };

  let credentials: EdgeAgentCredentials;
  try {
    credentials = await deps.resolveCredentials();
  } catch (err) {
    log(`edge-agent: credential resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    return none;
  }
  const headers = authHeaders(credentials);

  let claim: Response;
  try {
    claim = await deps.fetchFn(`${config.apiUrl}/harness/notifications/claim`, {
      method: "POST",
      headers,
    });
  } catch (err) {
    log(`edge-agent: claim request failed: ${err instanceof Error ? err.message : String(err)}`);
    return none;
  }
  if (!claim.ok) {
    log(`edge-agent: claim denied: ${await describeFailure(claim)}`);
    return none;
  }

  let notification: DeliverableNotification | null;
  try {
    notification = ((await claim.json()) as ClaimResponse).notification ?? null;
  } catch {
    log("edge-agent: claim returned a malformed body; treating as empty");
    return none;
  }
  if (notification === null) return none;

  const text = renderNotificationText(notification);
  try {
    await deps.transport(credentials.target, text);
  } catch (err) {
    // Documented failure path: NOT delivered → the row expires via its TTL
    // (expires_at); Jehad OS never records a false delivery.
    log(
      `edge-agent: send FAILED for notification ${notification.id}: ${
        err instanceof Error ? err.message : String(err)
      } — not marking delivered; row expires via TTL`,
    );
    return { claimed: true, delivered: false };
  }

  // Loop-defense fingerprint (Phase A): the delivered report carries the
  // canonical sha256 of the EXACT text handed to the transport plus the
  // recipient it was sent to; the API stores a sent_message_fingerprints
  // row for sensor-side loop correlation (imessage-gateway.md §5.2).
  let delivered: Response;
  try {
    delivered = await deps.fetchFn(
      `${config.apiUrl}/harness/notifications/${notification.id}/delivered`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          recipient: credentials.target,
          rendered_text_sha256: renderedTextSha256(text),
        }),
      },
    );
  } catch (err) {
    log(
      `edge-agent: delivered report failed for ${notification.id}: ${
        err instanceof Error ? err.message : String(err)
      } (will not retry this cycle)`,
    );
    return { claimed: true, delivered: false };
  }
  if (!delivered.ok) {
    log(`edge-agent: delivered denied for ${notification.id}: ${await describeFailure(delivered)}`);
    return { claimed: true, delivered: false };
  }
  return { claimed: true, delivered: true };
}

/**
 * The long-running loop: cycle, sleep pollSeconds, repeat. Graceful shutdown
 * is cooperative — `shouldStop` is checked between cycles and every 250ms
 * inside the sleep window, so SIGINT/SIGTERM finish the in-flight cycle (a
 * claimed notification still gets delivered) and then exit.
 */
export async function runLoop(
  deps: AgentDeps,
  config: EdgeAgentConfig,
  shouldStop: () => boolean,
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
): Promise<void> {
  const log = deps.log ?? (() => {});
  while (!shouldStop()) {
    const result = await runOnce(deps, config);
    if (result.delivered) log("edge-agent: delivered one notification");
    if (config.once) return;
    const until = now() + config.pollSeconds * 1000;
    while (!shouldStop() && now() < until) {
      await sleep(Math.min(250, Math.max(0, until - now())));
    }
  }
}
