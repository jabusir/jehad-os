#!/bin/sh
# infra/dev/tailnet-serve.sh — expose Today over the private tailnet (ADR-0019).
# The API stays loopback-only; this just points `tailscale serve` at it.
# Optional helper — the canonical steps live in docs/deploy/today-tailnet.md.
set -eu
PORT="${PORT:-3000}"
TODAY_BASE_URL="${TODAY_BASE_URL:-https://$(hostname).$(tailscale status --json | /usr/bin/sed -n 's/.*"CurrentTailnet": *"\([^"]*\)".*/\1/p').ts.net}"

echo "Serving tailnet HTTPS 443 -> http://127.0.0.1:${PORT}"
echo "Today URL: ${TODAY_BASE_URL}/ui  (export TODAY_BASE_URL='${TODAY_BASE_URL}' for deep links)"
exec tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}"
