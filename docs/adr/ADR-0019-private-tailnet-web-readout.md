# ADR-0019 — Private tailnet web read-out with direct controls (Today)

- **Status:** ratified by owner (2026-10-11, with the product-reset plan
  `docs/plans/product-reset-watch-attention.md`, owner amendment 2).
- **Complements:** ADR-0009 (local auth: loopback is a network boundary, not
  identity), ADR-0018 (attention semantics). Supersedes the frozen CR1
  "loopback web read-out" scope in `docs/plans/delegate-watch-roadmap.md` §16
  (that decision's authorization surface survives; its reachability does not).

## 1. Decision

The Today surface is a **private app exposed over the owner's tailnet via
Tailscale Serve**, not a localhost-only page and not a public internet app.

1. The Fastify API keeps binding `127.0.0.1` only. `tailscale serve` proxies
   tailnet HTTPS → loopback: TLS, reachability, and device-scoped network
   access are the tailnet's job; the app never binds a public interface,
   acquires public DNS, or manages public certificates.
2. Rationale (product): direct controls must be conveniently reachable or the
   interface edge has failed again — an iMessage saying "Review in Today" is
   useless away from the Mac if Today is localhost-only. The owner reaches it
   from any tailnet-joined device (phone included).
3. Rationale (security): a personal operations system has no business being a
   public app. Tailnet device membership is the network gate; the existing
   principal bearer credential remains the identity gate (ADR-0009's
   separation unchanged).

## 2. Implementation constraints

- Server-rendered HTML from the existing API (no SPA, no build toolchain, no
  frontend dependency). Four views only: Today, Watches (W4), Missions (W4),
  Home (W5). No activity feed, analytics, or chat surface.
- Session: one-time bearer-credential paste → cookie with `Secure` (tailnet
  HTTPS) + `HttpOnly` + `SameSite=Strict`. Every query principal-scoped.
- **CSRF tokens on every state-changing POST** — the surface is
  network-reachable via the tailnet, so the loopback-only relaxation does not
  apply.
- **Output encoding is a hard rule:** every string rendered into HTML that
  derives from external content (gmail `fromDomain`/subject, entity names)
  passes a single escape-at-boundary helper; no raw HTML interpolation;
  `Content-Security-Policy: default-src 'none'`.
- Item actions resolve through the ADR-0018 §1.6 registry; the UI renders
  buttons from registry descriptors, never from row-stored endpoints.

## 3. Consequences

- "Review in Today" deep-links in iMessage attention messages are usable on
  the phone via the Tailscale app.
- If the tailnet is unavailable, iMessage text remains the degraded channel
  and the durable items are untouched (ADR-0018 §1.1).
- Operational setup is one `tailscale serve` command documented in the W1
  deploy notes; no application code depends on Tailscale specifics beyond the
  Secure cookie + CSRF posture (any private HTTPS reverse proxy would satisfy
  this ADR).
