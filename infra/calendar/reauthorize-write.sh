#!/usr/bin/env bash
# One-time: re-consent the Google OAuth refresh token WITH calendar write
# scope (calendar.events). Refreshing can never escalate scopes — the owner
# must re-consent once. Catches the code via loopback redirect, exchanges
# it, stores refresh + access tokens in Keychain, verifies scopes.
set -euo pipefail

CLIENT_ID=$(security find-generic-password -s jehad-gcalendar-client -a id -w)
CLIENT_SECRET=$(security find-generic-password -s jehad-gcalendar-client -a secret -w)
PORT=8971

URL="https://accounts.google.com/o/oauth2/v2/auth?$(python3 - "$CLIENT_ID" "$PORT" <<'PY'
import sys, urllib.parse
print(urllib.parse.urlencode({
    "client_id": sys.argv[1],
    "redirect_uri": f"http://localhost:{sys.argv[2]}",
    "response_type": "code",
    "access_type": "offline",
    "prompt": "consent",
    "scope": "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
}))
PY
)"

echo "Opening consent URL — grant access, then this script finishes itself."
echo "$URL"
open "$URL" || true

CODE=$(python3 - "$PORT" <<'PY'
import http.server, sys, urllib.parse
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        self.server.code = q.get("code", [None])[0]
        self.send_response(200); self.end_headers()
        self.wfile.write(b"Done - you can close this tab.")
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H)
s.handle_request()
print(s.code or "")
PY
)

if [ -z "$CODE" ]; then echo "no code returned" >&2; exit 1; fi

RESP=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "code=${CODE}" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=http://localhost:${PORT}")

ACCESS=$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
REFRESH=$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refresh_token",""))')
[ -z "$ACCESS" ] && { echo "exchange failed:"; printf '%s' "$RESP" | head -c 400 >&2; exit 1; }

security add-generic-password -U -s jehad-gcalendar -a jehad -w "$ACCESS"
[ -n "$REFRESH" ] && security add-generic-password -U -s jehad-gcalendar-refresh -a jehad -w "$REFRESH"

SCOPES=$(curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=${ACCESS}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("scope",""))')
echo "granted scopes: ${SCOPES}"
case "$SCOPES" in *calendar.events*) echo "WRITE SCOPE OK";; *) echo "WARNING: calendar.events scope missing"; exit 1;; esac
