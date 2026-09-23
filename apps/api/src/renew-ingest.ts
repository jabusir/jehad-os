// One-step renewal for the owner-held `imessage:ingest` TTL grant
// (`pnpm renew:ingest`; the grant-expiry-reminder workflow's renewal path).
//
// The full ritual (F5, owner directive 2026-09-22): mint a fresh 7-day
// grant → update the sensor's Keychain item in place (`-U` upsert; the
// token is shown ONCE by issueGrant and never printed here) → revoke the
// superseded live grants for the same capability+resource (they are dead
// weight otherwise: kill-switch surface + the reminder's target drift) →
// restart the sensor LaunchAgent (it reads credentials ONCE at startup).
//
// Secrets: the token transits this process and the local `security` call
// only — never git, logs, stdout, the DB, or event payloads.

import { issueGrant, revokeGrant } from "@jehad/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

const CAPABILITY = "imessage:ingest";
const RESOURCE = "imessage";
const KEYCHAIN_SERVICE = "jehad-os-grants";
const KEYCHAIN_ACCOUNT = "imessage:ingest";
const SENSOR_LAUNCH_LABEL = "os.jehad.sensor.imessage";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad" });

const domain = (await pool.query("SELECT id FROM domains WHERE key = $1", ["personal"])).rows[0]!.id as string;
const harness = (await pool.query("SELECT id FROM principals WHERE name = $1", ["imessage-sensor"])).rows[0]!.id as string;

// 1. Mint the fresh grant.
const { grant, token } = await issueGrant(pool, {
  principalId: harness,
  runId: null,
  capability: CAPABILITY,
  resource: RESOURCE,
  domainId: domain,
  ttlMs: TTL_MS,
});
if (typeof token !== "string" || token.length < 16) {
  // Never write a junk Keychain value — the sensor would boot with it.
  await revokeGrant(pool, grant.id);
  throw new Error("renew:ingest — minted token missing; grant revoked, nothing changed");
}

// 2. Upsert the Keychain item the sensor actually reads (never printed).
await execFileAsync("security", [
  "add-generic-password", "-U",
  "-s", KEYCHAIN_SERVICE,
  "-a", KEYCHAIN_ACCOUNT,
  "-w", token,
]);

// 3. Revoke every OTHER live grant for this capability+resource (the
//    superseded predecessors — including minted-but-never-deployed ones).
const superseded = await pool.query(
  `SELECT id FROM capability_grants
    WHERE capability = $1 AND resource = $2 AND revoked_at IS NULL AND id <> $3`,
  [CAPABILITY, RESOURCE, grant.id],
);
for (const row of superseded.rows as { id: string }[]) {
  await revokeGrant(pool, row.id);
}

// 4. Restart the sensor (credentials are resolved once at startup).
let restarted = false;
try {
  await execFileAsync("launchctl", ["kickstart", "-k", `gui/$(id -u)/${SENSOR_LAUNCH_LABEL}`.replace("$(id -u)", String(process.getuid?.() ?? 501))]);
  restarted = true;
} catch {
  // Non-fatal: the printed command is the fallback.
}

console.log(`renewed ${CAPABILITY} -> expires ${grant.expiresAt.toISOString()}`);
console.log(`keychain updated (${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}); superseded grants revoked: ${superseded.rows.length}`);
console.log(restarted
  ? `sensor restarted (${SENSOR_LAUNCH_LABEL})`
  : `restart the sensor by hand: launchctl kickstart -k gui/$(id -u)/${SENSOR_LAUNCH_LABEL}`);
await pool.end();
