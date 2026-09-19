# infra/edge — OpenClaw attach (E4) + the E4-S iMessage send edge

Jehad OS is the system of record; edges are replaceable peripherals. An edge
NEVER writes canonical state, NEVER triggers actions beyond marking its own
delivery: it authenticates, claims approved notifications, delivers through
its own transport, and reports delivery. Everything else — every other route
in the API — answers it with 403 + audit.

---

> ## ⚠️ TEMPORARY DEPLOYMENT (E4-S hard constraint #4)
>
> The iMessage edge (`apps/edge-agent`, package `imessage-edge`) currently
> runs on THIS Mac (jejo) as a stopgap. **The adapter must move to tito
> UNCHANGED — a host swap only.** It is host-agnostic HTTP + one osascript
> send command; nothing in `apps/edge-agent` knows which Mac it runs on.
> Moving to tito = redeploy + re-mint credentials + reinstall Keychain
> entries + the same LaunchAgent. ZERO code change. Until then, banner
> comments in the code and this section mark the deployment as temporary.

---

## The four hard constraints (restated; each is test-pinned)

1. **SEND-ONLY.** No inbound iMessage reading, no Messages chat.db access,
   ever. Pinned by `apps/edge-agent/test/send-only.test.ts` (grep-pin over
   the app source: zero chat.db/sqlite/read-AppleScript surface).
2. **Dedicated harness principal.** `imessage-local` (type `harness`) holds
   ONLY the `send_channel:imessage` capability — nothing generic. The claim
   and delivered routes accept `send_channel:imessage` OR
   `deliver:notifications`; every other seam denies it (wrong_capability,
   audited).
3. **No generic shell.** The edge's ONLY privileged operation is one
   osascript send command with a fixed shape
   (`tell application "Messages" to send "<escaped>" to buddy "<target>"`),
   AppleScript-escaped on BOTH text and target, target pre-validated
   (email / +E.164 phone). Pinned by the command-shape allowlist test.
4. **TEMPORARY** (see banner above).

## 0. Prerequisite (this Mac only, until the tito move)

Messages.app must be running and signed into an Apple ID that can reach the
owner's iMessage (the send is `to buddy <target>`; if Messages can't resolve
the target to a reachable iMessage address, the send fails and the
notification expires unclaimed-delivered via its TTL — never falsely marked
delivered).

## 1. Mint the edge harness principal (once, owner-run)

    pnpm --filter @jehad/api exec tsx src/mint-credential.ts imessage-local harness

The credential is stored in the macOS Keychain (service `jehad-os`, account
`imessage-local`). It proves IDENTITY only — it grants nothing by itself.

## 2. Issue the send_channel:imessage grant (owner-run, expiring by design)

The edge acts ONLY through this single narrow capability grant (anchor
domain: `personal`). TTL is mandatory — grants are short-lived by
construction; re-issue before expiry (a 7-day TTL means a weekly owner
ritual):

    cd apps/api && pnpm exec tsx -e '
      import { issueGrant } from "@jehad/core";
      import { Pool } from "pg";
      const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad" });
      const domain = (await pool.query("SELECT id FROM domains WHERE key = $1", ["personal"])).rows[0].id;
      const harness = (await pool.query("SELECT id FROM principals WHERE name = $1", ["imessage-local"])).rows[0].id;
      const ttlMs = 7 * 24 * 60 * 60 * 1000; // 7 days — re-mint before expiry
      const { grant, token } = await issueGrant(pool, {
        principalId: harness, runId: null,
        capability: "send_channel:imessage", resource: "notifications",
        domainId: domain, ttlMs,
      });
      console.log(JSON.stringify({ grantId: grant.id, expiresAt: grant.expiresAt, token }));
      await pool.end();
    '

Store the plaintext token ONCE in the Keychain (only its sha256 is in the
db):

    security add-generic-password -U -s jehad-os-grants -a "send_channel:imessage" -w "<token>"

Revocation is the owner's kill switch: `revokeGrant(grantId)` or the
`revokeGrantsByDomain` kill sweep deny the edge instantly; expiry does the
same on its own clock.

## 3. Store the iMessage target (runtime state, never in git)

    security add-generic-password -U -s jehad-imessage-target -w "owner+phone@example.com"

(A contact identifier: an email the owner's iMessage accepts, or a +E.164
phone number. Logical-ID rule: contact identifiers live in runtime state,
never in the repo.)

## 4. The wire protocol (loopback, bearer + capability token)

