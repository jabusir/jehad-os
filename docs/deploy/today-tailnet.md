# Deploying Today over the private tailnet (ADR-0019)

Today is **not a public app**. The API keeps binding `127.0.0.1` only; Tailscale
Serve proxies tailnet HTTPS → loopback. TLS, DNS (`*.ts.net`), and device-scoped
reachability are the tailnet's job; the app never binds a public interface.
Network gate = tailnet device membership. Identity gate = the existing principal
credential (one-time paste → `Secure+HttpOnly+SameSite=Strict` session cookie +
per-session CSRF). ADR-0009's separation is unchanged.

## 1. Env

| Variable         | Required | Meaning                                                                                   |
| ---------------- | -------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | yes      | `postgres://localhost:5432/jehad` (unchanged)                                             |
| `PORT`           | no       | defaults to `3000` (the serve command below assumes 3000)                                 |
| `TODAY_BASE_URL` | no       | `https://<host>.<tailnet>.ts.net` — when set, attention push messages (iMessage) carry a `Review in Today: <TODAY_BASE_URL>/ui#item-<id>` deep link. Leave unset on machines that should never advertise the URL. |

The app itself never reads `TODAY_BASE_URL` for routing — it only feeds the
notification payload (`AttentionNotificationPayload.todayUrl`).

## 2. One-time setup

```sh
# the API must be running and loopback-only
pnpm dev   # or: pnpm --filter @jehad/api start   (binds 127.0.0.1:3000)

tailscale serve --bg --https=443 http://127.0.0.1:3000
```

Verify from the Mac: `curl -s https://$(hostname).$(tailscale status --json | jq -r .CurrentTailnet).ts.net/healthz`
(or simply open the URL below; a login page proves the proxy works).

## 3. Phone access

1. Install the Tailscale app on the phone and join the same tailnet.
2. Open `https://<host>.<tailnet>.ts.net/ui` (Safari/Chrome — any browser).
3. Paste the principal credential once (`josctl mint-credential` output). The
   cookie lives 24h; a paste is one-time in the sense that it is only ever
   typed, never stored by Today.
4. "Review in Today" deep links from iMessage attention messages
   (`…/ui#item-<id>`) land on the item's card. Links require an unexpired
   session; otherwise the paste form appears first.

## 4. Security notes

- **No public exposure**: `tailscale serve` is tailnet-only; do not run
  `tailscale funnel` (that IS public internet). The app's loopback bind is
  unchanged — localhost-only tools keep working with no bearer.
- Loopback remains a network boundary, not identity (ADR-0009): opening
  `http://127.0.0.1:3000/ui` on the Mac still demands the paste + cookie.
- Every HTML response carries
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'`
  — no scripts, no external assets, forms post to the origin only.
- Every state-changing POST requires the session CSRF token (constant-time
  compare) and every query/action is principal-scoped, fail-closed.
- The session cookie is stateless HMAC material keyed by the principal's
  credential hash: rotating the credential invalidates all sessions; no server
  session store exists in W1.

## 5. Rollback

```sh
tailscale serve reset
```

The app keeps running loopback-only; iMessage text remains the degraded
channel and durable attention items are untouched (ADR-0018 §1.1).
