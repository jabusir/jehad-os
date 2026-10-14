# ADR-0022: CSP client enhancement — one hash-pinned inline script for Today

Date: 2026-10-13
Status: Accepted
Waves: UX overhaul Lane D / U3 (speed-of-feel), `docs/plans/today-ux-overhaul.md` §3
Amends: **ADR-0019** §2 — the "no client JS" constraint and the
`Content-Security-Policy: default-src 'none'` header value. Nothing else in
ADR-0019 changes.

## Context

ADR-0019 ratified Today as a server-rendered, no-JS page under a fully
deny-by-default CSP. That posture is correct as a security baseline, but the
dogfooding audit (plan §0) found speed-of-feel gaps that pure server rendering
cannot close: double-tap form spam on slow tailnet round-trips, a stale page
waiting on the user after a background change, and no undo affordance beyond
a full page navigation. The plan's resolution (§3 Lane D) is exactly one
inline vanilla script carrying small enhancements, each of which must degrade
to the existing server behavior — never gate it.

Adding client JS to a `default-src 'none'` surface requires a script-src
mechanism that does not reopen the injection surface 'unsafe-inline' would
create. The mechanism chosen is a **CSP hash pin**: the script's exact bytes
are hashed at module load, and the hash is the only thing 'unsafe-inline'
would have allowed — but scoped to scripts with those exact bytes and nothing
else.

## Decision

Today pages ship exactly one inline script (`TODAY_SCRIPT` in
`apps/api/src/routes/ui-script.ts`) and every Today response carries exactly
this CSP (`TODAY_CSP`, same module):

```
Content-Security-Policy: default-src 'none'; script-src 'sha256-<hash>'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'
```

`<hash>` is `sha256(TODAY_SCRIPT)` base64, computed **at module load** by the
same module that serves the script and exports the header string. Header and
script therefore cannot drift within a build; a stale hand-copied header
elsewhere is caught by the route tests, which pin the full string.

### Directive rationale

- `default-src 'none'` — unchanged fallback: any resource type not explicitly
  listed is denied. Deny-by-default stays the root posture (ADR-0019).
- `script-src 'sha256-<hash>'` — allowlists exactly one script: the pinned
  bytes. **No `unsafe-inline` for scripts, no `unsafe-eval`, no host
  sources.** An injected `<script>` whose bytes differ by one character fails
  the hash and is blocked. External fetches for script are impossible.
- `style-src 'unsafe-inline'` — unchanged from ADR-0019: the server-rendered
  `<style>` block (Lane A tokens) plus the `<style>` element the enhancement
  script injects for its own chrome (loading state, undo toast, char hints).
  No external stylesheets exist or ever load.
- `connect-src 'self'` — required by refresh-on-focus
  (`fetch(location.href)` on `visibilitychange`). Without it the fetch falls
  back to `default-src` (`'none'`) and is **silently blocked** — the
  enhancement would no-op invisibly instead of degrading visibly. 'self'
  admits no new origin: the fetch target is the page's own URL.
- `img-src 'self'` — the favicon / apple-touch-icon `/ui/icon.svg` (new
  public route, see below). No external images ever.
- `form-action 'self'` — unchanged: every POST targets a same-origin form
  endpoint (`/ui/action`, `/ui/delegate`, `/ui/session`, `/ui/reopen`).
- `base-uri 'none'` — unchanged: no `<base>` can redirect relative URLs.

### Threat analysis

- **The script is a static template literal in the API.** No user data ever
  enters it — no interpolation of request, session, or page content. Item
  titles, summaries, and evidence stay where ADR-0019 puts them: escaped in
  the HTML data region by the single escape-at-boundary helper.
- **XSS surface unchanged.** Attacker-controlled text cannot alter the script
  bytes, so it cannot forge the hash. The hash allowlist is closed under
  drift: any mutation of the script (build corruption, careless edit)
  invalidates the hash and the browser blocks the script — fails closed, not
  open.
- **Refresh-on-focus adds no new origin or execution path.** It parses a
  same-origin, session-authenticated GET of the page's own URL with
  `DOMParser` (inert document: no script execution, no resource loads) and
  swaps only the `[data-main]` region's `innerHTML`. `innerHTML` assignment
  does not execute scripts, and the swapped markup is exactly what a manual
  reload would render.
- **Transport and gates unchanged.** Tailnet-Serve-only transport, loopback
  bind, signed session cookie, CSRF on every state-changing POST, and
  principal-scoped queries are all exactly ADR-0019/0020. The script rides
  the session-gated HTML; `publicPaths` gains only `/ui/icon.svg`, a static
  mark with no data.

### Degradation contract (every enhancement degrades to server behavior)

The page is fully functional with the script stripped or blocked (tested:
script-stripped parity on every functional form). Individually:

- **Optimistic action buttons** — interception only sets a loading state
  (`disabled` + `aria-busy` + `data-loading`); it never `preventDefault()`s
  and never `fetch()`es. The POST proceeds normally; the server response and
  the re-rendered page are authoritative. Without JS: normal form POST.
- **Refresh-on-focus** — feature-detected (`fetch`, `DOMParser`,
  `visibilityState`); no `[data-main]` marker → no-op; a focused form field
  inside the region aborts the swap; any fetch error is swallowed. Without
  JS: reload as before.
- **Undo toast** — renders only when the page carries `[data-undo-form]`
  (Lane B). The toast announces via `role=status`/`aria-live` and its Undo
  button submits *that server-rendered form* (`requestSubmit`) — the POST,
  CSRF, and outcome are the server's own. Without JS: Lane B's inline undo
  form posts directly.
- **Delegate extras reveal** — clicking `[data-reveal-extra]` un-hides
  `[data-extra]` rows (Lane C's markers). Absent attributes = no-op; Lane C
  owns the no-JS reveal fallback for the form itself.
- **Character hints** — live `n / maxlength` captions under delegate-form
  fields; cosmetic only.

## Consequences

- CSP-hash drift fails the build, not production: `ui.routes.test.ts` asserts
  (a) every Today response's header equals `TODAY_CSP` verbatim and (b) the
  hash embedded in `TODAY_CSP` equals an independent `sha256(TODAY_SCRIPT)`
  recomputation.
- Editing the script changes the pinned hash automatically (module-load
  recomputation) — no second place to update; the string-equality test is
  what detects stale copies elsewhere.
- App identity lands with the same amendment: `GET /ui/icon.svg` (static SVG,
  `image/svg+xml`, cacheable, public path), `apple-touch-icon` + minimal
  web-app meta emitted by `scriptTags()`. No manifest, no service worker
  (plan §5 non-goals).
- U4 will re-verify zero external requests and a11y on the enhanced page;
  the script's injected chrome respects `prefers-color-scheme` and
  `prefers-reduced-motion`.