Every request carries BOTH headers:

    Authorization: Bearer <imessage-local credential>   # identity (mint-credential)
    x-capability-token: <capability token>              # possession (grant)

Poll cadence: 60s (EDGE_POLL_SECONDS). One cycle:

1. `POST /harness/notifications/claim` → `{ notification | null }`, FIFO,
   approved-only. A claim is a LEASE: deliver within the `expiresAt` window
   or the row expires and is never delivered.
2. Render the text (brief → title+content, calendar-change → title,
   escalation → title+consequence, everything ≤1500 chars) and send it via
   the fixed osascript command.
3. On success: `POST /harness/notifications/:id/delivered` — the ONLY state
   change the edge can cause, and only for its own claim.
4. On send FAILURE: log to stderr, do NOT mark delivered — the row expires
   via TTL. Jehad OS never records a false delivery.

Env vars: `EDGE_API_URL` (default http://127.0.0.1:3000),
`EDGE_POLL_SECONDS` (60), `EDGE_PRINCIPAL` (imessage-local),
`EDGE_CAPABILITY_TOKEN` (override; else Keychain `jehad-os-grants` /
`send_channel:imessage`), `EDGE_IMESSAGE_TARGET` (override; else Keychain
`jehad-imessage-target`). Full table: `apps/edge-agent/src/config.ts`.

Run once for a smoke test:

    pnpm --filter imessage-edge exec tsx src/index.ts --once

## 5. LaunchAgent (TEMPORARY host: this Mac)

`~/Library/LaunchAgents/os.jehad.edge.imessage.plist`:

    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <!-- TEMPORARY: this Mac is a stand-in edge host until the tito move. -->
        <key>Label</key><string>os.jehad.edge.imessage</string>
        <key>RunAtLoad</key><true/>
        <key>KeepAlive</key><true/>
        <key>ProgramArguments</key>
        <array>
            <string>pnpm</string>
            <string>--filter</string>
            <string>imessage-edge</string>
            <string>exec</string>
            <string>tsx</string>
            <string>src/index.ts</string>
        </array>
        <key>WorkingDirectory</key><string>/Users/jejo/Projects/jehad-os</string>
        <key>StandardErrorPath</key><string>/tmp/os.jehad.edge.imessage.log</string>
    </dict>
    </plist>

    launchctl load ~/Library/LaunchAgents/os.jehad.edge.imessage.plist

(On the tito host: same plist, adjusted WorkingDirectory; nothing else.)

## 6. Migration to tito (the planned, code-change-free move)

The adapter is host-agnostic HTTP + osascript. Moving to tito means:

1. Deploy the repo (or just `apps/edge-agent`) on tito.
2. Re-mint the credential: `mint-credential imessage-local harness` against
   tito's Jehad OS database; reinstall the Keychain entry there.
3. Re-issue the `send_channel:imessage` grant (the §2 snippet) against
   tito's database; store the new token in tito's Keychain.
4. Reinstall the target entry (`jehad-imessage-target`).
5. Install the same LaunchAgent (§5) pointing at tito's working tree.

ZERO code change — `apps/edge-agent` moves UNCHANGED (hard constraint #4;
pinned by the send-only structural tests, which travel with the code).

## 7. What the queue contains (and why the edge never sees unreviewed content)

Producers (Jehad OS side): briefs enqueue `kind=brief`; near-term
disruptive calendar changes enqueue `kind=calendar-change` (48h filter is
the noise gate; created/updated changes ride the morning brief); both
auto-approve per `policy.yaml` `notifications.autoApproveKinds`. Escalation
raises at/above `notifications.escalationMinUrgency` (≥ high) enqueue
`kind=escalation` as PENDING — the user approves via
`POST /notifications/:id/approve` before the edge can ever claim it. The
queue sits BEHIND review/policy, always.

Payloads are DATA. A payload that says "ignore instructions" or contains
shell commands is delivered verbatim by the edge (if approved) and is never
executed, never re-parsed as policy, anywhere in Jehad OS (probed by tests;
the AppleScript escaping makes the content inert text).

## 8. Non-goals / invariants

- The edge does NOT ingest events, does NOT approve reviews, does NOT
  resolve escalations, does NOT touch /notifications (user-only) — 403.
- The edge cannot mint or escalate grants: verification is server-side
  against `capability_grants`; forged/self-minted/wrong-scope tokens deny.
- No generic shell authority exists anywhere in this surface; the only
  "action" is marking delivery of a row the edge itself claimed — plus the
  one fixed-shape osascript send in the edge's own process.
