#!/usr/bin/env bash
# Gmail sensor re-consent: thin wrapper over the generalized Google OAuth
# loopback flow (../google-oauth/reauthorize.sh — shared GCP client, scope
# verification, exit 1 if ANY requested scope is missing). Gmail requests
# exactly one read-only scope; refreshing can never escalate it. Tokens land
# in the per-surface items jehad-gmail / jehad-gmail-refresh (account jehad)
# — Calendar's tokens are untouched.

set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)

exec "${DIR}/../google-oauth/reauthorize.sh" \
  "https://www.googleapis.com/auth/gmail.readonly" \
  --access-service jehad-gmail \
  --refresh-service jehad-gmail-refresh \
  "$@"
