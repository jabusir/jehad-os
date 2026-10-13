# ADR-0020: Tailscale identity as the normal Today login (W1.2)

Date: 2026-10-13
Status: Accepted
Waves: W1.2 (mobile dogfood completion)

## Context

W1 made Today technically correct but not genuinely dogfoodable: two normal-user
flows still required Terminal — minting a one-time credential for Today login,
and running `josctl delegate` to create a mission. The product bar is:

> I can take out my phone anywhere, delegate something, put the phone away,
> and Jehad OS comes back when it genuinely needs me.

Today already sits behind Tailscale Serve (ADR-0019) with the API bound to
127.0.0.1. Tailscale Serve strips client-supplied `Tailscale-User-*` headers
and injects identity headers for authenticated tailnet users. The W1.2
directive chooses an explicit-verb product (TODAY | DELEGATE | MISSIONS) with
natural language only as field CONTENT — no composer, no classifier, no model
calls.

## Decision

1. **Authentication uses ONLY `Tailscale-User-Login`**, matched against an
   exact, owner-controlled allowlist that maps an exact Tailscale login to an
   exact Jehad OS principal NAME:

   ```
   exact Tailscale login allowlist
     → exact Jehad OS user principal (type=user, credential present)
     → existing normal Today session/cookie (unchanged hardening)
     → existing principal-scoped authorization
   ```

   Display name, profile pic, tailnet reachability, arbitrary header presence,
   and tagged-device traffic authorize nothing.

2. **TAILNET ACCESS ≠ JEHAD OS AUTHORIZATION.** Tailscale documents that
   shared external users can also receive identity headers on a shared device;
   only the exact allowlisted login mapped to an exact user principal gets a
   session.

3. **The allowlist config lives OUTSIDE the repo** (it contains personal
   identity): JSON at `$TODAY_AUTH_CONFIG` (default
   `~/.config/jehad/today-auth.json`), shape:

   ```json
   { "tailscale": { "enabled": true,
                    "identities": { "<exact-tailscale-login>": "<principal-name>" } } }
   ```

   Fail-closed on missing file, malformed JSON, disabled flag, unlisted login,
   non-user principal, or a user principal without a credential. Read once per
   process (notifications-config lifecycle — changes take effect on restart).

4. **The credential-paste login becomes break-glass** at `/ui/recovery`
   (POST `/ui/session` preserved for compatibility). It is recovery/admin
   access, not the normal product path. Bearer API auth is unchanged.

5. **Delegation reuses the ONE canonical seam.** `josctl delegate` and
   `POST /ui/delegate` both call `createAndDispatchOutcome`
   (packages/workflow/src/delegate-shared.ts): canonical Outcome creation →
   criteria → policy checks (active cap, budget/deadline defaults) → dispatch
   to the existing outcome-executor via the WorkflowRuntime port. No shell-out,
   no second engine, no web-only path, no bypassed caps. Idempotency is
   bounded to this route: a per-form `submissionId` keys a canonical
   `outcome.delegate_requested` event; a duplicate HTTP retry recovers the
   existing mission and never re-creates or re-dispatches.

6. **Missions is a read-only projection** of existing Outcomes (no new state):
   Needs-you (waiting_user, blocked) / Running (accepted, queued, running,
   waiting_external, verifying) / Recently finished (7 days, ≤20 rows).

## Trust boundary

- The API stays bound to 127.0.0.1; Tailscale Serve remains the only remote
  transport. This localhost binding is REQUIRED for the reverse-proxy identity
  model.
- **Local-host caveat:** a process already executing on the Mac Mini can reach
  localhost directly and forge identity headers. Host compromise is outside
  the remote-client trust boundary — it already compromises Jehad OS state.
- No Tailscale Funnel (never internet-exposed).
- Identity-header auth is refused entirely when `enabled: false`.

## Consequences

- A fresh iPhone browser on the tailnet gets a normal session with no
  Terminal, no paste, and no Mac interaction; iMessage deep links work through
  the same flow.
- Principal mapping cannot cross principals: the mapping targets a principal
  NAME; the session is minted for exactly that principal; every query remains
  principal-scoped.
- Adding/removing a device owner is a one-line config edit + process restart —
  no code change, no migration.
