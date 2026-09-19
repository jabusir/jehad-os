// imessage-sensor — the gateway Phase A shadow sensor (Lane D).
//
// Runs co-located with Messages.app (today this Mac — the same TEMPORARY
// host as the E4-S edge; see docs/plans/imessage-gateway.md §4.2). It does
// exactly three things: read chat.db READ-ONLY, classify + hash, and speak
// authenticated HTTP to the Jehad OS ingest surface. No model SDK, no
// OpenRouter credentials, no shell capability, no canonical-DB access, no
// send capability (threat-model: "FDA is itself a capability" — the
// process is as boring as its capability set).
//
// Must run under bin/sensor-node (the FDA-holding rpath-fixed node copy —
// docs/spikes/a-prime-chatdb.md); a plain node gets TCC-denied on
// ~/Library/Messages. See infra/imessage/README.md (runbook).
//
// Signals: SIGINT/SIGTERM finish the in-flight cycle, then exit (launchd
// KeepAlive restarts are expected and fine — state transitions are logged).

import { loadConfig } from "./config.js";
import { readKeychainPassword } from "./keychain.js";
import {
  runSensorLoop,
  type SensorCredentials,
} from "./agent.js";

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Credentials resolved per cycle (rotation-friendly): bearer from Keychain
 * `jehad-os`/<principal>, capability token from SENSOR_CAPABILITY_TOKEN or
 * Keychain `jehad-os-grants`/imessage:ingest. Values never appear in logs.
 */
async function resolveCredentials(principal: string): Promise<SensorCredentials> {
  const bearer = await readKeychainPassword({ service: "jehad-os", account: principal });
  if (bearer === null) {
    throw new Error(
      `no Keychain credential under jehad-os/${principal} — mint it (apps/api mint-credential)`,
    );
  }
  const capabilityToken =
    process.env["SENSOR_CAPABILITY_TOKEN"] ??
    (await readKeychainPassword({ service: "jehad-os-grants", account: "imessage:ingest" }));
  if (capabilityToken === null || capabilityToken.length === 0) {
    throw new Error(
      "no capability token — set SENSOR_CAPABILITY_TOKEN or store Keychain jehad-os-grants/imessage:ingest",
    );
  }
  return { bearer, capabilityToken };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv);
  let stopping = false;
  const requestStop = (): void => {
    if (!stopping) log("imessage-sensor: shutdown requested — finishing the in-flight cycle");
    stopping = true;
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  log(
    `imessage-sensor: starting — api ${config.apiUrl}, poll ${config.pollSeconds}s, ` +
      `principal ${config.principal}, db ${config.dbPath}, state ${config.statePath}` +
      `${config.once ? ", --once" : ""}`,
  );
  await runSensorLoop(
    {
      fetchFn: fetch,
      resolveCredentials: () => resolveCredentials(config.principal),
      log,
    },
    config,
    () => stopping,
    sleep,
  );
  log("imessage-sensor: stopped");
}

main().catch((err: unknown) => {
  log(`imessage-sensor: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
