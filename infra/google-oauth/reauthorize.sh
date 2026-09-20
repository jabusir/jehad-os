#!/usr/bin/env bash
# Generic Google OAuth re-consent for any surface's scopes.
#
# Refreshing can never escalate scopes — the owner must re-consent once to
# grant new scopes. Catches the code via loopback redirect, exchanges it,
# stores refresh + access tokens in Keychain, verifies granted scopes, and
# exits 1 if ANY requested scope is missing.
#
# The OAuth client is SHARED across all surfaces: credentials come from the
# existing `jehad-gcalendar-client` Keychain items (accounts `id`/`secret`).
# Only the stored-token services differ per surface.
#
# Usage:
#   reauthorize.sh "SCOPE SCOPE ..." --access-service jehad-<surface> \
#     [--refresh-service jehad-<surface>-refresh] [--port 8971] [--no-open]
set -euo pipefail

if [ $# -lt 1 ] || [ -z "$1" ] || [ "${1:0:1}" = "-" ]; then
  echo "usage: $0 \"SCOPE SCOPE...\" --access-service SERVICE [--refresh-service SERVICE] [--port N] [--no-open]" >&2
  exit 1
fi
SCOPES=$1
shift

PORT=8971
ACCESS_SERVICE=""
REFRESH_SERVICE=""
OPEN_BROWSER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || { echo "--port needs a value" >&2; exit 1; }
      PORT=$2; shift 2 ;;
    --access-service)
      [ $# -ge 2 ] || { echo "--access-service needs a value" >&2; exit 1; }
      ACCESS_SERVICE=$2; shift 2 ;;
    --refresh-service)
      [ $# -ge 2 ] || { echo "--refresh-service needs a value" >&2; exit 1; }
      REFRESH_SERVICE=$2; shift 2 ;;
    --no-open)
      OPEN_BROWSER=0; shift ;;
    *)
      echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$ACCESS_SERVICE" ]; then
  echo "--access-service is required (e.g. jehad-gmail; refresh defaults to <access>-refresh)" >&2
  exit 1
fi
if [ -z "$REFRESH_SERVICE" ]; then
  REFRESH_SERVICE="${ACCESS_SERVICE}-refresh"
fi

# Shared client (see header): same Keychain items for every surface.
CLIENT_ID=$(security find-generic-password -s jehad-gcalendar-client -a id -w)
CLIENT_SECRET=$(security find-generic-password -s jehad-gcalendar-client -a secret -w)

URL="https://accounts.google.com/o/oauth2/v2/auth?$(python3 - "$CLIENT_ID" "$PORT" "$SCOPES" <<'PY'
import sys, urllib.parse
print(urllib.parse.urlencode({
    "client_id": sys.argv[1],
    "redirect_uri": f"http://localhost:{sys.argv[2]}",
    "response_type": "code",
    "access_type": "offline",
    "prompt": "consent",
    "scope": sys.argv[3],
}))
PY
)"

echo "Opening consent URL - grant access, then this script finishes itself."
echo "$URL"
if [ "$OPEN_BROWSER" = 1 ]; then
  open "$URL" || true
else
  echo "--no-open: not opening a browser; paste the URL manually to consent."
fi

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

security add-generic-password -U -s "$ACCESS_SERVICE" -a jehad -w "$ACCESS"
[ -n "$REFRESH" ] && security add-generic-password -U -s "$REFRESH_SERVICE" -a jehad -w "$REFRESH"

GRANTED=$(curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=${ACCESS}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("scope",""))')
echo "granted scopes: ${GRANTED}"
MISSING=0
for scope in $SCOPES; do
  case " $GRANTED " in
    *" $scope "*) ;;
    *) echo "WARNING: requested scope not granted: ${scope}" >&2; MISSING=1 ;;
  esac
done
if [ "$MISSING" -eq 0 ]; then
  echo "ALL REQUESTED SCOPES OK"
  exit 0
fi
exit 1
