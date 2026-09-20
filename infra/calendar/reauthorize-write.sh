#!/usr/bin/env bash
# One-time: re-consent the Google OAuth refresh token WITH calendar write
# scope (calendar.events). Thin wrapper over the generic per-surface script.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

exec "$SCRIPT_DIR/../google-oauth/reauthorize.sh" \
  "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events" \
  --access-service jehad-gcalendar \
  --refresh-service jehad-gcalendar-refresh \
  "$@"
