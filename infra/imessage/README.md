# infra/imessage — gateway Phase A shadow sensor (`apps/imessage-sensor`)

The read-only iMessage transport sensor (docs/plans/imessage-gateway.md §7
row A; substrate facts in docs/spikes/a-prime-chatdb.md). It does exactly
three things: read `~/Library/Messages/chat.db` READ-ONLY, classify +
hash, and speak authenticated HTTP to the Jehad OS ingest surface
(`POST /harness/imessage/ingest`, `POST /harness/imessage/health`).

- **Never writes the Messages DB** (URI `mode=ro` + `readOnly: true`; both
  independently refuse writes).
- **Content-forwarding rule (multi-principal privacy invariant)**: message
  content leaves the process ONLY on non-own rows whose handle is a PAIRED
  principal (the paired-handle list the server returns with every
  heartbeat response — §1). Every other non-own row carries
  `pairing_attempt_hash` (sha256 of the canonical text form) instead;
  own (`is_from_me`) rows stay metadata + loop-hash only. The ingest
  service enforces the same rule server-side (stray content → discard +
  audit violation).
- **Fail closed**: a missing, malformed, or absent paired-handle config
  (including the pre-multi-principal server's 204-without-body) empties
  the cache — NO content is forwarded, every non-own row degrades to its
  pairing hash. The server stays authoritative either way.
- **Own principal** (`imessage-sensor`), own narrow capability
  (`imessage:ingest`) — never `imessage-local`'s `send_channel:imessage`.
- No model SDK, no OpenRouter credentials, no shell capability, no
  canonical-DB credentials, no send capability ("FDA is itself a
  capability" — the process is as boring as its capability set).

---

## 1. The five health dims (plan §9 — never one green bit)

```
health_process    sensor is running (the heartbeat itself proves it)
health_database   chat.db opens read-only; expected tables/columns present
                  (PRAGMA table_info fingerprint); WAL/SHM visible
health_decoder    recent decode attempts succeed; ≥ IMESSAGE_SENSOR_DRIFT_THRESHOLD
                  (default 20) CONSECUTIVE decode failures → failed + forwarding STOP
health_cursor     cursor advances when the DB advances; DB reset (max rowid <
                  stored cursor) → failed + alert, never a silent re-baseline;
                  "0 new messages" while the DB advances is degraded, never healthy
health_shadow     own (is_from_me) deliveries observed + classified (hash computed);
                  degraded until the first own-row observation, degraded again
                  while an own row fails to decode (loop correlation blind)
```

Heartbeats (`POST /harness/imessage/health`) fire every ~30s and
IMMEDIATELY on any dim transition. Details ride the audit trail only.

### Heartbeat response = sensor config (paired handles)

The heartbeat RESPONSE now carries the sensor's config
(docs/plans/ig-multiprincipal-contracts.md, "Heartbeat response carries
sensor config"):

```
{ "paired_handles": ["+15550000001", "yusra@icloud.com"] }   // canonical, all principals
```

The sensor caches this list (refreshed on EVERY heartbeat — ~30s staleness
by design; plus one fetch at startup before the first cycle classifies
rows) and applies it when classifying new rows:

| row | wire extras |
| --- | --- |
| own (`is_from_me`) | `normalized_text_sha256` only — never content (unchanged) |
| non-own, handle ∈ paired_handles, decodable | `content` (text column, or decoded attributedBody) |
| non-own, handle ∉ paired_handles, decodable | `pairing_attempt_hash` = sha256(canonicalNormalize(content)) — never `content` |
| non-own, decode failure | neither — `decoded_status` records it (`skipped-malformed`/`skipped-unknown`) |

Handle comparison canonicalizes BOTH sides with one shared normalizer
(`apps/imessage-sensor/src/paired.ts`): emails trim + lowercase; phones
strip all non-digits → `+` + digits. It collapses FORMATTING ONLY — no
country-code padding (a bare 10-digit local form never matches `+1…`)
and no handle ever becomes paired without the server saying so.

**Fail-closed behaviors** (all → empty cache → NO content forwarded,
every non-own row hash-only; each logs once, not per heartbeat):

- 204-without-body (old server): backward compatible, content stays off.
- 200 with a malformed body (bad shape / non-string entries).
- Health POST itself fails (network/5xx): cache is emptied until the
  next successful heartbeat re-primes it.

The sensor never learns pairing codes or session state; the server
enforces the rule regardless (`content` on a row whose handle is not
paired → DISCARD + audit violation).

## 2. bin/sensor-node — the FDA-holding node (prerequisite)

TCC denies plain node access to `~/Library/Messages`. The sensor runs
under `bin/sensor-node`: a copy of the brew node binary, rpath-fixed and
ad-hoc re-signed, holding the one-time Full Disk Access grant (per-path —
the grant follows the binary). `bin/` is gitignored.

Create it (once, and again after EVERY node upgrade):

    mkdir -p bin
    cp "$(command -v node)" bin/sensor-node
    install_name_tool -add_rpath @executable_path/../lib bin/sensor-node 2>/dev/null || true
    codesign --force --sign - bin/sensor-node

Then System Settings → Privacy & Security → Full Disk Access → add
`<repo>/bin/sensor-node` (one time). Verify (read-only probe):

    bin/sensor-node infra/imessage/aprime-probe.mjs   # open: "OK (mode=ro)"

After a node upgrade the copy is stale: re-run the copy + rpath +
codesign steps; the FDA grant persists per-path but RE-VERIFY it after OS
upgrades (part of the Phase A soak checklist).

## 3. Build + smoke test

    pnpm build                       # → apps/imessage-sensor/dist/index.js
    pnpm --filter imessage-sensor exec tsx src/index.ts --once

`--once` runs exactly one poll → ingest → heartbeat cycle and exits
(diagnostics). The long-running loop is the default (SIGINT/SIGTERM
finish the in-flight cycle, then exit).

Runtime: `bin/sensor-node --experimental-sqlite dist/index.js`
(`node:sqlite` is experimental-flagged on Node 22; the flag is explicit
so a future unflagging changes nothing).

## 4. Credentials (owner-run, once + per TTL renewal)

Mint the harness principal credential (identity only, grants nothing):

    pnpm --filter @jehad/api exec tsx src/mint-credential.ts imessage-sensor harness

→ Keychain service `jehad-os`, account `imessage-sensor`.

Issue the single narrow grant (`imessage:ingest`, anchor domain
`personal`, TTL mandatory — same ritual as the E4 edge):

    cd apps/api && pnpm exec tsx -e '
      import { issueGrant } from "@jehad/core";
      import { Pool } from "pg";
      const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad" });
      const domain = (await pool.query("SELECT id FROM domains WHERE key = $1", ["personal"])).rows[0].id;
      const harness = (await pool.query("SELECT id FROM principals WHERE name = $1", ["imessage-sensor"])).rows[0].id;
      const ttlMs = 7 * 24 * 60 * 60 * 1000; // 7 days — re-issue before expiry
      const { grant, token } = await issueGrant(pool, {
        principalId: harness, runId: null,
        capability: "imessage:ingest", resource: "imessage",
        domainId: domain, ttlMs,
      });
      console.log(JSON.stringify({ grantId: grant.id, expiresAt: grant.expiresAt, token }));
      await pool.end();
    '

Store the plaintext token ONCE in the Keychain (only its sha256 is in the db):

    security add-generic-password -U -s jehad-os-grants -a "imessage:ingest" -w "<token>"

Every request carries BOTH headers (identity + possession):

    Authorization: Bearer <jehad-os/imessage-sensor credential>
    x-capability-token: <capability token>

## 5. LaunchAgent

`~/Library/LaunchAgents/os.jehad.sensor.imessage.plist`:

    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key><string>os.jehad.sensor.imessage</string>
        <key>RunAtLoad</key><true/>
        <key>KeepAlive</key><true/>
        <key>ProgramArguments</key>
        <array>
            <string>/Users/jejo/Projects/jehad-os/bin/sensor-node</string>
            <string>--experimental-sqlite</string>
            <string>/Users/jejo/Projects/jehad-os/apps/imessage-sensor/dist/index.js</string>
        </array>
        <key>WorkingDirectory</key><string>/Users/jejo/Projects/jehad-os/apps/imessage-sensor</string>
        <key>StandardErrorPath</key><string>/tmp/os.jehad.sensor.imessage.log</string>
    </dict>
    </plist>

    launchctl load ~/Library/LaunchAgents/os.jehad.sensor.imessage.plist

KeepAlive restarts are expected and fine — the cursor state file makes
restarts lossless (at-least-once + server-side guid dedupe = exactly-once).

## 6. Env vars (full table: apps/imessage-sensor/src/config.ts)

| Var | Default | Notes |
| --- | --- | --- |
| `SENSOR_API_URL` | `http://127.0.0.1:3000` | Jehad OS API base |
| `IMESSAGE_SENSOR_PRINCIPAL` | `imessage-sensor` | Keychain `jehad-os` account |
| `IMESSAGE_SENSOR_POLL_SECONDS` | `5` | 1–5s hard-bounded (plan §7: ≤5s) |
| `IMESSAGE_SENSOR_HEARTBEAT_SECONDS` | `30` | health heartbeat cadence |
| `IMESSAGE_SENSOR_BATCH_CAP` | `500` | server hard cap 1000 |
| `IMESSAGE_SENSOR_DRIFT_THRESHOLD` | `20` | consecutive decode failures → decoder FAILED |
| `IMESSAGE_SENSOR_DB_PATH` | `~/Library/Messages/chat.db` | override (tests/diagnostics) |
| `IMESSAGE_SENSOR_STATE_PATH` | `~/Library/Application Support/jehad-os/imessage-sensor-state.json` | cursor state |
| `IMESSAGE_SENSOR_REBASELINE` | unset | DB-reset acknowledgement (see §7) |
| `SENSOR_CAPABILITY_TOKEN` | unset | token override; else Keychain `jehad-os-grants`/`imessage:ingest` |

## 7. DB reset / replacement — acknowledgement procedure

If chat.db is reset, restored, or replaced (max rowid drops below the
stored cursor) the sensor goes LOUD: `health_cursor=failed` + an alert
health post with the old cursor/new max, forwarding stops, and the
cursor state file is left untouched. There is **no silent re-baseline** —

1. Inspect: why did the DB shrink? (Messages.app re-index, restore-from-
   backup, OS upgrade, accidental state-file swap.)
2. Decide: the gap (rows between new max and old cursor) is NOT
   recoverable from the new DB; re-baselining means accepting that gap.
3. Acknowledge, exactly once:

       launchctl setenv IMESSAGE_SENSOR_REBASELINE explicit-max-rowid   # or set in the plist
       launchctl kickstart -k gui/$(id -u)/os.jehad.sensor.imessage

   The sensor logs `REBASELINE acknowledged (…)` (audited in the health
   details), re-baselines to the current max rowid, and resumes. An
   explicit rowid number is also accepted (`IMESSAGE_SENSOR_REBASELINE=217500`).
4. REMOVE the env afterwards — the acknowledgement is one-shot by
   convention; leaving it set would auto-ack future resets (defeats the
   loudness).

A corrupt/unreadable state file is treated the same way: the sensor
REFUSES to run over it (log: `STATE FILE ERROR`) — never an automatic
baseline. Inspect, fix or deliberately delete the file, restart.

## 8. Recovery / runbook notes

- **Decoder drift** (`health_decoder=failed`): forwarding stops but the
  cursor freezes, so nothing is lost — when blobs decode again the whole
  backlog forwards. Sustained drift means an Apple format change: capture
  a malformed blob (never commit third-party content), extend the Lane A
  decoder fixture matrix.
- **Ingest failures** (API down, 401/403, network): exponential backoff
  (poll ×2ⁿ, capped 60s); the cursor never advances on failure, so rows
  re-send until accepted (server dedupes on guid).
- **Schema drift**: missing expected tables/columns →
  `health_database=failed`, forwarding stops, auditing continues. A
  changed-but-complete fingerprint → `health_database=degraded` with the
  old/new fingerprints in the health details; forwarding continues.
- **host move (tito)**: host-agnostic by construction — redeploy, re-mint
  the credential + `imessage:ingest` grant there, reinstall the Keychain
  entries, recreate `bin/sensor-node` (FDA grant is per-host), install
  the same LaunchAgent. Zero code change (same contract as the E4 edge).

## 9. Phase A soak checklist (exit criteria live in plan §7 row A)

48h minimum active soak: ≥50 outbound deliveries 100% loop-free
classified; reboot; Messages.app restart; sensor restart (cursor
resumes); display sleep; machine sleep/wake; network interruption; WAL
activity; both owner handle forms (phone + Apple ID); schema-decoder
validation; zero loop misclassifications. Watch `imessage_sensor_state`
(five dims + cursor) — anomalies notify the owner over the E4 channel.

Drill log (formal state: A IN SOAK · B/C EARLY DOGFOOD — plan header):

- [x] sensor restart — 2026-09-19: cursor 216996 preserved, no
      re-baseline, health all healthy.
- [x] Messages.app restart — 2026-09-19: delivery through relaunched
      app (row 216997, own-ok, fingerprint correlated).
- [x] control-plane outage (inbound + outbound + recovery) —
      2026-09-19: API stopped 35s; notification queued during outage
      held and delivered on recovery; sensor healthy throughout; edge
      KeepAlive-restarted on claim failure and recovered (note: edge
      rides launchd KeepAlive, not in-process backoff — by design).
- [x] repeated identical messages — 2026-09-19: two identical
      deliveries → 2 fingerprint rows, same hash (67f87e840fed…), both
      own-ok, zero loop misclassifications, zero false inbound.
- [x] WAL activity during reads — continuously exercised (sensor reads
      every 5s while Messages writes; rows 216996-216999 observed
      post-write with no stale-read misses).
- [x] decoder failure / malformed attributedBody — covered by the
      committed fixture matrix + fuzz corpus (54 tests; skip-not-guess);
      live malformed blobs would surface via decoder-health, none seen.
- [x] chat.db schema drift — PRAGMA fingerprint checked every poll;
      drift → loud failure (unit-tested); live re-validation happens
      naturally on the next macOS point update.
- [ ] host reboot — needs owner present (weekend drill).
- [ ] display sleep + full sleep/wake — needs owner present (weekend
      drill; check wake restores polling + caffeinate policy).
- [ ] true network drop (link-level, not control-plane) — needs owner
      (unplug/Wi-Fi off during an inbound and an outbound).
- [ ] both owner handle forms (phone + Apple ID) — needs owner to text
      the gateway from both representations.
- [ ] ≥50 outbound delivery corpus — 6/50 by drills so far; briefs
      + calendar-change traffic accumulate naturally.

Cross-principal contamination watch (owner directive, ongoing): ask
Yusra and Jehad similar questions; verify no stylistic/context/content
leakage between principals — structural isolation is verified
(adversary 12/12); this watches the seams personas/threads open later.
