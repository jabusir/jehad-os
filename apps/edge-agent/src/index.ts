// imessage-edge — the E4-S TEMPORARY local iMessage edge.
//
// ⚠️ TEMPORARY DEPLOYMENT (hard constraint #4): this Mac (jejo) is a
// stand-in edge host ONLY. The adapter is host-agnostic HTTP + osascript and
// must move to tito UNCHANGED (host swap, zero code change): redeploy this
// app on tito, re-mint the harness credential + send_channel:imessage grant
// there, reinstall the same Keychain entries, done. See
// infra/edge/README.md §Migration.
//
// Pipeline: Jehad OS notification queue (approved only) → claim via the
// harness surface → Messages.app on this Mac (osascript SEND) → iMessage to
// the owner → mark delivered. Jehad OS keeps owning attention/policy/audit/
// delivery-intent; this process is a dumb, send-only tube.
//
// The four hard constraints, encoded structurally (see test/send-only.test.ts):
//   1. SEND-ONLY — no inbound iMessage reading, no Messages database access,
//      ever.
//   2. Dedicated harness principal (`imessage-local`) with ONLY the
//      send_channel:imessage capability grant.
//   3. No generic shell — the ONLY privileged operation is one osascript
//      send command with a fixed shape (imessage-transport.ts).
//   4. TEMPORARY — banner here + docs; the tito move changes no code.

import os from "node:os";
import { loadConfig } from "./config.js";
import { readKeychainPassword } from "./keychain.js";
import { sendImessage } from "./imessage-transport.js";
import { runLoop, type EdgeAgentCredentials } from "./agent.js";

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Credentials resolved per cycle (rotation-friendly): bearer from Keychain
 * `jehad-os`/<principal>, capability token from env override or Keychain
 * `jehad-os-grants`/send_channel:imessage, target from env override or
 * Keychain `jehad-imessage-target`. Values never appear in logs.
 */
async function resolveCredentials(principal: string): Promise<EdgeAgentCredentials> {
  const bearer = await readKeychainPassword({ service: "jehad-os", account: principal });
  if (bearer === null) {
    throw new Error(
      `no Keychain credential under jehad-os/${principal} — mint it (apps/api mint-credential)`,
    );
  }
  const capabilityToken =
    process.env.EDGE_CAPABILITY_TOKEN ??
    (await readKeychainPassword({ service: "jehad-os-grants", account: "send_channel:imessage" }));
  if (capabilityToken === null || capabilityToken.length === 0) {
    throw new Error(
      "no capability token — set EDGE_CAPABILITY_TOKEN or store Keychain jehad-os-grants/send_channel:imessage",
    );
  }
  const target =
    process.env.EDGE_IMESSAGE_TARGET ??
    (await readKeychainPassword({ service: "jehad-imessage-target" }));
  if (target === null || target.length === 0) {
    throw new Error(
      "no iMessage target — set EDGE_IMESSAGE_TARGET or store Keychain jehad-imessage-target",
    );
  }
  return { bearer, capabilityToken, target };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv);
  let stopping = false;
  const requestStop = (): void => {
    if (!stopping) log("edge-agent: shutdown requested — finishing the in-flight cycle");
    stopping = true;
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  log(
    `edge-agent: starting (TEMPORARY host ${os.hostname()}) — api ${config.apiUrl}, ` +
      `poll ${config.pollSeconds}s, principal ${config.principal}${config.once ? ", --once" : ""}`,
  );
  await runLoop(
    {
      fetchFn: fetch,
      transport: (target, text) => sendImessage(target, text),
      resolveCredentials: () => resolveCredentials(config.principal),
      log,
    },
    config,
    () => stopping,
    sleep,
  );
  log("edge-agent: stopped");
}

main().catch((err: unknown) => {
  log(`edge-agent: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
