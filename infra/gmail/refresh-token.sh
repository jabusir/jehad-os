#!/usr/bin/env bash
# Refresh the Gmail sensor access token using the SHARED jehad-os GCP OAuth
# client — credentials come from the `jehad-gcalendar-client` Keychain items
# (same client as Calendar, never duplicated; plan §2.1); only the token
# items are per-surface: jehad-gmail (access) + jehad-gmail-refresh
# (refresh). Safe to run hourly even when the access token is still fresh.
# If Google rotates the refresh token, the new one is re-stored automatically.
#
# Installed as an hourly LaunchAgent — infra/gmail/README.md.

set -euo pipefail

CLIENT_ID=$(security find-generic-password -s jehad-gcalendar-client -a id -w)
CLIENT_SECRET=$(security find-generic-password -s jehad-gcalendar-client -a secret -w)
REFRESH=$(security find-generic-password -s jehad-gmail-refresh -a jehad -w)

RESP=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "refresh_token=${REFRESH}" \
  -d "grant_type=refresh_token")

ACCESS=$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
NEW_REFRESH=$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refresh_token",""))')

if [ -z "$ACCESS" ]; then
  echo "refresh failed:" >&2
  printf '%s\n' "$RESP" | head -c 300 >&2
  exit 1
fi

security add-generic-password -U -s jehad-gmail -a jehad -w "$ACCESS"
[ -n "$NEW_REFRESH" ] && security add-generic-password -U -s jehad-gmail-refresh -a jehad -w "$NEW_REFRESH"

CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${ACCESS}" \
  "https://gmail.googleapis.com/gmail/v1/users/me/profile")
echo "token refreshed and verified (gmail API: ${CODE})"
