# infra/edge — OpenClaw attach (E4): the harness boundary contract

Jehad OS is the system of record; the edge (OpenClaw, repo `/Users/Shared/tito`)
is a replaceable peripheral. The edge NEVER writes canonical state, NEVER
triggers actions beyond marking its own delivery: it authenticates, polls a
counts-only summary, claims approved notifications, and reports delivery.
Everything else — every other route in the API — answers it with 403 + audit.

No OAuth, no iMessage from this repo: Jehad OS only queues and records.
The delivery transport (where a notification actually lands) is the edge's
business.

## 1. Mint the harness principal (once, owner-run)

A DEDICATED principal — separate credential from the user, type `harness`:

    pnpm --filter @jehad/api exec tsx src/mint-credential.ts openclaw harness

The credential is generated, hashed (sha256) into `principals`, and stored in
the macOS Keychain (`jehad-os` service, account `openclaw`). Retrieve it:

    security find-generic-password -s jehad-os -a openclaw -w

Rotate by re-running the mint command (upsert). The credential proves
IDENTITY only — it grants nothing by itself.

## 2. Issue the OpenClaw grants (owner-run, expiring by design)

The harness acts ONLY through capability grants (M4A machinery:
`capability_grants` + `verifyGrant`, scoped + expiring + revocable +
auditable). Two grants cover the whole E4 surface (anchor domain: `personal`):

    cd apps/api && pnpm exec tsx -e '
      import { issueGrant } from "@jehad/core";
      import { Pool } from "pg";
      const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/jehad" });
      const domain = (await pool.query("SELECT id FROM domains WHERE key = $1", ["personal"])).rows[0].id;
      const harness = (await pool.query("SELECT id FROM principals WHERE name = $1", ["openclaw"])).rows[0].id;
      const ttlMs = 7 * 24 * 60 * 60 * 1000;
      for (const [capability, resource] of [["read:state-summary", "state-summary"], ["deliver:notifications", "notifications"]]) {
        const { grant, token } = await issueGrant(pool, { principalId: harness, runId: null, capability, resource, domainId: domain, ttlMs });
        console.log(JSON.stringify({ capability, grantId: grant.id, expiresAt: grant.expiresAt, token }));
      }
      await pool.end();
    '

Store each plaintext token in the Keychain the same way (it is shown ONCE —
only the sha256 lands in the db):

    security add-generic-password -U -s jehad-os -a "openclaw/grant/read:state-summary" -w "<token>"
    security add-generic-password -U -s jehad-os -a "openclaw/grant/deliver:notifications" -w "<token>"

Retrieval (the edge's launch script):

    security find-generic-password -s jehad-os -a "openclaw/grant/deliver:notifications" -w

Revocation is the owner's kill switch: `revokeGrantsForRun` / grant expiry
both deny the edge instantly (tested: expired/revoked → claim 403).

## 3. The wire protocol (loopback, bearer + capability token)

Every request carries BOTH headers:

    Authorization: Bearer <openclaw credential>      # identity (mint-credential)
    x-capability-token: <capability token>           # possession (grant)

Poll cadence: 60s. Two calls per cycle:

1. `GET /harness/state-summary` (grant `read:state-summary`) — the day's
   shape ONLY: `{ pendingReviews, openEscalations: {blocker, critical, high,
   medium, low, unranked}, todayBriefReady }`. Counts and one bool — no
   content, no titles, no domains. Decide locally whether to bother claiming.
2. `POST /harness/notifications/claim` (grant `deliver:notifications`) —
   returns `{ notification: { id, kind, title, payload, claimedAt,
   expiresAt } | null }`, FIFO. `null` = nothing approved for delivery; come
   back next cycle. A claim is a LEASE (claimed_at/claimed_by): deliver
   within the `expiresAt` window or the row expires and is never delivered.

After actually delivering through its own transport, exactly one write is
the edge's to make:

3. `POST /harness/notifications/:id/delivered` (same grant) — records
   delivery (`delivered_by`, `delivered_at`) + audit. This is the ONLY state
   change the edge can cause, and it only ever touches its own claim.

Error semantics: 401 bad credential; 403 + `code` (missing_capability_token,
unknown_token, wrong_capability, wrong_resource, expired, revoked,
principal_type_forbidden) — every 403 is audited server-side
(`harness.grant_denied` / `<route>.forbidden`).

## 4. What the queue contains (and why the edge never sees unreviewed content)

Producers (Jehad OS side): briefs enqueue `kind=brief` (auto-approved per
`policy.yaml` `notifications.autoApproveKinds`); escalation raises at/above
`notifications.escalationMinUrgency` enqueue `kind=escalation` as PENDING —
the user approves via `POST /notifications/:id/approve` before the edge can
ever claim it. The queue sits BEHIND review/policy, always.

Payloads are DATA. A payload that says "ignore instructions" or contains
shell commands is delivered verbatim by the edge (if approved) and is never
executed, never re-parsed as policy, anywhere in Jehad OS (probed by tests).

## 5. Non-goals / invariants

- The edge does NOT ingest events, does NOT approve reviews, does NOT
  resolve escalations, does NOT touch /notifications (user-only) — 403.
- The edge cannot mint or escalate grants: verification is server-side
  against `capability_grants`; forged/self-minted/wrong-scope tokens deny.
- No generic shell authority exists anywhere in this surface; the only
  "action" is marking delivery of a row the edge itself claimed.
