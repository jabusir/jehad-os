# infra/gmail — read-only Gmail sensor (Phase GMAIL)

Backend for the `gmail-sync` worker workflow (every 5 min, plan §3). Scope is
`https://www.googleapis.com/auth/gmail.readonly` ONLY — the sensor never
sends, replies, or composes. Same SHARED GCP OAuth client as Calendar
(`jehad-gcalendar-client` id/secret items, plan §2.1); tokens are
per-surface: `jehad-gmail` (access) + `jehad-gmail-refresh` (refresh),
account `jehad` — revoking Gmail never disturbs Calendar. Dev override:
`GMAIL_ACCESS_TOKEN` env.

## Setup
1. `./reauthorize.sh` — browser consent via loopback; stores both Keychain
   items and verifies granted scopes (exit 1 if any are missing).
2. Run `./refresh-token.sh` once, then install it hourly as a LaunchAgent.

## Runbook
- **No token (clean skip):** workflow logs `{"workflow":"gmail-sync",
  "skipped":"no-token"}` and exits 0 — run setup step 1; nothing else to do.
- **Expired token** (tick error `GmailApiError` status 401): the hourly
  refresher fixes it within the hour; force now with `./refresh-token.sh`.
- **Re-consent** (refresh fails — token revoked/rotated out): run
  `./reauthorize.sh` once; Calendar tokens are untouched.
- **Disable the sensor:** policy.yaml `sensors.gmail.enabled: false` — the
  kill switch fails the grant mint and sync halts WITHOUT touching the
  Google credential (plan §9.4).
